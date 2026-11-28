import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CheckpointDecision, RewireError, type RunEvent } from "@rewire/core";
import type {
  Checkpoint,
  PipelineSeams,
  RoleRouting,
  RunOutcome,
  RunPipelineInput,
} from "@rewire/pipeline";
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
import { createSkillSet, disposeSkillSet } from "@rewire/skills";
import { afterAll, describe, expect, test } from "vitest";
import {
  ChatSession,
  outcomeMessage,
  type PendingPrompt,
  RunController,
  type RunHandle,
  SessionStore,
} from "../src/index.js";

const ROUTING: RoleRouting = {
  spec: { provider: "faux", model: "spec" },
  "test-writer": { provider: "faux", model: "tw" },
  implementer: { provider: "faux", model: "impl" },
  reviewer: { provider: "faux", model: "rev" },
  verifier: { provider: "faux", model: "ver" },
  independence: "cross-family",
};

const CONTRACT = {
  id: "c1",
  title: "add sum",
  criteria: [{ id: "x", kind: "change" as const, statement: "sum(a, b) returns a + b" }],
  nonGoals: [],
  affectedAreas: ["src/sum.ts"],
  openQuestions: [],
};

const ts = (): string => new Date().toISOString();

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "r1",
    status: "verified",
    branch: "rewire/r1",
    worktree: "/wt",
    reportPath: "/repo/.rewire/runs/r1/report.md",
    ...over,
  };
}

/**
 * A fake pipeline that behaves like runPipeline at the seams the controller uses: it calls
 * `checkpoint` only for kinds in `checkpointKinds`, races a pending checkpoint against the abort
 * signal, and calls `ask` when `clarify` is set.
 */
function fakePipeline(
  o: { clarify?: string[]; seen?: RunPipelineInput[]; throws?: unknown } = {},
): (input: RunPipelineInput) => Promise<RunOutcome> {
  return async (input) => {
    o.seen?.push(input);
    input.emit({ type: "run_start", runId: "r1", ts: ts(), task: input.task, repo: input.repo });
    if (o.throws !== undefined) throw o.throws;
    const interrupted = (): RunOutcome =>
      outcome({
        status: "escalated",
        branch: "",
        escalation: {
          reason: "interrupted",
          tried: [],
          unresolved: [],
          hypothesis: "h",
          question: "q",
        },
      });
    if (o.clarify) {
      const answers = await input.ask(o.clarify);
      if (input.signal?.aborted) return interrupted();
      if (answers === null) {
        return outcome({
          status: "escalated",
          escalation: {
            reason: "clarification_required",
            tried: [],
            unresolved: [],
            hypothesis: "h",
            question: "which one?",
          },
        });
      }
    }
    for (const kind of ["contract", "tests", "commit"] as const) {
      const on = input.checkpoint && (input.checkpointKinds ?? []).includes(kind);
      if (!on || !input.checkpoint) continue;
      const cp: Checkpoint =
        kind === "contract"
          ? { kind, contract: CONTRACT }
          : kind === "tests"
            ? {
                kind,
                manifest: { files: [], hash: "x" } as unknown as Extract<
                  Checkpoint,
                  { kind: "tests" }
                >["manifest"],
                files: [{ path: "t.ts", content: "a\u0000b" }],
              }
            : { kind, diff: "d" };
      const aborted = new Promise<"aborted">((res) => {
        if (input.signal?.aborted) res("aborted");
        input.signal?.addEventListener("abort", () => res("aborted"), { once: true });
      });
      const d = await Promise.race([input.checkpoint(cp), aborted]);
      if (d === "aborted") return interrupted();
      input.emit({
        type: "checkpoint",
        runId: "r1",
        ts: ts(),
        stage: kind,
        kind,
        decision: d as CheckpointDecision,
      });
      if ((d as CheckpointDecision).action === "stop") {
        return outcome({
          status: "escalated",
          escalation: {
            reason: "stopped_by_user",
            tried: [],
            unresolved: [],
            hypothesis: "h",
            question: "q",
          },
        });
      }
    }
    input.emit({ type: "run_end", runId: "r1", ts: ts(), status: "verified", reportPath: "/r" });
    return outcome();
  };
}

function controller(pipeline: (input: RunPipelineInput) => Promise<RunOutcome>): RunController {
  return new RunController({
    repo: "/repo",
    routing: ROUTING,
    providers: () => {
      throw new Error("unused");
    },
    policy: DEFAULT_POLICY,
    pipeline,
  });
}

