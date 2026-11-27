import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import type { CompactionConfig, RoleRouting } from "@rewire/pipeline";
import { loadPolicy, type Policy } from "@rewire/policy";
import {
  type ContextWindowOptions,
  type ModelRef,
  type Provider,
  TokenEstimator,
} from "@rewire/providers";
import { locateSandboxBinary } from "@rewire/sandbox";
import {
  ChatSession,
  compactionDeps,
  PrefillMeter,
  RunController,
  type RunControllerOptions,
  SessionStore,
} from "@rewire/session";
import {
  createSkillSet,
  discoverSkills,
  disposeSkillSet,
  isTrusted,
  loadTrust,
  repoSkillsHash,
  trustKey,
} from "@rewire/skills";
import { renderTrustPrompt, renderTui, routingLines } from "@rewire/tui";
import { runDoctor } from "./doctor.js";
import { loadFauxScript } from "./faux.js";
import { isInteractive, tuiRequiresTty } from "./interactive.js";
import { effectivePlatform } from "./platform.js";
import { RoutingControl } from "./routing-control.js";
import {
  createRoutedProviders,
  FAUX_WARNING,
  ollamaTimeoutOption,
  providerFactory,
  resolveModels,
} from "./run.js";
import { type StartDeps, startInteractive } from "./start-tui.js";
import { xdgDirs } from "./xdg.js";

export type ChatOptions = { repo?: string | undefined; models?: string | undefined };

export type ChatIo = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  onSigint: (handler: () => void) => () => void;
  /** process.exit */
  exit: (code: number) => void;
};

/** Show the cursor and leave raw mode, whatever state Ink left the terminal in. */
export function restoreTerminal(io: Pick<ChatIo, "stdin" | "stdout">): void {
  try {
    if (io.stdin.isTTY && io.stdin.isRaw) io.stdin.setRawMode(false);
  } catch {
    // Already closed: nothing to restore.
  }
  if (io.stdout.isTTY) io.stdout.write("\x1b[?25h");
}

/** How long a new chat session waits for its model's context window before using the default. */
export const WINDOW_LOOKUP_TIMEOUT_MS = 2500;

export type ChatSessionsOptions = {
  repo: string;
  /** A getter is read at each session build (a `/model` pick of `spec` changes the chat model). */
  routing: RoleRouting | (() => RoleRouting);
  providers: (ref: ModelRef) => Provider;
  policy: Policy;
  store: SessionStore;
  /** `[compaction]` of the models file (the defaults without one). */
  compaction: CompactionConfig;
  /** For the chat model's context window (`env` carries OLLAMA_HOST and REWIRE_FAUX_WINDOW). */
  windowOptions: ContextWindowOptions;
  /** The XDG cache dir: a completed `rewire calibrate` of the chat model sets its compaction limit. */
  cacheDir?: string;
  /** Test seam: builds each session's compaction deps (default `compactionDeps`). */
  buildCompaction?: typeof compactionDeps;
};

/**
 * Builds every ChatSession of the TUI (the first, `/clear`, `/resume` and a chat-model pick) on
 * the chat model (`routing.spec`, read at each build), each with compaction on: `compactionDeps` from the routing (the verifier on
 * `routing.verifier`, routing's independence), the `[compaction]` config and the window. One
 * token estimator and one prompt-reading meter are shared by the sessions: they describe the
 * model, not the conversation.
 */
export function chatSessions(o: ChatSessionsOptions): StartDeps["newSession"] {
  const estimator = new TokenEstimator();
  const prefillMeter = new PrefillMeter();
  const build = o.buildCompaction ?? compactionDeps;
  const routingNow = (): RoleRouting => (typeof o.routing === "function" ? o.routing() : o.routing);
  return async ({ skills, emit, sessionId, routing: candidate }) => {
    // A pick's candidate routing (committed only once this session is built), else the current.
    const routing = candidate ?? routingNow();
    const chatModel = routing.spec;
    const compaction = await build({
      routing,
      providers: o.providers,
      config: o.compaction,
      estimator,
      windowOptions: o.windowOptions,
      ...(o.cacheDir !== undefined ? { calibrationCacheDir: o.cacheDir } : {}),
      // Start, `/clear` and `/resume` wait for this: an unresponsive Ollama host must not hold
      // the UI. The session re-reads the window after its first turn.
      windowTimeoutMs: WINDOW_LOOKUP_TIMEOUT_MS,
    });
    const opts = {
      repo: o.repo,
      model: chatModel,
      provider: o.providers(chatModel),
      policy: o.policy,
      skills,
      store: o.store,
      emit,
      prefillMeter,
      compaction,
    };
    return sessionId === undefined
      ? new ChatSession(opts)
      : await ChatSession.resume({ ...opts, sessionId });
  };
}

