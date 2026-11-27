import { constants } from "node:fs";
import { appendFile, type FileHandle, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { RewireError, type RunEvent } from "@rewire/core";
import {
  defaultCompactionConfig,
  loadModelsFile,
  type ModelsFile,
  ROLES,
  type RoleRouting,
  type RunOutcome,
  resolveRouting,
  runPipeline,
} from "@rewire/pipeline";
import { loadPolicy } from "@rewire/policy";
import {
  createProvider,
  FauxProvider,
  type ModelRef,
  type OllamaTimeout,
  type Provider,
  type ProviderSettings,
  resolveOllamaTimeout,
} from "@rewire/providers";
import { exitCodeFor } from "./exit.js";
import { type FauxScript, loadFauxScript } from "./faux.js";
import { discoverModels } from "./models.js";
import { headlessLine } from "./render-headless.js";
import { escalationDetail, escalationHint, finalLine, renderEvent } from "./render-interactive.js";
import { oneLine } from "./sanitize.js";

export type RunOptions = {
  task?: string | undefined;
  taskFile?: string | undefined;
  repo?: string | undefined;
  models?: string | undefined;
  headless: boolean;
};

export type RunIo = {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seam: appends the faux note to the report (default {@link markFauxReport}). */
  markReport?: (reportPath: string) => Promise<void>;
};

const TASK_MAX_BYTES = 1024 * 1024;
export const FAUX_WARNING = "warning: faux provider in use (REWIRE_FAUX_SCRIPT)";

/**
 * Regular files only; reads at most TASK_MAX_BYTES + 1 bytes through an fd, never trusting a
 * path stat. Opened non-blocking so a FIFO cannot hang the open (row 108); the fd's own stat
 * then refuses it, and the read loops until EOF or the cap.
 */
async function readCapped(p: string): Promise<string> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await fh.stat()).isFile()) {
      throw new RewireError("task_file_unreadable", `${p} is not a regular file`);
    }
    const buf = Buffer.alloc(TASK_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > TASK_MAX_BYTES) {
        throw new RewireError("task_file_too_large", `${p} is larger than ${TASK_MAX_BYTES} bytes`);
      }
    }
    return buf.subarray(0, total).toString("utf8");
  } catch (e) {
    if (e instanceof RewireError) throw e;
    throw new RewireError("task_file_unreadable", `cannot read ${p}: ${(e as Error).message}`);
  } finally {
    await fh?.close();
  }
}

async function readTask(o: RunOptions, cwd: string): Promise<string> {
  if (o.task !== undefined && o.taskFile !== undefined) {
    throw new RewireError("usage", "give either a task or --task-file, not both");
  }
  if (o.taskFile !== undefined) {
    const p = resolve(cwd, o.taskFile);
    const text = (await readCapped(p)).trim();
    if (text === "") throw new RewireError("usage", `${p} is empty`);
    return text;
  }
  if (o.task === undefined || o.task.trim() === "") {
    throw new RewireError(
      "usage",
      "no task given",
      'rewire run "<task>" or rewire run --task-file <path>',
    );
  }
  return o.task;
}

export async function defaultModelsFile(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const p = join(base, "rewire", "models.toml");
  try {
    await stat(p);
    return p;
  } catch {
    return undefined;
  }
}

/** The models to route over: an explicit file, the default file, the faux script, or discovery. */
export async function resolveModels(
  modelsPath: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  faux: FauxScript | undefined,
): Promise<ModelsFile> {
  // Faux mode is exclusive: no models file, default or explicit, is ever consulted.
  if (faux !== undefined) {
    if (modelsPath !== undefined) {
      throw new RewireError("usage", "--models cannot be combined with REWIRE_FAUX_SCRIPT");
    }
    const names = Object.keys(faux.scripts);
    if (names.length === 0) {
      throw new RewireError("faux_script_invalid", "faux script defines no models");
    }
    return {
      available: names.map((model) => ({ provider: "faux", model }) as ModelRef),
      overrides: {},
      compaction: defaultCompactionConfig(),
    };
  }
  if (modelsPath !== undefined) return loadModelsFile(resolve(cwd, modelsPath));
  const fromFile = await defaultModelsFile(env);
  if (fromFile !== undefined) return loadModelsFile(fromFile);
  return {
    available: await discoverModels(env),
    overrides: {},
    compaction: defaultCompactionConfig(),
  };
}

/** `settings`: models.toml's `[providers.*]` tables, for the cloud providers. */
export function providerFactory(
  env: NodeJS.ProcessEnv,
  faux: FauxScript | undefined,
  settings: ProviderSettings = {},
) {
  const fauxByModel = new Map<string, FauxProvider>();
  return (ref: ModelRef): Provider => {
    if (ref.provider === "faux" && faux !== undefined) {
      let p = fauxByModel.get(ref.model);
      if (!p) {
        p = new FauxProvider(faux.scripts[ref.model] ?? []);
        fauxByModel.set(ref.model, p);
      }
      return p;
    }
    if (faux !== undefined) {
      throw new RewireError(
        "faux_mode_violation",
        `faux mode never uses a real provider (asked for ${ref.provider})`,
      );
    }
    return createProvider(ref, env, settings);
  };
}

/**
 * Creates the provider of every distinct model `routing` assigns (spec, test-writer, implementer,
 * reviewer, verifier; the chat model is spec and its compaction verifier is verifier) and drops
 * them, so a misconfigured one (an Azure reviewer without an API version, a Bedrock verifier
 * without a region) throws `provider_auth_missing` before a run or chat spends anything. Creation
 * only resolves settings and env: no request is sent, and the cloud SDKs (and Vertex's Google
 * credentials) still load on the first chat.
 */
