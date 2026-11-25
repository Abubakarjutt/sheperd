// End to end: the real App, ChatSession, RunController and runPipeline, with faux models and the
// real sandbox, against a temp git repo built from the pipeline's sum-lib fixture. The user types
// a request, the chat model proposes a run, the user accepts it and approves the contract and the
// tests checkpoints, and the run ends verified on a rewire/<runId> branch.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineSeams, RoleRouting } from "@rewire/pipeline";
import { DEFAULT_POLICY } from "@rewire/policy";
import {
  type ChatRequest,
  call,
  FauxProvider,
  type ModelRef,
  type Provider,
  type ScriptedTurn,
  text,
} from "@rewire/providers";
import { sandboxAvailable } from "@rewire/sandbox";
import { type ChatEvent, ChatSession, RunController, SessionStore } from "@rewire/session";
import { createSkillSet, disposeSkillSet, makeWritable, type SkillSet } from "@rewire/skills";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, test } from "vitest";
import { App } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
// Shared with the pipeline's own tests; fail loudly if it moves.
const FIXTURE = resolve(here, "../../pipeline/test/fixtures/sum-lib");
if (!existsSync(join(FIXTURE, "package.json"))) {
  throw new Error(`e2e.test.tsx: the pipeline fixture ${FIXTURE} is missing; update FIXTURE`);
}
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");

