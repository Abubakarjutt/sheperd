import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CheckpointDecision, RunEvent } from "@rewire/core";
import type { Gate } from "@rewire/gates";
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
import { sandboxAvailable as sandboxIsAvailable } from "@rewire/sandbox";
import { afterAll, describe, expect, test } from "vitest";
import { type Checkpoint, type RoleRouting, type RunOutcome, runPipeline } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sum-lib");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");

const sandboxAvailable = sandboxIsAvailable();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(setup?: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cp-")));
  dirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  setup?.(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const CONTRACT = JSON.stringify({
  id: "c1",
  title: "add sum",
  criteria: [{ id: "x", kind: "change", statement: "sum(a, b) returns a + b" }],
  nonGoals: [],
  affectedAreas: ["src/sum.ts"],
  openQuestions: [],
});
const TEST_FILE = "tests/sum.test.ts";
const TEST_SRC = `import { expect, test } from "vitest";\ntest("AC-1: adds two numbers", async () => {\n  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n  expect(typeof mod.sum).toBe("function");\n  expect(mod.sum?.(2, 3)).toBe(5);\n});\n`;
const GOOD_SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";

const responder = (f: (req: ChatRequest) => ScriptedTurn): FauxProvider =>
  new FauxProvider(Array.from({ length: 500 }, () => f));
const lastIsTool = (req: ChatRequest): boolean =>
  req.messages[req.messages.length - 1]?.role === "tool";

/** Every spec request is recorded; the exploration says "explored", the compile returns CONTRACT. */
const recordingSpec = (seen: ChatRequest[]) =>
  responder((req) => {
    seen.push(req);
    return req.system.includes("Compile the task") ? text(CONTRACT) : text("explored");
  });
const tw = () =>
  responder((req) =>
    lastIsTool(req) ? text("done") : call("write", { path: TEST_FILE, content: TEST_SRC }),
  );
const impl = () =>
  responder((req) =>
    lastIsTool(req)
      ? text("done")
      : {
          toolCalls: [
            { id: "", name: "write", arguments: { path: "src/sum.ts", content: GOOD_SUM } },
          ],
        },
  );
const counting = (p: Provider, hyp?: { n: number }): Provider => ({
  chat(req) {
    if (hyp && req.system.includes("stopped and needs a human")) hyp.n++;
    return p.chat(req);
  },
});
const noFindings = () => responder(() => text(JSON.stringify({ findings: [] })));

const ROUTING: RoleRouting = {
  spec: { provider: "faux", model: "spec" },
  "test-writer": { provider: "faux", model: "tw" },
  implementer: { provider: "faux", model: "impl" },
  reviewer: { provider: "faux", model: "rev" },
  verifier: { provider: "faux", model: "ver" },
  independence: "cross-family",
};

const passAll = (): Record<string, Gate> =>
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

async function run(
  over: {
    checkpoint?: (cp: Checkpoint) => Promise<CheckpointDecision>;
    checkpointKinds?: Array<Checkpoint["kind"]>;
    signal?: AbortSignal;
    specSeen?: ChatRequest[];
    /** Called with each event as it is emitted (before the run continues). */
    onEvent?: (e: RunEvent, repo: string) => void;
    /** Counts implementer-model calls that ask for an escalation hypothesis. */
    hypothesisCalls?: { n: number };
    /** Replaces the default implementer model. */
    implProvider?: Provider;
    /** Runs in the fixture copy before the base commit. */
    setup?: (root: string) => void;
  } = {},
): Promise<{ outcome: RunOutcome; repo: string; events: RunEvent[] }> {
  const repo = makeRepo(over.setup);
  const byModel: Record<string, Provider> = {
    spec: recordingSpec(over.specSeen ?? []),
    tw: tw(),
    impl: counting(over.implProvider ?? impl(), over.hypothesisCalls),
    rev: noFindings(),
    ver: noFindings(),
  };
  const events: RunEvent[] = [];
  const outcome = await runPipeline({
    task: "add sum(a,b)",
    repo,
    routing: ROUTING,
    providers: (ref: ModelRef) => {
      const p = byModel[ref.model];
      if (!p) throw new Error(`no provider for ${ref.model}`);
      return p;
    },
    policy: DEFAULT_POLICY,
    ask: async () => null,
    emit: (e) => {
      events.push(e);
      over.onEvent?.(e, repo);
    },
    ...(over.signal ? { signal: over.signal } : {}),
    ...(over.checkpoint ? { checkpoint: over.checkpoint } : {}),
    ...(over.checkpointKinds ? { checkpointKinds: over.checkpointKinds } : {}),
    seams: { implementerMaxTurns: 6, hypothesisTimeoutMs: 5000, gates: passAll() },
  });
  return { outcome, repo, events };
}

/**
 * Event types of a verified run with no `checkpoint` input, recorded on the pipeline before the
 * checkpoint hook existed (commit ca2bb4d).
 */
const BASELINE_TYPES: string[] = [
  "run_start",
  "stage_start",
  "stage_end",
  "stage_start",
  "tool_call",
  "stage_end",
  "stage_start",
  "tool_call",
  "gate_result",
  "gate_result",
  "gate_result",
  "stage_end",
  "gate_result",
  "gate_result",
  "gate_result",
  "gate_result",
  "gate_result",
  "gate_result",
  "gate_result",
  "stage_start",
  "stage_start",
  "stage_end",
  "stage_end",
  "fix_round",
  "run_end",
];

const worktreeOf = (repo: string): string => {
  const base = join(repo, ".rewire", "worktrees");
  return join(base, readdirSync(base)[0] ?? "");
};

const approve = async (): Promise<CheckpointDecision> => ({ action: "approve" });

describe.skipIf(!sandboxAvailable)(
  "approval checkpoints (real sandbox, stubbed policy gates)",
  { timeout: 240_000 },
  () => {
    test("with no checkpoint input the event sequence is unchanged", async () => {
      const { outcome, events } = await run();
      expect(outcome.status).toBe("verified");
      const types = events.map((e) => e.type);
      if (process.env.PRINT_BASELINE) console.log(JSON.stringify(types));
      expect(types).toEqual(BASELINE_TYPES);
      expect(readFileSync(outcome.reportPath, "utf8")).not.toContain("## Checkpoints");
    });

    test("approve on contract and tests: the run verifies and the report lists 2 approvals", async () => {
      const seen: Checkpoint[] = [];
      const { outcome, events } = await run({
        checkpoint: async (cp) => {
          seen.push(cp);
          return { action: "approve" };
        },
      });
      expect(outcome.escalation).toBeUndefined();
      expect(outcome.status).toBe("verified");
      expect(seen.map((c) => c.kind)).toEqual(["contract", "tests"]);
      const [c, t] = seen;
      if (c?.kind !== "contract" || t?.kind !== "tests") throw new Error("bad checkpoints");
      expect(c.contract.criteria[0]?.id).toBe("AC-1");
      expect(t.manifest.files.map((f) => f.path)).toEqual([TEST_FILE]);
      expect(t.files).toEqual([{ path: TEST_FILE, content: TEST_SRC }]);
      const cps = events.filter((e) => e.type === "checkpoint");
      expect(cps).toMatchObject([
        { kind: "contract", decision: { action: "approve" } },
        { kind: "tests", decision: { action: "approve" } },
      ]);
      // The tests checkpoint comes before the freeze commit, i.e. before the implementer.
      const types = events.map((e) => e.type);
      const implStart = events.findIndex(
        (e) => e.type === "stage_start" && e.stage === "implementer",
      );
      expect(types.lastIndexOf("checkpoint")).toBeLessThan(implStart);
      const logged = readFileSync(join(dirname(outcome.reportPath), "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => RunEvent.parse(JSON.parse(l)));
      expect(logged.filter((e) => e.type === "checkpoint")).toHaveLength(2);
      const report = readFileSync(outcome.reportPath, "utf8");
      const section = report.split("## Checkpoints")[1]?.split("\n## ")[0] ?? "";
      expect(section.match(/approve/g)).toHaveLength(2);
    });

    test("revise re-runs spec with the note fenced as user text", async () => {
      const specSeen: ChatRequest[] = [];
      let n = 0;
      const { outcome } = await run({
        specSeen,
        checkpoint: async (cp) =>
          cp.kind === "contract" && n++ === 0
            ? { action: "revise", note: "AC-2 is a change" }
            : { action: "approve" },
      });
      expect(outcome.status).toBe("verified");
      const prompts = specSeen.map((r) => r.messages[0]?.content ?? "");
      const firstRun = prompts.filter((p) => !p.includes("AC-2 is a change"));
      const withNote = prompts.filter((p) => p.includes("AC-2 is a change"));
      expect(firstRun.length).toBeGreaterThan(0);
      expect(withNote.length).toBeGreaterThan(0);
      for (const p of withNote) {
        expect(p).toMatch(
          /## Reviewer note \(from the user\)\n<untrusted_user_note id="[0-9a-f-]+">\nAC-2 is a change\n<\/untrusted_user_note id="[0-9a-f-]+">/,
        );
      }
      // The compile prompt explains the note fence only on a revised run.
      const compiles = specSeen.filter((r) => r.system.includes("Compile the task"));
      expect(compiles.map((r) => r.system.includes("<untrusted_user_note> fence"))).toEqual([
        false,
        true,
      ]);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/## Checkpoints[\s\S]*revise[\s\S]*AC\\?-2 is a change/);
    });

    test("a fourth revision stops the run with stopped_by_user", async () => {
      let calls = 0;
      const specSeen: ChatRequest[] = [];
      const { outcome, events } = await run({
        specSeen,
        checkpoint: async () => {
          calls++;
          return { action: "revise", note: `try again ${calls}` };
        },
      });
      expect(calls).toBe(4);
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stopped_by_user");
      // 1 original spec run plus 3 revisions.
      expect(events.filter((e) => e.type === "stage_start" && e.stage === "spec")).toHaveLength(4);
      expect(events.filter((e) => e.type === "checkpoint")).toHaveLength(4);
      expect(events.some((e) => e.type === "stage_start" && e.stage === "test-writer")).toBe(false);
      // The fourth revise is treated as stop, and recorded as what happened.
      expect(events.filter((e) => e.type === "checkpoint").map((e) => e.decision)).toEqual([
        { action: "revise", note: "try again 1" },
        { action: "revise", note: "try again 2" },
        { action: "revise", note: "try again 3" },
        { action: "stop", note: "try again 4" },
      ]);
      const section =
        readFileSync(outcome.reportPath, "utf8").split("## Checkpoints")[1]?.split("\n## ")[0] ??
        "";
      expect(section.match(/contract: revise/g)).toHaveLength(3);
      expect(section).toMatch(/contract: stop \(note: try again 4\)/);
    });

    test("stop at contract escalates stopped_by_user before the test-writer", async () => {
      const hyp = { n: 0 };
      const { outcome, events } = await run({
        hypothesisCalls: hyp,
        checkpoint: async () => ({ action: "stop", note: "not what I meant" }),
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stopped_by_user");
      expect(outcome.escalation?.details).toEqual(["not what I meant"]);
      expect(events.some((e) => e.type === "stage_start" && e.stage === "test-writer")).toBe(false);
      expect(hyp.n).toBe(0);
      expect(readFileSync(outcome.reportPath, "utf8")).toMatch(
        /## Checkpoints\n\n- contract: stop \(note: not what I meant\)/,
      );
    });

    test("stop at commit escalates stopped_by_user with no final commit", async () => {
      const { outcome } = await run({
        checkpointKinds: ["commit"],
        checkpoint: async () => ({ action: "stop" }),
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stopped_by_user");
      expect(outcome.escalation?.details).toBeUndefined();
      expect(git(outcome.worktree, "log", "--format=%s", "-1")).toBe(
        "rewire: frozen acceptance tests\n",
      );
    });

    const invalid: Array<[string, (cp: Checkpoint) => Promise<CheckpointDecision>, string]> = [
      [
        "a malformed decision",
        async () => ({ action: "maybe" }) as unknown as CheckpointDecision,
        "contract checkpoint returned an invalid decision",
      ],
      [
        "an empty revise note",
        async () => ({ action: "revise", note: "" }),
        "contract checkpoint returned an invalid decision",
      ],
      [
        "revise at the tests checkpoint",
        async (cp) =>
          cp.kind === "tests" ? { action: "revise", note: "redo" } : { action: "approve" },
        "tests checkpoint does not accept revise",
      ],
      [
        "a rejecting callback",
        async () => {
          throw new Error("ui crashed");
        },
        "contract checkpoint failed: ui crashed",
      ],
    ];
    test.each(invalid)(
      "%s escalates stage_error with fixed text and no model call",
      async (_n, checkpoint, detail) => {
        const hyp = { n: 0 };
        const { outcome, events } = await run({ checkpoint, hypothesisCalls: hyp });
        expect(outcome.status).toBe("escalated");
        expect(outcome.escalation?.reason).toBe("stage_error");
        expect(outcome.escalation?.details?.join("\n")).toContain(detail);
        expect(outcome.escalation?.hypothesis).toContain("checkpoint");
        expect(hyp.n).toBe(0);
        expect(events.some((e) => e.type === "stage_start" && e.stage === "implementer")).toBe(
          false,
        );
      },
    );

    test("a frozen test file that is a symlink is never read for the tests checkpoint", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cp-secret-")));
      dirs.push(outside);
      const secret = join(outside, "id_ed25519");
      writeFileSync(secret, "PRIVATE KEY MATERIAL\n");
      let called = 0;
      const hyp = { n: 0 };
      const { outcome } = await run({
        hypothesisCalls: hyp,
        onEvent: (e, repo) => {
          if (e.type === "stage_end" && e.stage === "test-writer") {
            const wt = worktreeOf(repo);
            rmSync(join(wt, TEST_FILE));
            symlinkSync(secret, join(wt, TEST_FILE));
          }
        },
        checkpoint: async () => {
          called++;
          return { action: "approve" };
        },
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("not a regular file");
      // Only the contract checkpoint was asked; the tests checkpoint never saw the target.
      expect(called).toBe(1);
      expect(JSON.stringify(outcome.escalation)).not.toContain("PRIVATE KEY");
      // A deterministic refusal: fixed text, no model call to explain it.
      expect(hyp.n).toBe(0);
      expect(outcome.escalation?.hypothesis).toContain("tests checkpoint");
    });

    test("a frozen test under a symlinked directory is never read for the tests checkpoint", async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cp-dir-")));
      dirs.push(outside);
      writeFileSync(join(outside, "sum.test.ts"), "// PRIVATE OUTSIDE CONTENT\n");
      let called = 0;
      const hyp = { n: 0 };
      const { outcome } = await run({
        hypothesisCalls: hyp,
        onEvent: (e, repo) => {
          if (e.type === "stage_end" && e.stage === "test-writer") {
            const wt = worktreeOf(repo);
            rmSync(join(wt, "tests"), { recursive: true, force: true });
            symlinkSync(outside, join(wt, "tests"));
          }
        },
        checkpoint: async () => {
          called++;
          return { action: "approve" };
        },
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("outside the worktree");
      expect(called).toBe(1);
      expect(JSON.stringify(outcome.escalation)).not.toContain("PRIVATE OUTSIDE");
      expect(hyp.n).toBe(0);
    });

    test("stop at tests escalates stopped_by_user with no frozen-tests commit", async () => {
      const { outcome, events } = await run({
        checkpoint: async (cp) =>
          cp.kind === "tests" ? { action: "stop", note: "wrong tests" } : { action: "approve" },
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stopped_by_user");
      expect(outcome.escalation?.details).toEqual(["wrong tests"]);
      expect(git(outcome.worktree, "log", "--format=%s")).not.toContain(
        "rewire: frozen acceptance tests",
      );
      expect(events.at(-2)).toMatchObject({ type: "escalation", reason: "stopped_by_user" });
      expect(events.some((e) => e.type === "stage_start" && e.stage === "implementer")).toBe(false);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/## Checkpoints[\s\S]*tests: stop/);
    });

    test("an abort while a checkpoint is pending resolves interrupted within 1 s", async () => {
      const ac = new AbortController();
      let abortedAt = 0;
      const pending = run({
        signal: ac.signal,
        checkpoint: () => {
          setTimeout(() => {
            abortedAt = Date.now();
            ac.abort();
          }, 50);
          return new Promise(() => {}); // never answered
        },
      });
      const { outcome } = await pending;
      expect(Date.now() - abortedAt).toBeLessThan(1000);
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("interrupted");
      expect(existsSync(outcome.reportPath)).toBe(true);
    });

    test("the commit checkpoint runs only when enabled, with the diff", async () => {
      const seen: Checkpoint[] = [];
      const { outcome } = await run({
        checkpointKinds: ["commit"],
        checkpoint: async (cp) => {
          seen.push(cp);
          return approve();
        },
      });
      expect(outcome.status).toBe("verified");
      expect(seen.map((c) => c.kind)).toEqual(["commit"]);
      const c = seen[0];
      if (c?.kind !== "commit") throw new Error("no commit checkpoint");
      expect(c.diff).toContain("+++ b/src/sum.ts");
      expect(Object.keys(c).sort()).toEqual(["diff", "kind"]);
    });

    test("a changed text-valued asset is shown on the commit checkpoint", async () => {
      const plantingImpl = responder((req) => {
        if (lastIsTool(req)) return text("done");
        const wt = worktreeOf(implRepo.path);
        mkdirSync(join(wt, "assets"), { recursive: true });
        writeFileSync(join(wt, "assets", "fake.png"), "export const hidden = 1;\n");
        return {
          toolCalls: [
            { id: "", name: "write", arguments: { path: "src/sum.ts", content: GOOD_SUM } },
          ],
        };
      });
      const implRepo = { path: "" };
      const seen: Checkpoint[] = [];
      const { outcome } = await run({
        implProvider: plantingImpl,
        onEvent: (_e, repo) => {
          implRepo.path = repo;
        },
        checkpointKinds: ["commit"],
        checkpoint: async (cp) => {
          seen.push(cp);
          return approve();
        },
      });
      expect(outcome.escalation).toBeUndefined();
      expect(outcome.status).toBe("verified");
      const c = seen[0];
      if (c?.kind !== "commit") throw new Error("no commit checkpoint");
      // A text-valued asset is shown as text (a real binary escalates in review before this;
      // commit-diff.test.ts covers the omitted listing).
      expect(c.diff).toContain("+++ b/assets/fake.png");
      expect(c.diff).toContain("+export const hidden = 1;");
      expect(c.diff).toContain("+++ b/src/sum.ts");
    });

    test("the commit diff shows text even when attributes mark it binary", async () => {
      const seen: Checkpoint[] = [];
      const { outcome } = await run({
        setup: (root) => writeFileSync(join(root, ".gitattributes"), "*.ts -diff\n"),
        checkpointKinds: ["commit"],
        checkpoint: async (cp) => {
          seen.push(cp);
          return approve();
        },
      });
      expect(outcome.status).toBe("verified");
      const c = seen[0];
      if (c?.kind !== "commit") throw new Error("no commit checkpoint");
      expect(c.diff).toContain("+  return a + b;");
      expect(c.diff).not.toMatch(/Binary files/);
    });
  },
);