export function createRoutedProviders(
  routing: RoleRouting,
  providers: (ref: ModelRef) => Provider,
): void {
  const seen = new Set<string>();
  for (const role of ROLES) {
    const ref = routing[role];
    const key = `${ref.provider}:${ref.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    providers(ref);
  }
}

/**
 * `{ ollamaTimeout }` for the pipeline when any of `refs` is an Ollama model: the reply timeout
 * from the env and models.toml, so the preflight smoke test uses the same one as the stages.
 * Empty otherwise, or when the variable is invalid (the Ollama provider itself refuses that).
 */
export function ollamaTimeoutOption(
  refs: readonly ModelRef[],
  env: NodeJS.ProcessEnv,
  settings: ProviderSettings = {},
): { ollamaTimeout?: OllamaTimeout } {
  if (!refs.some((r) => r.provider === "ollama")) return {};
  try {
    return { ollamaTimeout: resolveOllamaTimeout(env, settings) };
  } catch {
    return {};
  }
}

async function askInteractive(
  questions: string[],
  io: RunIo,
  signal: AbortSignal,
  onInterrupt: () => void,
): Promise<string[] | null> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  // On a TTY readline owns Ctrl-C: turn it into the run's abort so the report says interrupted.
  rl.on("SIGINT", () => onInterrupt());
  try {
    const answers: string[] = [];
    for (const q of questions) {
      io.stdout.write(`? ${oneLine(q, 500)}\n`);
      const a = await new Promise<string | null>((res) => {
        const onClose = () => res(null);
        rl.once("close", onClose);
        rl.question("> ", { signal }).then(
          (v) => {
            rl.off("close", onClose);
            res(v);
          },
          () => res(null),
        );
      });
      if (a === null) return null;
      answers.push(a);
    }
    return answers;
  } finally {
    rl.close();
  }
}

/** Runs the pipeline; returns the process exit code. Throws RewireError for setup problems. */
export async function runCommand(
  o: RunOptions,
  io: RunIo,
  signal: AbortSignal,
  onInterrupt: () => void = () => {},
): Promise<number> {
  const task = await readTask(o, io.cwd);
  const repo = resolve(io.cwd, o.repo ?? ".");
  const policy = await loadPolicy(repo);

  const fauxPath = io.env.REWIRE_FAUX_SCRIPT;
  const faux = fauxPath ? loadFauxScript(fauxPath) : undefined;
  if (faux) io.stderr.write(`${FAUX_WARNING}\n`);

  const models = await resolveModels(o.models, io.cwd, io.env, faux);
  const routing = resolveRouting(models.available, models.overrides);

  const emit = (e: RunEvent): void => {
    if (o.headless) {
      const line = headlessLine(e);
      if (line === undefined) io.stderr.write("warning: dropped an invalid run event\n");
      else io.stdout.write(line);
      return;
    }
    const line = renderEvent(e);
    if (line !== undefined) io.stdout.write(`${line}\n`);
  };

  const providers = providerFactory(io.env, faux, models.providers);
  createRoutedProviders(routing, providers);

  const outcome: RunOutcome = await runPipeline({
    task,
    repo,
    routing,
    providers,
    ...ollamaTimeoutOption(
      ROLES.map((r) => routing[r]),
      io.env,
      models.providers,
    ),
    policy,
    ask: o.headless ? async () => null : (qs) => askInteractive(qs, io, signal, onInterrupt),
    emit,
    signal,
    ...(faux ? { faux: true } : {}),
  });

  // runPipeline has no provenance flag: the CLI appends the faux note to the report it wrote.
  let markFailure: string | undefined;
  if (faux && outcome.reportPath !== "") {
    try {
      await (io.markReport ?? markFauxReport)(outcome.reportPath);
    } catch (e) {
      markFailure = oneLine(e instanceof Error ? e.message : String(e), 300);
    }
  }

  const summary = [finalLine(outcome), ...escalationDetail(outcome)];
  const hint = escalationHint(outcome);
  if (hint) summary.push(hint);
  // Headless keeps stdout for events only; the human summary goes to stderr.
  (o.headless ? io.stderr : io.stdout).write(`${summary.join("\n")}\n`);
  if (markFailure !== undefined) {
    io.stderr.write(`error: could not mark report as faux-provider run: ${markFailure}\n`);
    return 1; // an unmarked faux report must never look like a normal result
  }
  return exitCodeFor(outcome);
}

export const FAUX_NOTE =
  "\n## Provider note\n\nThis run used the faux provider (REWIRE_FAUX_SCRIPT), not real models. It is a harness self-test, not evidence of model-checked code.\n";

export async function markFauxReport(
  path: string,
  append: (p: string, text: string) => Promise<void> = appendFile,
): Promise<void> {
  await append(path, FAUX_NOTE);
}

/** `<code>: <message>` plus the hint, sanitized: messages can carry model or file text. */
export function formatError(e: unknown): string {
  if (e instanceof RewireError) {
    const base = `${oneLine(e.code, 80)}: ${oneLine(e.message, 500)}`;
    return e.hint ? `${base}\nhint: ${oneLine(e.hint, 500)}` : base;
  }
  return `internal error: ${oneLine(e instanceof Error ? (e.stack ?? e.message) : String(e), 1000)}`;
}
