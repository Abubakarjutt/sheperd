import { appendFile, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { RewireError, type RunEvent } from "@rewire/core";
import {
  loadModelsFile,
  type ModelsFile,
  type RunOutcome,
  resolveRouting,
  runPipeline,
} from "@rewire/pipeline";
import { loadPolicy } from "@rewire/policy";
import { createProvider, FauxProvider, type ModelRef, type Provider } from "@rewire/providers";
import { exitCodeFor } from "./exit.js";
import { type FauxScript, loadFauxScript } from "./faux.js";
import { discoverModels } from "./models.js";
import { headlessLine } from "./render-headless.js";
import { escalationDetail, escalationHint, finalLine, renderEvent } from "./render-interactive.js";
import { oneLine, sanitize } from "./sanitize.js";

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
};

const TASK_MAX_BYTES = 1024 * 1024;
export const FAUX_WARNING = "warning: faux provider in use (REWIRE_FAUX_SCRIPT)";

async function readTask(o: RunOptions, cwd: string): Promise<string> {
  if (o.task !== undefined && o.taskFile !== undefined) {
    throw new RewireError("usage", "give either a task or --task-file, not both");
  }
  if (o.taskFile !== undefined) {
    const p = resolve(cwd, o.taskFile);
    let size: number;
    try {
      size = (await stat(p)).size;
    } catch (e) {
      throw new RewireError("task_file_unreadable", `cannot read ${p}: ${(e as Error).message}`);
    }
    if (size > TASK_MAX_BYTES) {
      throw new RewireError("task_file_too_large", `${p} is larger than ${TASK_MAX_BYTES} bytes`);
    }
    const text = (await readFile(p, "utf8")).trim();
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
  if (modelsPath !== undefined) return loadModelsFile(resolve(cwd, modelsPath));
  const fromFile = await defaultModelsFile(env);
  if (fromFile !== undefined) return loadModelsFile(fromFile);
  if (faux !== undefined) {
    const names = Object.keys(faux.scripts);
    if (names.length === 0) {
      throw new RewireError("faux_script_invalid", "faux script defines no models");
    }
    return {
      available: names.map((model) => ({ provider: "faux", model }) as ModelRef),
      overrides: {},
    };
  }
  return { available: await discoverModels(env), overrides: {} };
}

function providerFactory(env: NodeJS.ProcessEnv, faux: FauxScript | undefined) {
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
    return createProvider(ref, env);
  };
}

async function askInteractive(
  questions: string[],
  io: RunIo,
  signal: AbortSignal,
): Promise<string[] | null> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answers: string[] = [];
    for (const q of questions) {
      io.stdout.write(`? ${sanitize(q)}\n`);
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
export async function runCommand(o: RunOptions, io: RunIo, signal: AbortSignal): Promise<number> {
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

  const outcome: RunOutcome = await runPipeline({
    task,
    repo,
    routing,
    providers: providerFactory(io.env, faux),
    policy,
    ask: o.headless ? async () => null : (qs) => askInteractive(qs, io, signal),
    emit,
    signal,
  });

  // runPipeline has no provenance flag: the CLI appends the faux note to the report it wrote.
  if (faux && outcome.reportPath !== "") {
    try {
      await appendFile(
        outcome.reportPath,
        "\n## Provider note\n\nThis run used the faux provider (REWIRE_FAUX_SCRIPT), not real models. It is a harness self-test, not evidence of model-checked code.\n",
      );
    } catch {
      io.stderr.write("warning: could not add the faux-provider note to the report\n");
    }
  }

  const summary = [finalLine(outcome), ...escalationDetail(outcome)];
  const hint = escalationHint(outcome);
  if (hint) summary.push(hint);
  // Headless keeps stdout for events only; the human summary goes to stderr.
  (o.headless ? io.stderr : io.stdout).write(`${summary.join("\n")}\n`);
  return exitCodeFor(outcome);
}

/** `<code>: <message>` plus the hint, sanitized: messages can carry model or file text. */
export function formatError(e: unknown): string {
  if (e instanceof RewireError) {
    const base = `${oneLine(e.code, 80)}: ${oneLine(e.message, 500)}`;
    return e.hint ? `${base}\nhint: ${oneLine(e.hint, 500)}` : base;
  }
  return `internal error: ${oneLine(e instanceof Error ? (e.stack ?? e.message) : String(e), 1000)}`;
}