/**
 * A run controller whose runs each take the routing as of their start (`routing()`): a `/model`
 * pick applies to the next run, never to one in progress. One run at a time, as RunController.
 */
export function routedRunController(
  o: Omit<RunControllerOptions, "routing"> & { routing: () => RoleRouting },
): Pick<RunController, "start"> {
  const { routing, ...rest } = o;
  let last: RunController | undefined;
  return {
    start: (task, opts) => {
      // A run still going: its controller refuses with `run_in_progress`.
      if (last?.running()) return last.start(task, opts);
      last = new RunController({ ...rest, routing: routing() });
      return last.start(task, opts);
    },
  };
}

/**
 * `rewire` on a TTY and `rewire chat`: the same preflight as `rewire run` (policy, models, routing,
 * sandbox binary; any failure throws, so the caller prints it and exits 1 before any UI), then the
 * interactive session. Returns the exit code.
 */
export async function chatCommand(o: ChatOptions, io: ChatIo): Promise<number> {
  if (!isInteractive(io)) throw tuiRequiresTty();
  const repo = resolve(io.cwd, o.repo ?? ".");
  const policy = await loadPolicy(repo);
  const fauxPath = io.env.REWIRE_FAUX_SCRIPT;
  const faux = fauxPath ? loadFauxScript(fauxPath) : undefined;
  const models = await resolveModels(o.models, io.cwd, io.env, faux);
  // `/model` picks change it for this session only (never written to the models file). The
  // providers are created below, after the sandbox check, as before; no pick happens until then.
  const control = new RoutingControl({
    available: models.available,
    fileOverrides: models.overrides,
    providers: (ref) => providers(ref),
  });
  const routing = control.current();
  // Every chat tool call and every run stage needs the sandbox: fail now, not mid-session.
  locateSandboxBinary({ env: io.env });
  if (faux) io.stderr.write(`${FAUX_WARNING}\n`);

  const providers = providerFactory(io.env, faux, models.providers);
  // A misconfigured provider for any role, even one only a later run reaches: fail now.
  createRoutedProviders(routing, providers);
  const { home, xdgConfig, cacheDir } = xdgDirs(io.env);
  const trustFile = join(xdgConfig, "rewire", "trusted-skills.json");
  const store = new SessionStore();
  // The chat model is the author model.
  const chatModel = routing.spec;
  const renderOptions = { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr };

  return await startInteractive({
    repo,
    trustFile,
    discover: () => discoverSkills({ home, xdgConfig, repo }),
    trusted: async (found) =>
      isTrusted(await loadTrust(trustFile), await trustKey(repo), repoSkillsHash(found)),
    promptTrust: (p) =>
      renderTrustPrompt({
        found: p.found,
        pendingRepo: p.pendingRepo,
        repo,
        trustFile,
        onInterrupt: p.onInterrupt,
        bindExit: p.bindExit,
        renderOptions,
      }),
    createSkillSet: (active) => createSkillSet(active, { home, xdgConfig, cacheDir }),
    disposeSkillSet,
    newSession: chatSessions({
      repo,
      routing: () => control.current(),
      providers,
      policy,
      store,
      compaction: models.compaction,
      windowOptions: { env: io.env },
      cacheDir,
    }),
    listSessions: () => store.list(repo),
    newRunController: (skills) =>
      routedRunController({
        repo,
        routing: () => control.current(),
        providers,
        // `/model` picks from the available models, so any of them can reach a run.
        ...ollamaTimeoutOption(
          [...models.available, ...Object.values(models.overrides).filter((r) => r !== undefined)],
          io.env,
          models.providers,
        ),
        policy,
        skills,
        ...(faux ? { faux: true } : {}),
      }),
    render: (deps) => renderTui({ ...deps, renderOptions }),
    onSigint: io.onSigint,
    forceExit: (code) => {
      restoreTerminal(io);
      io.exit(code);
    },
    restoreTerminal: () => restoreTerminal(io),
    doctor: async () => {
      const out: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          out.push(String(chunk));
          cb();
        },
      });
      await runDoctor(o.models, effectivePlatform(io.env), {
        stdout: sink,
        env: io.env,
        cwd: io.cwd,
      });
      return out.join("").trimEnd();
    },
    routing: () => routingLines(control.current()),
    routingControl: control,
    models: {
      chat: chatModel.model,
      spec: routing.spec.model,
      implementer: routing.implementer.model,
      reviewers: [routing.reviewer.model, routing.verifier.model],
    },
    home,
  });
}
