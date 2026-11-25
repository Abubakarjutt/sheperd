import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { resolveRouting } from "@rewire/pipeline";
import { loadPolicy } from "@rewire/policy";
import { locateSandboxBinary } from "@rewire/sandbox";
import { ChatSession, RunController, SessionStore } from "@rewire/session";
import {
  createSkillSet,
  discoverSkills,
  disposeSkillSet,
  isTrusted,
  loadTrust,
  repoSkillsHash,
  trustKey,
} from "@rewire/skills";
import { renderTrustPrompt, renderTui } from "@rewire/tui";
import { runDoctor } from "./doctor.js";
import { loadFauxScript } from "./faux.js";
import { isInteractive, tuiRequiresTty } from "./interactive.js";
import { effectivePlatform } from "./platform.js";
import { FAUX_WARNING, providerFactory, resolveModels } from "./run.js";
import { startInteractive } from "./start-tui.js";
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

function routingText(r: ReturnType<typeof resolveRouting>): string {
  const roles = ["spec", "test-writer", "implementer", "reviewer", "verifier"] as const;
  const lines = roles.map((role) => `${role}: ${r[role].provider}:${r[role].model}`);
  lines.push(`independence: ${r.independence}`);
  return lines.join("\n");
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
  const routing = resolveRouting(models.available, models.overrides);
  // Every chat tool call and every run stage needs the sandbox: fail now, not mid-session.
  locateSandboxBinary({ env: io.env });
  if (faux) io.stderr.write(`${FAUX_WARNING}\n`);

  const providers = providerFactory(io.env, faux);
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
    newSession: async ({ skills, emit, sessionId }) => {
      const opts = {
        repo,
        model: chatModel,
        provider: providers(chatModel),
        policy,
        skills,
        store,
        emit,
      };
      return sessionId === undefined
        ? new ChatSession(opts)
        : await ChatSession.resume({ ...opts, sessionId });
    },
    listSessions: () => store.list(repo),
    newRunController: (skills) =>
      new RunController({
        repo,
        routing,
        providers,
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
    routing: routingText(routing),
  });
}