const dirs: string[] = [];
const sets: SkillSet[] = [];
const sessions: ChatSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.dispose().catch(() => {});
  for (const s of sets) await disposeSkillSet(s).catch(() => {});
  for (const d of dirs) await makeWritable(d).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tui-e2e-")));
  dirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  // The chat session writes .rewire/sessions/: ignored, as the README recommends, so the run's
  // clean-tree preflight passes.
  writeFileSync(join(root, ".gitignore"), ".rewire/\nnode_modules\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const TASK = "make sum(a, b) in src/sum.ts return a + b";
const CONTRACT = {
  id: "c1",
  title: "add sum",
  criteria: [{ id: "x", kind: "change" as const, statement: "sum(a, b) returns a + b" }],
  nonGoals: [],
  affectedAreas: ["src/sum.ts"],
  openQuestions: [],
};
const TEST_FILE = "tests/sum.test.ts";
const TEST_SRC = `import { expect, test } from "vitest";\ntest("AC-1: adds two numbers", async () => {\n  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n  expect(typeof mod.sum).toBe("function");\n  expect(mod.sum?.(2, 3)).toBe(5);\n});\n`;
const GOOD_SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";

const responder = (f: (req: ChatRequest) => ScriptedTurn): FauxProvider =>
  new FauxProvider(Array.from({ length: 500 }, () => f));
const lastIsTool = (req: ChatRequest): boolean =>
  req.messages[req.messages.length - 1]?.role === "tool";

// Distinct model names per role, and a separate "chat" model for the ChatSession: each has its
// own FauxProvider, so the chat turn and the spec stage never share one scripted queue.
const ROUTING: RoleRouting = {
  spec: { provider: "faux", model: "spec" },
  "test-writer": { provider: "faux", model: "tw" },
  implementer: { provider: "faux", model: "impl" },
  reviewer: { provider: "faux", model: "rev" },
  verifier: { provider: "faux", model: "ver" },
  independence: "cross-family",
};

function fauxProviders(): (ref: ModelRef) => Provider {
  const byModel: Record<string, Provider> = {
    spec: responder((req) =>
      req.system.includes("Compile the task") ? text(JSON.stringify(CONTRACT)) : text("explored"),
    ),
    tw: responder((req) =>
      lastIsTool(req) ? text("done") : call("write", { path: TEST_FILE, content: TEST_SRC }),
    ),
    impl: responder((req) =>
      lastIsTool(req) ? text("done") : call("write", { path: "src/sum.ts", content: GOOD_SUM }),
    ),
    rev: responder(() => text(JSON.stringify({ findings: [] }))),
    ver: responder(() => text(JSON.stringify({ findings: [] }))),
  };
  return (ref) => {
    const p = byModel[ref.model];
    if (!p) throw new Error(`no provider for ${ref.model}`);
    return p;
  };
}

// The gates are stubbed (as in the session package's real-pipeline tests): this test is about
// the TUI driving the pipeline, not about semgrep or gitleaks being installed.
const passAll = (): NonNullable<PipelineSeams["gates"]> =>
  Object.fromEntries(
    DEFAULT_POLICY.gates.map((n) => [
      n,
      {
        name: n,
        category: "broken" as const,
        run: async () => ({ status: "pass" as const, summary: "stubbed", details: null }),
      },
    ]),
  );

/** An empty skill set: no user or repo skills. */
function emptySkills(): SkillSet {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tui-e2e-skills-")));
  dirs.push(base);
  const set = createSkillSet([], {
    home: join(base, "home"),
    xdgConfig: join(base, "config"),
    cacheDir: join(base, "cache"),
  });
  sets.push(set);
  return set;
}

type View = ReturnType<typeof render>;

/** Polls until some rendered frame satisfies `ok`; fails with the last frame on timeout. */
async function waitFor(v: View, ok: (frame: string) => boolean, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (v.frames.some(ok)) return;
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}; last frame:\n${v.lastFrame() ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** The same, but only the current frame counts (a panel that is showing now). */
async function waitForNow(v: View, needle: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    if ((v.lastFrame() ?? "").includes(needle)) return;
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${needle}; last frame:\n${v.lastFrame() ?? ""}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Presses `key` until `needle` (the panel it answers) leaves the current frame. Ink subscribes
 * `useInput` in an effect, after the frame that shows a new panel is written, so a press sent the
 * moment the panel appears can reach no listener (seen under load). A press that did land removes
 * the panel within one 50 ms prompt poll; a repeat is sent only after 1 s without that.
 */
async function pressUntilGone(v: View, key: string, needle: string, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    v.stdin.write(key);
    const retry = Date.now() + 1000;
    while (Date.now() < retry) {
      await new Promise((r) => setTimeout(r, 25));
      if (!(v.lastFrame() ?? "").includes(needle)) return;
    }
    if (Date.now() > end) {
      throw new Error(
        `${needle} stayed after pressing ${key}; last frame:\n${v.lastFrame() ?? ""}`,
      );
    }
  }
}

describe.skipIf(!sandboxAvailable())("TUI end to end (faux models, real sandbox)", () => {
  test("request, proposal, approve contract and tests, verified on a rewire/ branch", async () => {
    const repo = makeRepo();
    const skills = emptySkills();
    const listeners = new Set<(e: ChatEvent) => void>();
    // The chat model: one turn that proposes the run.
    const chatProvider = new FauxProvider([call("propose_run", { task: TASK })]);
    const session = new ChatSession({
      repo,
      model: { provider: "faux", model: "chat" },
      provider: chatProvider,
      policy: DEFAULT_POLICY,
      skills,
      store: new SessionStore(),
      emit: (e) => {
        for (const l of listeners) l(e);
      },
    });
    sessions.push(session);
    const runController = new RunController({
      repo,
      routing: ROUTING,
      providers: fauxProviders(),
      policy: DEFAULT_POLICY,
      skills,
      faux: true,
      seams: { implementerMaxTurns: 6, hypothesisTimeoutMs: 5000, gates: passAll() },
    });

    const v = render(
      <App
        session={session}
        runController={runController}
        config={{ repo }}
        subscribe={(l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        }}
      />,
    );
    try {
      // 1. The user's request.
      v.stdin.write("the add function is wrong");
      await waitForNow(v, "the add function is wrong");
      v.stdin.write("\r");

      // 2. The chat model proposes a run; 3. accept it.
      await waitForNow(v, "Run this as a gated task? [y/n]");
      expect(v.lastFrame()).toContain(TASK);
      expect(chatProvider.requests[0]?.messages.at(-1)?.content).toContain(
        "the add function is wrong",
      );
      await pressUntilGone(v, "y", "Run this as a gated task?");

      // 4. The contract checkpoint; approve.
      await waitForNow(v, "Contract checkpoint: add sum");
      expect(v.lastFrame()).toContain("AC-1 [change] sum(a, b) returns a + b");
      await pressUntilGone(v, "a", "Contract checkpoint:");

      // 5. The tests checkpoint; approve.
      await waitForNow(v, "Tests checkpoint: 1 frozen test file(s)");
      expect(v.lastFrame()).toContain(TEST_FILE);
      await pressUntilGone(v, "a", "Tests checkpoint:");

      // 6. The board reaches Commit done, and the transcript reports the verified branch.
      await waitFor(v, (f) => /✓ Commit\s+committed/.test(f), "Commit done on the board");
      await waitForNow(v, "verified.");
      const frame = v.lastFrame() ?? "";
      const branch = /Branch: (rewire\/\S+)/.exec(frame)?.[1];
      expect(branch).toBeDefined();
      expect(git(repo, "show", `${branch}:src/sum.ts`)).toBe(GOOD_SUM);
      expect(git(repo, "show", `${branch}:${TEST_FILE}`)).toBe(TEST_SRC);
      // The main worktree is untouched: the run commits to its own branch only.
      expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
    } finally {
      v.unmount();
    }
  }, 180_000);
});