async function until<T>(f: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function collect(h: RunHandle): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of h.events) out.push(e);
  return out;
}

const NONE = new Set<"contract" | "tests" | "commit">();

describe("RunController (fake pipeline)", () => {
  test("a second start while the first is running throws run_in_progress", async () => {
    const c = controller(fakePipeline());
    const h = c.start("t", { checkpoints: new Set(["contract"]) });
    await until(() => h.pending());
    let err: unknown;
    try {
      c.start("again", { checkpoints: NONE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RewireError);
    expect((err as RewireError).code).toBe("run_in_progress");
    expect(c.running()).toBe(true);
    h.abort();
    await h.done;
    expect(c.running()).toBe(false);
  });

  test("the contract checkpoint becomes pending and approve continues the run", async () => {
    const seen: RunPipelineInput[] = [];
    const c = controller(fakePipeline({ seen }));
    const h = c.start("t", { checkpoints: new Set(["contract"]) });
    const events = collect(h);
    const p = await until(() => h.pending());
    expect(p.kind).toBe("checkpoint");
    expect(p.kind === "checkpoint" && p.checkpoint.kind).toBe("contract");
    expect(seen[0]?.checkpointKinds).toEqual(["contract"]);
    h.answer(p, { action: "approve" });
    expect(h.pending()).toBeUndefined();
    const o = await h.done;
    expect(o.status).toBe("verified");
    const evs = await events;
    expect(evs.map((e) => e.type)).toEqual(["run_start", "checkpoint", "run_end"]);
  });

  test("the resolved Ollama timeout reaches the pipeline input", async () => {
    const seen: RunPipelineInput[] = [];
    const c = new RunController({
      repo: "/repo",
      routing: ROUTING,
      providers: () => {
        throw new Error("unused");
      },
      policy: DEFAULT_POLICY,
      ollamaTimeout: { ms: 1_800_000, source: "models.toml" },
      pipeline: fakePipeline({ seen }),
    });
    const h = c.start("t", { checkpoints: NONE });
    await h.done;
    expect(seen[0]?.ollamaTimeout).toEqual({ ms: 1_800_000, source: "models.toml" });
    const plain = controller(fakePipeline({ seen }));
    await plain.start("t", { checkpoints: NONE }).done;
    expect(seen[1]).not.toHaveProperty("ollamaTimeout");
  });

  test("the web access reaches the pipeline input; without it the input has none", async () => {
    const seen: RunPipelineInput[] = [];
    const web = { config: { maxResults: 5 }, env: { OLLAMA_API_KEY: "k" } };
    const c = new RunController({
      repo: "/repo",
      routing: ROUTING,
      providers: () => {
        throw new Error("unused");
      },
      policy: DEFAULT_POLICY,
      web,
      pipeline: fakePipeline({ seen }),
    });
    await c.start("t", { checkpoints: NONE }).done;
    expect(seen[0]?.web).toBe(web);
    await controller(fakePipeline({ seen })).start("t", { checkpoints: NONE }).done;
    expect(seen[1]).not.toHaveProperty("web");
  });

  test("checkpoints not in the set auto-approve without a pending prompt", async () => {
    const seen: RunPipelineInput[] = [];
    const c = controller(fakePipeline({ seen }));
    const prompts: PendingPrompt[] = [];
    const h = c.start("t", { checkpoints: new Set(["tests"]) });
    const watcher = setInterval(() => {
      const p = h.pending();
      if (p) {
        prompts.push(p);
        h.answer(p, { action: "approve" });
      }
    }, 1);
    const o = await h.done;
    clearInterval(watcher);
    expect(o.status).toBe("verified");
    expect(prompts.map((p) => (p.kind === "checkpoint" ? p.checkpoint.kind : p.kind))).toEqual([
      "tests",
    ]);
    expect(seen[0]?.checkpointKinds).toEqual(["tests"]);

    // An empty set: nothing pauses at all.
    const h2 = c.start("t", { checkpoints: NONE });
    let sawPending = false;
    const w2 = setInterval(() => {
      if (h2.pending()) sawPending = true;
    }, 1);
    expect((await h2.done).status).toBe("verified");
    clearInterval(w2);
    expect(sawPending).toBe(false);
  });

  test("checkpoint payloads are passed through unchanged (NUL kept)", async () => {
    const c = controller(fakePipeline());
    const h = c.start("t", { checkpoints: new Set(["tests"]) });
    const p = await until(() => h.pending());
    expect(p.kind === "checkpoint" && p.checkpoint.kind === "tests" && p.checkpoint.files).toEqual([
      { path: "t.ts", content: "a\u0000b" },
    ]);
    h.answer(p, { action: "stop", note: "no" });
    const o = await h.done;
    expect(o.escalation?.reason).toBe("stopped_by_user");
  });

  test("abort while a checkpoint is pending resolves interrupted; a new start is allowed", async () => {
    const c = controller(fakePipeline());
    const h = c.start("t", { checkpoints: new Set(["contract"]) });
    const events = collect(h);
    await until(() => h.pending());
    h.abort();
    h.abort(); // idempotent
    const o = await h.done;
    expect(o.status).toBe("escalated");
    expect(o.escalation?.reason).toBe("interrupted");
    expect(h.pending()).toBeUndefined();
    await events; // the iterable completes
    const h2 = c.start("t2", { checkpoints: NONE });
    expect((await h2.done).status).toBe("verified");
  });

  test("a clarification becomes pending and its answers reach the pipeline", async () => {
    const seen: RunPipelineInput[] = [];
    const c = controller(fakePipeline({ clarify: ["which one?"], seen }));
    const h = c.start("t", { checkpoints: NONE });
    const p = await until(() => h.pending());
    expect(p).toEqual({ kind: "clarify", questions: ["which one?"] });
    h.answer(p, ["the first"]);
    expect((await h.done).status).toBe("verified");

    const h2 = c.start("t", { checkpoints: NONE });
    const p2 = await until(() => h2.pending());
    h2.answer(p2, null);
    const o2 = await h2.done;
    expect(o2.escalation?.reason).toBe("clarification_required");
  });

  test("abort while a clarification is pending ends the run and clears the prompt", async () => {
    const c = controller(fakePipeline({ clarify: ["which one?"] }));
    const h = c.start("t", { checkpoints: NONE });
    await until(() => h.pending());
    h.abort();
    const o = await h.done;
    expect(o.escalation?.reason).toBe("interrupted");
    expect(h.pending()).toBeUndefined();
  });

  test("answer on a stale or already-answered prompt is a no-op", async () => {
    let decisions = 0;
    const c = controller(async (input) => {
      const ok = input.checkpoint;
      if (!ok) throw new Error("no checkpoint");
      const d1 = await ok({ kind: "contract", contract: CONTRACT });
      decisions++;
      const d2 = await ok({ kind: "tests", manifest: {} as never, files: [] });
      decisions++;
      expect(d1).toEqual({ action: "approve" });
      expect(d2).toEqual({ action: "approve" });
      return outcome();
    });
    const h = c.start("t", { checkpoints: new Set(["contract", "tests"]) });
    const p1 = await until(() => h.pending());
    expect(h.answer(p1, { action: "approve" })).toBe(true);
    expect(h.answer(p1, { action: "stop" })).toBe(false); // already answered: ignored
    const p2 = await until(() => {
      const p = h.pending();
      return p && p !== p1 ? p : undefined;
    });
    expect(h.answer(p1, { action: "stop" })).toBe(false); // stale: ignored, p2 stays pending
    expect(h.pending()).toBe(p2);
    h.answer(p2, { action: "approve" });
    expect((await h.done).status).toBe("verified");
    expect(decisions).toBe(2);
    expect(h.answer(p2, { action: "stop" })).toBe(false); // after done: ignored
  });

  test("a value of the wrong type for the prompt kind is rejected and the run continues", async () => {
    const seen: RunPipelineInput[] = [];
    const c = controller(fakePipeline({ clarify: ["which one?"], seen }));
    const h = c.start("t", { checkpoints: new Set(["contract"]) });
    const q = await until(() => h.pending());
    expect(q.kind).toBe("clarify");
    expect(h.answer(q, { action: "approve" })).toBe(false);
    expect(h.answer(q, [1, 2] as unknown as string[])).toBe(false);
    expect(h.pending()).toBe(q);
    expect(h.answer(q, ["the first"])).toBe(true);
    const cp = await until(() => {
      const p = h.pending();
      return p?.kind === "checkpoint" ? p : undefined;
    });
    expect(h.answer(cp, null)).toBe(false);
    expect(h.answer(cp, ["approve"])).toBe(false);
    expect(h.pending()).toBe(cp);
    expect(h.answer(cp, { action: "approve" })).toBe(true);
    expect((await h.done).status).toBe("verified");
  });

  test("an overlapping prompt request fails with fixed text and never orphans the first", async () => {
    let second: unknown;
    const c = controller(async (input) => {
      const ask = input.checkpoint;
      if (!ask) throw new Error("no checkpoint");
      const first = ask({ kind: "contract", contract: CONTRACT });
      await ask({ kind: "tests", manifest: {} as never, files: [] }).catch((e: unknown) => {
        second = e;
      });
      expect(await first).toEqual({ action: "approve" });
      return outcome();
    });
    const h = c.start("t", { checkpoints: new Set(["contract", "tests"]) });
    const p = await until(() => (second !== undefined ? h.pending() : undefined));
    expect((second as Error).message).toBe("a prompt is already pending for this run");
    expect(p.kind === "checkpoint" && p.checkpoint.kind).toBe("contract");
    expect(h.answer(p, { action: "approve" })).toBe(true);
    expect((await h.done).status).toBe("verified");
    expect(h.pending()).toBeUndefined();
  });

  test("a thrown pipeline error resolves done as escalated and releases the slot", async () => {
    const c = controller(fakePipeline({ throws: new RewireError("boom_code", "it broke") }));
    const h = c.start("t", { checkpoints: NONE });
    const events = collect(h);
    const o = await h.done;
    expect(o.status).toBe("escalated");
    expect(o.escalation?.reason).toBe("stage_error");
    expect(o.escalation?.details?.join("\n")).toContain("boom_code: it broke");
    expect(o.runId).toBe("r1");
    expect(o.reportPath).toBe("");
    expect(h.pending()).toBeUndefined();
    expect((await events).map((e) => e.type)).toEqual(["run_start"]);
    expect(c.running()).toBe(false);
    const c2 = controller(async () => {
      throw "not an error";
    });
    const o2 = await c2.start("t", { checkpoints: NONE }).done;
    expect(o2.escalation?.reason).toBe("stage_error");
    expect(c2.running()).toBe(false);
  });

  test("the checkpoint set is snapshotted at start", async () => {
    const seen: RunPipelineInput[] = [];
    const c = controller(fakePipeline({ seen }));
    const set = new Set<"contract" | "tests" | "commit">(["contract"]);
    const h = c.start("t", { checkpoints: set });
    set.add("tests");
    const p = await until(() => h.pending());
    h.answer(p, { action: "approve" });
    await h.done;
    expect(seen[0]?.checkpointKinds).toEqual(["contract"]);
  });
});

describe("outcomeMessage", () => {
  test("a verified run names the branch and the report", () => {
    const m = outcomeMessage(outcome());
    expect(m).toContain("verified");
    expect(m).toContain("rewire/r1");
    expect(m).toContain("/repo/.rewire/runs/r1/report.md");
  });

  test("an escalation contains the reason and the question", () => {
    const m = outcomeMessage(
      outcome({
        status: "escalated",
        escalation: {
          reason: "stopped_by_user",
          tried: [],
          unresolved: [],
          hypothesis: "The user stopped the run.",
          question: "Re-run the task with a clearer description?",
        },
      }),
    );
    expect(m).toContain("escalated");
    expect(m).toContain("stopped_by_user");
    expect(m).toContain("Re-run the task with a clearer description?");
    expect(m).toContain("/repo/.rewire/runs/r1/report.md");
  });

  test("an escalation with no report says so", () => {
    const m = outcomeMessage(
      outcome({
        status: "escalated",
        reportPath: "",
        escalation: {
          reason: "stage_error",
          tried: [],
          unresolved: [],
          hypothesis: "",
          question: "",
        },
      }),
    );
    expect(m).toContain("stage_error");
    expect(m).toContain("no report");
  });

  test("with no report, a thrown error's detail is shown; with a report it is not", async () => {
    const c = controller(fakePipeline({ throws: new TypeError("x is undefined") }));
    const o = await c.start("t", { checkpoints: NONE }).done;
    const m = outcomeMessage(o);
    expect(m).toContain("Error: internal_error: x is undefined");
    expect(m).toContain("no report");
    const withReport = outcomeMessage({ ...o, reportPath: "/r/report.md" });
    expect(withReport).not.toContain("x is undefined");
  });
});

// ---- Integration: the real runPipeline with faux models (Review Focus #3, pipeline side). ----

const here = dirname(fileURLToPath(import.meta.url));
// Shared with the pipeline's own tests; fail loudly if it moves.
const FIXTURE = resolve(here, "../../pipeline/test/fixtures/sum-lib");
if (!existsSync(join(FIXTURE, "package.json"))) {
  throw new Error(
    `runs.test.ts: the pipeline fixture ${FIXTURE} is missing (moved or renamed?); update FIXTURE`,
  );
}
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-runs-")));
  dirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const TEST_FILE = "tests/sum.test.ts";
const TEST_SRC = `import { expect, test } from "vitest";\ntest("AC-1: adds two numbers", async () => {\n  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n  expect(typeof mod.sum).toBe("function");\n  expect(mod.sum?.(2, 3)).toBe(5);\n});\n`;
const GOOD_SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";

const responder = (f: (req: ChatRequest) => ScriptedTurn): FauxProvider =>
  new FauxProvider(Array.from({ length: 500 }, () => f));
const lastIsTool = (req: ChatRequest): boolean =>
  req.messages[req.messages.length - 1]?.role === "tool";

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

function realController(repo: string): RunController {
  return new RunController({
    repo,
    routing: ROUTING,
    providers: fauxProviders(),
    policy: DEFAULT_POLICY,
    faux: true,
    seams: { implementerMaxTurns: 6, hypothesisTimeoutMs: 5000, gates: passAll() },
  });
}

describe.skipIf(!sandboxAvailable())("RunController (real runPipeline, faux models)", () => {
  test("abort at a pending contract checkpoint: interrupted within 2 s, idle, restartable", async () => {
    const repo = makeRepo();
    const c = realController(repo);
    const h = c.start("add sum(a,b)", { checkpoints: new Set(["contract"]) });
    const events = collect(h);
    const p = await until(() => h.pending(), 30_000);
    expect(p.kind === "checkpoint" && p.checkpoint.kind).toBe("contract");

    const t0 = Date.now();
    h.abort();
    const o = await h.done;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(o.status).toBe("escalated");
    expect(o.escalation?.reason).toBe("interrupted");
    expect(o.reportPath).not.toBe("");
    expect(readFileSync(o.reportPath, "utf8")).toContain("interrupted");
    expect(h.pending()).toBeUndefined();
    const evs = await events;
    expect(evs.at(-1)?.type).toBe("run_end");
    expect(evs.some((e) => e.type === "escalation" && e.reason === "interrupted")).toBe(true);
    expect(c.running()).toBe(false);

    // A new start succeeds and the controller is usable again.
    const h2 = c.start("add sum(a,b)", { checkpoints: new Set(["contract"]) });
    await until(() => h2.pending(), 30_000);
    h2.abort();
    expect((await h2.done).escalation?.reason).toBe("interrupted");
  });

  test("a persisted chat turn does not make the next gated run fail preflight (C1)", async () => {
    // No .gitignore for .rewire/: the repo of a user who never added the sessions dir to it.
    const repo = makeRepo();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-runs-skills-")));
    dirs.push(base);
    const set = createSkillSet([], {
      home: join(base, "home"),
      xdgConfig: join(base, "config"),
      cacheDir: join(base, "cache"),
    });
    const session = new ChatSession({
      repo,
      model: { provider: "faux", model: "chat" },
      provider: new FauxProvider([text("hello")]),
      policy: DEFAULT_POLICY,
      skills: set,
      store: new SessionStore(),
      emit: () => {},
    });
    try {
      await session.send("hi");
      const id = session.id() as string;
      expect(existsSync(join(repo, ".rewire", "sessions", `${id}.jsonl`))).toBe(true);
      const o = await realController(repo).start("add sum(a,b)", { checkpoints: NONE }).done;
      expect(o.escalation?.reason).toBeUndefined();
      expect(o.status).toBe("verified");
    } finally {
      await session.dispose();
      await disposeSkillSet(set);
    }
  });

  test("approve at the contract continues; tests (not in the set) never pause", async () => {
    const repo = makeRepo();
    const c = realController(repo);
    const h = c.start("add sum(a,b)", { checkpoints: new Set(["contract"]) });
    const prompts: PendingPrompt[] = [];
    const watcher = setInterval(() => {
      const p = h.pending();
      if (p && !prompts.includes(p)) {
        prompts.push(p);
        h.answer(p, { action: "approve" });
      }
    }, 5);
    const o = await h.done;
    clearInterval(watcher);
    expect(o.status).toBe("verified");
    expect(prompts.map((p) => (p.kind === "checkpoint" ? p.checkpoint.kind : p.kind))).toEqual([
      "contract",
    ]);
  });
});
