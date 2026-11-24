import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { type FrozenTestManifest, RewireError, RunEvent } from "@rewire/core";
import type { Gate, GateContext } from "@rewire/gates";
import { DEFAULT_POLICY, type Policy } from "@rewire/policy";
import {
  type ChatRequest,
  call,
  FauxProvider,
  type ModelRef,
  type Provider,
  type ScriptedTurn,
  text,
} from "@rewire/providers";
import {
  type CapabilityProfile,
  SandboxClient,
  sandboxAvailable as sandboxIsAvailable,
} from "@rewire/sandbox";
import { afterAll, describe, expect, test } from "vitest";
import { type RoleRouting, type RunOutcome, runPipeline } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sum-lib");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");
const SECRET = `sk-${"A".repeat(30)}`;
const EVIL = `[x](http://evil) | ## Status ${SECRET}`;

// Throws (failing the file) instead of skipping when REWIRE_REQUIRE_SANDBOX=1 (CI, R40).
const sandboxAvailable = sandboxIsAvailable();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(opts: { gitignore?: string; noModules?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-e2e-")));
  dirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  if (opts.gitignore !== undefined) {
    writeFileSync(join(root, ".gitignore"), opts.gitignore);
    // A real node_modules directory (what a dir-only `node_modules/` rule matches).
    mkdirSync(join(root, "node_modules"));
    for (const entry of readdirSync(WORKSPACE_MODULES)) {
      symlinkSync(join(WORKSPACE_MODULES, entry), join(root, "node_modules", entry));
    }
  } else if (!opts.noModules) {
    symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  // Never commit the shared node_modules link (a dir-only ignore does not match a symlink).
  git(root, "add", "-A");
  git(root, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const contractJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "c1",
    title: "add sum",
    criteria: [{ id: "x", kind: "change", statement: "sum(a, b) returns a + b" }],
    nonGoals: [],
    affectedAreas: ["src/sum.ts"],
    openQuestions: [],
    ...over,
  });

const TEST_FILE = "tests/sum.test.ts";
// Greenfield red test: the module does not exist yet, so it fails on the assertion.
const TEST_SRC = `import { expect, test } from "vitest";\ntest("AC-1: adds two numbers", async () => {\n  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n  expect(typeof mod.sum).toBe("function");\n  expect(mod.sum?.(2, 3)).toBe(5);\n});\n`;
// A bug for the bug-fix run: a negative second argument is ignored.
const BUGGY_SUM =
  "export function sum(a: number, b: number): number {\n  return b < 0 ? a : a + b;\n}\n";
// One red test (change) and two that pass against BUGGY_SUM already (preserve).
const BUGFIX_TEST_SRC = `import { expect, test } from "vitest";\nimport { sum } from "../src/sum.js";\ntest("AC-1: adds a negative second argument", () => {\n  expect(sum(5, -2)).toBe(3);\n});\ntest("AC-2: still adds two positive numbers", () => {\n  expect(sum(2, 3)).toBe(5);\n});\ntest("AC-3: zero plus zero is still zero", () => {\n  expect(sum(0, 0)).toBe(0);\n});\n`;
const GOOD_SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";
const MARKED_SUM =
  "export function sum(a: number, b: number): number {\n  return a + b; // trusts caller input\n}\n";
const MARK_EVIDENCE = "return a + b; // trusts caller input";

/** A provider that answers every request with `f` (many turns). */
const responder = (f: (req: ChatRequest) => ScriptedTurn): FauxProvider =>
  new FauxProvider(Array.from({ length: 500 }, () => f));

const lastIsTool = (req: ChatRequest): boolean =>
  req.messages[req.messages.length - 1]?.role === "tool";
const firstUser = (req: ChatRequest): string => req.messages[0]?.content ?? "";

/** Writes `files` on the first turn of each implementer run, then says done. */
const implementer = (files: (req: ChatRequest) => Array<[string, string]>) =>
  responder((req) => {
    if (lastIsTool(req)) return text("done");
    const writes = files(req);
    if (writes.length === 0) return text("done");
    return {
      toolCalls: writes.map(([path, content]) => ({
        id: "",
        name: "write",
        arguments: { path, content },
      })),
    };
  });

const noFindings = () => responder(() => text(JSON.stringify({ findings: [] })));

/** The security reviewer reports the marked line; other reviewers report nothing. */
const markReviewer = (scenario: string) =>
  responder((req) => {
    const user = firstUser(req);
    if (req.system.includes("## Your focus: security") && user.includes(MARK_EVIDENCE)) {
      return text(
        JSON.stringify({
          findings: [
            {
              category: "security",
              severity: 3,
              file: "src/sum.ts",
              lineStart: 2,
              lineEnd: 2,
              evidence: MARK_EVIDENCE,
              failureScenario: scenario,
              confidence: 0.9,
              suggestedFix: "validate the inputs",
            },
          ],
        }),
      );
    }
    return text(JSON.stringify({ findings: [] }));
  });

const upholdAll = () =>
  responder((req) => {
    const ids = [...firstUser(req).matchAll(/"id": "([0-9a-f]{16})"/g)].map((m) => m[1]);
    return text(
      JSON.stringify({
        verdicts: [...new Set(ids)].map((findingId) => ({
          findingId,
          verdict: "upheld",
          reasoning: `reproduced ${EVIL}`,
        })),
      }),
    );
  });

const ROUTING: RoleRouting = {
  spec: { provider: "faux", model: "spec" },
  "test-writer": { provider: "faux", model: "tw" },
  implementer: { provider: "faux", model: "impl" },
  reviewer: { provider: "faux", model: "rev" },
  verifier: { provider: "faux", model: "ver" },
  independence: "cross-family",
};

type Script = {
  spec?: Provider;
  tw?: Provider;
  impl: Provider;
  rev?: Provider;
  ver?: Provider;
};

const defaultSpec = () => new FauxProvider([text("explored"), text(contractJson())]);
const defaultTw = () =>
  new FauxProvider([call("write", { path: TEST_FILE, content: TEST_SRC }), text("done")]);

async function run(
  s: Script,
  over: {
    repo?: string;
    task?: string;
    policy?: Policy;
    ask?: (q: string[]) => Promise<string[] | null>;
    signal?: AbortSignal;
    seams?: Parameters<typeof runPipeline>[0]["seams"];
    faux?: boolean;
  } = {},
): Promise<{ outcome: RunOutcome; repo: string; events: RunEvent[] }> {
  const repo = over.repo ?? makeRepo();
  const byModel: Record<string, Provider> = {
    spec: s.spec ?? defaultSpec(),
    tw: s.tw ?? defaultTw(),
    impl: s.impl,
    rev: s.rev ?? noFindings(),
    ver: s.ver ?? upholdAll(),
  };
  const events: RunEvent[] = [];
  const outcome = await runPipeline({
    task: over.task ?? "add sum(a,b)",
    repo,
    routing: ROUTING,
    providers: (ref: ModelRef) => {
      const p = byModel[ref.model];
      if (!p) throw new Error(`no provider for ${ref.model}`);
      return p;
    },
    policy: over.policy ?? DEFAULT_POLICY,
    ask: over.ask ?? (async () => null),
    emit: (e) => events.push(e),
    ...(over.signal ? { signal: over.signal } : {}),
    ...(over.faux ? { faux: true } : {}),
    seams: { implementerMaxTurns: 6, hypothesisTimeoutMs: 5000, ...over.seams },
  });
  return { outcome, repo, events };
}

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const manifestOf = (o: RunOutcome): FrozenTestManifest =>
  JSON.parse(readFileSync(join(dirname(o.reportPath), "manifest.json"), "utf8"));
const commitsAfterBase = (repo: string, branch: string): string[] =>
  git(repo, "log", "--format=%s", `main..${branch}`).trim().split("\n").filter(Boolean);
const worktreeOf = (repo: string): string => {
  const base = join(repo, ".rewire", "worktrees");
  const [id] = readdirSync(base);
  return join(base, id ?? "");
};
const BUDGET_0: Policy = { ...DEFAULT_POLICY, maxFixRounds: 0 };

describe.skipIf(!sandboxAvailable)(
  "orchestrator e2e (real sandbox, fixture sum-lib)",
  // Row 97: each test runs the real sandbox and real gates (tsc, vitest, semgrep, gitleaks);
  // under load from other suites wall-clock dominates, so the budget is generous.
  { timeout: 240_000 },
  () => {
    test("happy path produces verified branch and report", async () => {
      const { outcome, repo, events } = await run({
        impl: implementer(() => [["src/sum.ts", GOOD_SUM]]),
      });
      expect(outcome.escalation).toBeUndefined();
      expect(outcome.status).toBe("verified");
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/## Gates[\s\S]*\| tsc \| broken \| pass/);
      expect(commitsAfterBase(repo, outcome.branch)).toEqual([
        "rewire: add sum",
        "rewire: frozen acceptance tests",
      ]);
      expect(git(repo, "log", "-1", "--format=%B", outcome.branch)).toContain(
        `Rewire-Run: ${outcome.runId}`,
      );
      expect(git(repo, "show", `${outcome.branch}:src/sum.ts`)).toBe(GOOD_SUM);
      // worktree removed, branch kept; run dir holds the artifacts
      expect(existsSync(outcome.worktree)).toBe(false);
      const runDir = dirname(outcome.reportPath);
      expect(runDir).toBe(join(repo, ".rewire", "runs", outcome.runId));
      for (const f of ["events.jsonl", "contract.json", "manifest.json", "report.md"]) {
        expect(existsSync(join(runDir, f))).toBe(true);
      }
      const logged = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n");
      expect(logged.length).toBe(events.length);
      for (const l of logged) RunEvent.parse(JSON.parse(l));
      expect(events[0]?.type).toBe("run_start");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "verified" });
      // the user's repo is still clean for the next run
      expect(git(repo, "status", "--porcelain", "--", ".", ":(exclude).rewire")).toBe("");
    });

    test("bug fix with one change and two preserve criteria reaches verified", async () => {
      // The live-run shape: a bug fix whose task says everything else keeps working. The
      // preserve tests pass before the fix (red check), and every frozen test passes after it.
      const repo = makeRepo();
      writeFileSync(join(repo, "src/sum.ts"), BUGGY_SUM);
      git(repo, "add", "src/sum.ts");
      git(repo, "commit", "-q", "-m", "buggy sum");
      const spec = new FauxProvider([
        text("explored"),
        text(
          contractJson({
            title: "fix sum with a negative addend",
            criteria: [
              { id: "x", kind: "change", statement: "sum(5, -2) returns 3" },
              { id: "y", kind: "preserve", statement: "sum(2, 3) still returns 5" },
              { id: "z", kind: "preserve", statement: "sum(0, 0) still returns 0" },
            ],
          }),
        ),
      ]);
      const tw = new FauxProvider([
        call("write", { path: "tests/sum-fix.test.ts", content: BUGFIX_TEST_SRC }),
        text("done"),
      ]);
      const { outcome } = await run(
        { spec, tw, impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        {
          repo,
          task: "Fix sum: a negative second argument is ignored. Everything that works today keeps working.",
        },
      );
      expect(outcome.escalation).toBeUndefined();
      expect(outcome.status).toBe("verified");
      const m = manifestOf(outcome);
      expect(m.criteriaToTests).toEqual({
        "AC-1": ["tests/sum-fix.test.ts::AC-1: adds a negative second argument"],
        "AC-2": ["tests/sum-fix.test.ts::AC-2: still adds two positive numbers"],
        "AC-3": ["tests/sum-fix.test.ts::AC-3: zero plus zero is still zero"],
      });
      const contract = JSON.parse(
        readFileSync(join(dirname(outcome.reportPath), "contract.json"), "utf8"),
      );
      expect(contract.criteria.map((c: { kind: string }) => c.kind)).toEqual([
        "change",
        "preserve",
        "preserve",
      ]);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/^- AC\\?-1 \(change\): /m);
      expect(report).toMatch(/^- AC\\?-2 \(preserve\): /m);
      expect(report).toMatch(/\| tests \| broken \| pass/);
      expect(git(repo, "show", `${outcome.branch}:src/sum.ts`)).toBe(GOOD_SUM);
    });

    test("a bug labelled preserve escalates with preserve_fails_now and never verifies", async () => {
      // The attack: the bug is labelled preserve beside a trivial change criterion. The faithful
      // preserve test fails today; the scripted retry would weaken it, but is never requested.
      const repo = makeRepo();
      writeFileSync(join(repo, "src/sum.ts"), BUGGY_SUM);
      git(repo, "add", "src/sum.ts");
      git(repo, "commit", "-q", "-m", "buggy sum");
      const spec = new FauxProvider([
        text("explored"),
        text(
          contractJson({
            title: "fix sum with a negative addend",
            criteria: [
              { id: "x", kind: "change", statement: "sum(0, 0) returns 0" },
              { id: "y", kind: "preserve", statement: "sum(5, -2) returns 3" },
            ],
          }),
        ),
      ]);
      const red = `import { expect, test } from "vitest";\nimport { sum } from "../src/sum.js";\ntest("AC-1: zero", () => {\n  expect(sum(0, 0)).toBe(1);\n});\n`;
      const faithful = `${red}test("AC-2: the bug", () => {\n  expect(sum(5, -2)).toBe(3);\n});\n`;
      const weakened = `${red}test("AC-2: the bug", () => {\n  expect(typeof sum(5, -2)).toBe("number");\n});\n`;
      const tw = new FauxProvider([
        call("write", { path: "tests/sum-fix.test.ts", content: faithful }),
        text("done"),
        call("write", { path: "tests/sum-fix.test.ts", content: weakened }),
        text("done"),
      ]);
      const impl = implementer(() => [["src/sum.ts", BUGGY_SUM]]);
      const { outcome } = await run(
        { spec, tw, impl },
        { repo, task: "Fix sum: a negative second argument is ignored." },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toMatch(/test-writer: preserve_fails_now: /);
      expect(outcome.escalation?.question).toMatch(/Is AC-2 mislabelled/);
      expect(outcome.escalation?.hypothesis).toMatch(/labels AC-2 as preserve/);
      expect(tw.callCount).toBe(2); // no retry
      expect((impl as FauxProvider).callCount).toBe(0);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/preserve\\?_fails\\?_now/);
    });

    test("implementer editing a frozen test cannot get verified", async () => {
      const { outcome, repo } = await run(
        {
          impl: implementer(() => [
            [
              TEST_FILE,
              `import { test } from "vitest";\ntest("AC-1: adds two numbers", () => {});\n`,
            ],
          ]),
        },
        { policy: BUDGET_0 },
      );
      expect(outcome.status).toBe("escalated");
      const m = manifestOf(outcome);
      const frozen = m.files.find((f) => f.path === TEST_FILE);
      expect(frozen?.sha256).toBe(sha(TEST_SRC));
      expect(sha(git(repo, "show", `${outcome.branch}:${TEST_FILE}`))).toBe(frozen?.sha256);
      expect(sha(readFileSync(join(outcome.worktree, TEST_FILE)))).toBe(frozen?.sha256);
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
      expect(existsSync(outcome.worktree)).toBe(true);
    });

    test("upheld security finding blocks and is fed back", async () => {
      const impl = implementer((req) => [
        ["src/sum.ts", firstUser(req).includes("Required fixes") ? GOOD_SUM : MARKED_SUM],
      ]);
      const { outcome } = await run({
        impl,
        rev: markReviewer("SCENARIO-7: a caller passes strings and gets concatenation"),
      });
      expect(outcome.status).toBe("verified");
      const fed = (impl as FauxProvider).requests.filter((r) =>
        firstUser(r).includes("SCENARIO-7: a caller passes strings"),
      );
      expect(fed.length).toBeGreaterThan(0);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/\| 1 \| 8 \|/); // round 1 scored one critical finding
      expect(report).toMatch(/\| 2 \| 0 \|/);
    });

    test("clarification with no human escalates with questions; a second run is not blocked by .rewire/runs", async () => {
      const asking = () =>
        new FauxProvider([
          text("x"),
          text(contractJson({ openQuestions: ["Which number type?"] })),
        ]);
      const task = `add sum(a,b) using key ${SECRET}`;
      const first = await run({ spec: asking(), impl: implementer(() => []) }, { task });
      expect(first.outcome.status).toBe("escalated");
      expect(first.outcome.escalation?.reason).toBe("clarification_required");
      expect(first.outcome.escalation?.question).toContain("Which number type?");
      const report = readFileSync(first.outcome.reportPath, "utf8");
      expect(report).toContain("## Escalation");
      expect(report).toContain("Which number type?");
      expect(existsSync(first.outcome.worktree)).toBe(true);
      // secret-shaped text never reaches the report or the event log
      const log = readFileSync(join(dirname(first.outcome.reportPath), "events.jsonl"), "utf8");
      expect(report).not.toContain(SECRET);
      expect(log).not.toContain(SECRET);
      expect(first.events.map((e) => JSON.stringify(e)).join("\n")).not.toContain(SECRET);

      const second = await run(
        { spec: asking(), impl: implementer(() => []) },
        { repo: first.repo, task },
      );
      expect(second.outcome.escalation?.reason).toBe("clarification_required");
      expect(second.outcome.runId).not.toBe(first.outcome.runId);
    });

    test("abort writes partial report with interrupted", async () => {
      const ac = new AbortController();
      const impl = responder(() => {
        ac.abort();
        return call("write", { path: "src/sum.ts", content: GOOD_SUM });
      });
      const { outcome, events } = await run({ impl }, { signal: ac.signal });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("interrupted");
      expect(existsSync(outcome.worktree)).toBe(true);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toContain("## Status");
      expect(report).toContain("interrupted");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "escalated" });
    });

    test("a verifier error is never done: kept findings stay upheld and the review is incomplete", async () => {
      const ver = responder(() => {
        throw new RewireError("verifier_down", "boom");
      });
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", MARKED_SUM]]), rev: markReviewer(EVIL), ver },
        { policy: BUDGET_0 },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.details?.join("\n")).toContain("verifier error:");
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toContain("verifier error:");
      // the finding's scenario is in the report, inert and redacted
      expect(report).toContain("failure scenario: [x](http://evil)");
      expect(report).not.toContain(SECRET);
      const outside = report.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "");
      expect(outside).not.toContain("](http");
      expect([...outside.matchAll(/^## Status$/gm)].length).toBe(1);
      const log = readFileSync(join(dirname(outcome.reportPath), "events.jsonl"), "utf8");
      expect(log).not.toContain(SECRET);
    });

    test("panel escalation (binary asset) with a clean score escalates review_incomplete", async () => {
      const { outcome } = await run({
        impl: implementer(() => [
          ["src/sum.ts", GOOD_SUM],
          // R23(b): an asset needs its magic number AND a NUL byte.
          ["docs/spec.pdf", "%PDF-1.4\n\u0000binary asset by magic number\n"],
        ]),
      });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("review_incomplete");
      expect(outcome.escalation?.details?.join("\n")).toContain("spec.pdf");
    });

    test("a panel rejection is never done", async () => {
      const rev = responder(() => {
        throw new RewireError("reviewer_down", "boom");
      });
      const { outcome } = await run({ impl: implementer(() => [["src/sum.ts", GOOD_SUM]]), rev });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("review_incomplete");
      expect(outcome.escalation?.details?.join("\n")).toMatch(
        /review panel error: reviewer_down: [^\n]*boom/,
      );
    });

    test("replan resets to the frozen commit: implementer leftovers are gone, frozen tests identical", async () => {
      const seen: Array<{ junk: boolean; log: boolean }> = [];
      let repoDir = "";
      const impl = implementer((req) => {
        if (firstUser(req).includes("Previous approach failed")) {
          const wt = worktreeOf(repoDir);
          seen.push({
            junk: existsSync(join(wt, "src/junk.ts")),
            log: existsSync(join(wt, "debug.log")),
          });
          return [["src/sum.ts", GOOD_SUM]];
        }
        return [
          [
            "src/sum.ts",
            "export function sum(a: number, b: number): number {\n  return a - b;\n}\n",
          ],
          ["src/junk.ts", "export const junk = 1;\n"],
          ["debug.log", "ignored leftover\n"],
        ];
      });
      repoDir = makeRepo();
      const { outcome, repo } = await run({ impl }, { repo: repoDir, policy: BUDGET_0 });
      expect(seen).toEqual([{ junk: false, log: false }]);
      expect(outcome.status).toBe("verified");
      const frozen = manifestOf(outcome).files.find((f) => f.path === TEST_FILE);
      expect(sha(git(repo, "show", `${outcome.branch}:${TEST_FILE}`))).toBe(frozen?.sha256);
      expect(git(repo, "show", `${outcome.branch}:src/sum.ts`)).toBe(GOOD_SUM);
      expect(git(repo, "ls-tree", "-r", "--name-only", outcome.branch)).not.toContain("junk.ts");
    });

    test("frozen tests are re-verified before the final commit", async () => {
      // A sandbox hole for the test only: the implementer may write test paths, and every gate
      // passes, so only the pre-commit re-check stands between the edit and a verified branch.
      const clientFactory = (p: CapabilityProfile): SandboxClient =>
        new SandboxClient(
          p.write.includes("**")
            ? { ...p, writeDeny: p.writeDeny.filter((g) => !DEFAULT_POLICY.testGlobs.includes(g)) }
            : p,
        );
      const pass: Gate = {
        name: "stub",
        category: "broken",
        run: async () => ({ status: "pass", summary: "stubbed", details: null }),
      };
      const gates = Object.fromEntries(DEFAULT_POLICY.gates.map((n) => [n, { ...pass, name: n }]));
      const edited = `import { test } from "vitest";\ntest("AC-1: adds two numbers", () => {});\n`;
      const { outcome, repo } = await run(
        {
          impl: implementer(() => [
            ["src/sum.ts", GOOD_SUM],
            [TEST_FILE, edited],
          ]),
        },
        { seams: { clientFactory, gates } },
      );
      expect(readFileSync(join(outcome.worktree, TEST_FILE), "utf8")).toBe(edited);
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain(
        `frozen test ${TEST_FILE}: modified`,
      );
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
      expect(sha(git(repo, "show", `${outcome.branch}:${TEST_FILE}`))).toBe(sha(TEST_SRC));
    });

    test("the audit gate gets a registry-profile client, the other gates a network-deny one", async () => {
      const seen: Array<{ client: string; registry: string | undefined }> = [];
      const network = (c: SandboxClient | undefined): string | undefined =>
        c
          ? (JSON.parse(readFileSync(c.profilePath, "utf8")) as CapabilityProfile).network
          : undefined;
      const audit: Gate = {
        name: "audit",
        category: "security",
        async run(ctx: GateContext) {
          seen.push({ client: network(ctx.client) ?? "", registry: network(ctx.registryClient) });
          return { status: "pass", summary: "stubbed", details: null };
        },
      };
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { seams: { gates: { audit } } },
      );
      expect(outcome.status).toBe("verified");
      expect(seen).toEqual([{ client: "deny", registry: "registry" }]);
    });

    test("every gate gets its own fresh scratch dir; nothing an earlier gate wrote is visible (C1)", async () => {
      const seen: Array<{ gate: string; scratch: string; entries: string[]; write: string[] }> = [];
      const extraWrite = (c: SandboxClient): string[] =>
        (JSON.parse(readFileSync(c.profilePath, "utf8")) as CapabilityProfile).extraWrite;
      const gates = Object.fromEntries(
        DEFAULT_POLICY.gates.map((n) => [
          n,
          {
            name: n,
            category: "broken" as const,
            async run(ctx: GateContext) {
              seen.push({
                gate: n,
                scratch: ctx.scratch,
                entries: readdirSync(ctx.scratch),
                write: extraWrite(ctx.client),
              });
              // What code under test can do: plant files in the (writable) scratch.
              await ctx.client.exec(
                [
                  "/bin/sh",
                  "-c",
                  'mkdir -p "$0/semgrep-home" && echo x > "$0/planted"',
                  ctx.scratch,
                ],
                { timeoutMs: 20_000, cwd: ctx.worktree },
              );
              return { status: "pass" as const, summary: "stubbed", details: null };
            },
          },
        ]),
      );
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { seams: { gates } },
      );
      expect(outcome.status).toBe("verified");
      const ran = seen.filter((s) => DEFAULT_POLICY.gates.includes(s.gate));
      expect(ran.length).toBeGreaterThanOrEqual(DEFAULT_POLICY.gates.length);
      for (const s of ran) {
        expect(s.entries, `${s.gate} saw an earlier gate's files`).toEqual([]);
        expect(s.write).toEqual([s.scratch]);
        expect(existsSync(s.scratch), `${s.gate} scratch was not removed`).toBe(false);
      }
      expect(new Set(ran.map((s) => s.scratch)).size).toBe(ran.length);
    });

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

    test("a dir-only node_modules/ ignore still links node_modules; the commit never holds it", async () => {
      const repo = makeRepo({ gitignore: "node_modules/\n*.log\n" });
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { repo },
      );
      expect(outcome.escalation).toBeUndefined();
      expect(outcome.status).toBe("verified");
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toMatch(/\| tsc \| broken \| pass/);
      const tree = git(repo, "ls-tree", "-r", "--name-only", outcome.branch).split("\n");
      expect(tree.filter((f) => f === "node_modules" || f.startsWith("node_modules/"))).toEqual([]);
    });

    test("an implementer-created protected file fails the frozen-tests gate (C1, R37)", async () => {
      // Host-side stand-in for Linux bash creating a path bwrap cannot block (it did not exist
      // when the sandbox started), so this runs on every platform.
      const impl = implementer(() => {
        const wf = join(worktreeOf(repo), ".github", "workflows");
        mkdirSync(wf, { recursive: true });
        writeFileSync(join(wf, "x.yml"), "on: push\njobs: {}\n");
        return [["src/sum.ts", GOOD_SUM]];
      });
      const repo = makeRepo();
      const { outcome, events } = await run({ impl }, { repo, policy: BUDGET_0 });
      expect(outcome.status).toBe("escalated");
      const frozenGate = events.filter(
        (e) => e.type === "gate_result" && e.stage === "gates" && e.result.gate === "frozen-tests",
      ) as Array<Extract<RunEvent, { type: "gate_result" }>>;
      expect(frozenGate.length).toBeGreaterThan(0);
      expect(frozenGate.every((e) => e.result.status === "fail")).toBe(true);
      expect(JSON.stringify(frozenGate[0]?.result.details)).toContain(".github/workflows/x.yml");
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
    });

    test("code hidden in an ignored dist/ is removed before the gates; the run is not verified (C2, R38)", async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, ".gitignore"), "node_modules\n*.log\ndist/\n");
      git(repo, "commit", "-q", "-am", "ignore dist");
      const impl = implementer(() => [
        ["dist/impl.ts", GOOD_SUM],
        ["src/sum.ts", 'export { sum } from "../dist/impl.js";\n'],
      ]);
      const { outcome, events } = await run({ impl }, { repo, policy: BUDGET_0 });
      expect(outcome.status).toBe("escalated");
      // The committed tree can never be one that imports a file it does not contain.
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
      const policyGates = events.filter(
        (e) => e.type === "gate_result" && e.stage === "gates",
      ) as Array<Extract<RunEvent, { type: "gate_result" }>>;
      expect(policyGates.some((e) => e.result.status !== "pass")).toBe(true);
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toContain("dist/");
    });

    test("ignored build output never reaches the commit; gates and commit see the same tree", async () => {
      const repo = makeRepo();
      // An ignored leftover the implementer writes next to a correct implementation.
      const impl = implementer(() => [
        ["src/sum.ts", GOOD_SUM],
        ["debug.log", "noise\n"],
      ]);
      const { outcome } = await run({ impl }, { repo });
      expect(outcome.status).toBe("verified");
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toContain("debug.log");
    });

    test("a file changed after the last gates fails the tree-equality check (C2/I4)", async () => {
      const gates = passAll();
      const last = DEFAULT_POLICY.gates[DEFAULT_POLICY.gates.length - 1] ?? "audit";
      gates[last] = {
        name: last,
        category: "broken",
        async run(ctx: GateContext) {
          // Stand-in for a fast-detaching implementer descendant rewriting src after gating.
          writeFileSync(join(ctx.worktree, "src", "sum.ts"), "export const sum = () => 0;\n");
          return { status: "pass", summary: "stubbed", details: null };
        },
      };
      const { outcome, repo } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { seams: { gates } },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("tree");
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
    });

    test("the commit title carries no control characters from the contract (M1)", async () => {
      const spec = new FauxProvider([
        text("explored"),
        text(contractJson({ title: "add \u001b[31msum\u001b[0m\u0007 now" })),
      ]);
      const { outcome, repo } = await run(
        { spec, impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { faux: true },
      );
      expect(outcome.status).toBe("verified");
      const msg = git(repo, "log", "-1", "--format=%B", outcome.branch);
      expect(msg).toContain("rewire: add sum now");
      // M7: a faux-provider run is marked in the commit itself, as a git trailer.
      expect(
        git(
          repo,
          "log",
          "-1",
          "--format=%(trailers:key=Rewire-Faux,valueonly)",
          outcome.branch,
        ).trim(),
      ).toBe("true");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
      expect(msg).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    });

    test("a tampered node_modules link fails every gate closed", async () => {
      // Host-side stand-in for an implementer that swaps the link for its own tools, on every
      // implementer run (a replan resets the worktree and relinks).
      const impl = implementer(() => {
        const nm = join(worktreeOf(repo), "node_modules");
        rmSync(nm, { recursive: true, force: true }); // removes the link itself, never its target
        mkdirSync(join(nm, ".bin"), { recursive: true });
        return [["src/sum.ts", GOOD_SUM]];
      });
      const repo = makeRepo();
      const { outcome, events } = await run({ impl }, { repo, policy: BUDGET_0 });
      expect(outcome.status).toBe("escalated");
      const gateEnds = events.filter((e) => e.type === "gate_result") as Array<
        Extract<RunEvent, { type: "gate_result" }>
      >;
      const report = readFileSync(outcome.reportPath, "utf8");
      expect(report).toContain("node\\_modules link tampered"); // the report escapes markdown
      expect(gateEnds.some((e) => e.result.summary === "node_modules link tampered")).toBe(true);
      expect(gateEnds.every((e) => e.result.status !== "pass")).toBe(true);
    });

    test("a node_modules link tampered after the gates blocks the final commit", async () => {
      const gates = passAll();
      const last = DEFAULT_POLICY.gates[DEFAULT_POLICY.gates.length - 1] ?? "audit";
      gates[last] = {
        name: last,
        category: "broken",
        async run(ctx: GateContext) {
          const nm = join(ctx.worktree, "node_modules");
          rmSync(nm, { force: true });
          symlinkSync(tmpdir(), nm);
          return { status: "pass", summary: "stubbed", details: null };
        },
      };
      const { outcome, repo } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { seams: { gates } },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("node_modules link tampered");
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
    });

    test("HEAD must still be the frozen commit before the final commit", async () => {
      const gates = passAll();
      const last = DEFAULT_POLICY.gates[DEFAULT_POLICY.gates.length - 1] ?? "audit";
      gates[last] = {
        name: last,
        category: "broken",
        async run(ctx: GateContext) {
          git(ctx.worktree, "commit", "-q", "--allow-empty", "--no-verify", "-m", "sneaky");
          return { status: "pass", summary: "stubbed", details: null };
        },
      };
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { seams: { gates } },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("HEAD");
    });

    test("escalation text and manifest.json are redacted", async () => {
      const tw = new FauxProvider([
        call("write", {
          path: TEST_FILE,
          content: TEST_SRC.replace("adds two numbers", `adds ${SECRET}`),
        }),
        text("done"),
      ]);
      const impl = responder((req) => {
        if (req.system.includes("stopped and needs a human")) {
          return text(JSON.stringify({ hypothesis: `leak ${SECRET}`, question: `ask ${SECRET}?` }));
        }
        if (lastIsTool(req)) return text("done");
        return call("write", { path: "src/sum.ts", content: "export const nope = 1;\n" });
      });
      const { outcome } = await run({ impl, tw }, { policy: BUDGET_0 });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.hypothesis).toContain("leak");
      expect(JSON.stringify(outcome.escalation)).not.toContain(SECRET);
      const manifest = readFileSync(join(dirname(outcome.reportPath), "manifest.json"), "utf8");
      expect(manifest).toContain("AC-1: adds");
      expect(manifest).not.toContain(SECRET);
    });

    test("the hypothesis call honours the run's abort signal", async () => {
      const ac = new AbortController();
      const fail = implementer(() => [["src/sum.ts", "export const nope = 1;\n"]]);
      let askedAt = 0;
      const impl: Provider = {
        chat(req) {
          if (req.system.includes("stopped and needs a human")) {
            askedAt = Date.now();
            ac.abort();
            // A provider that never answers: only the abort can settle the call in time.
            return new Promise(() => {});
          }
          return fail.chat(req);
        },
      };
      const { outcome } = await run(
        { impl },
        { policy: BUDGET_0, signal: ac.signal, seams: { hypothesisTimeoutMs: 60_000 } },
      );
      expect(askedAt).toBeGreaterThan(0);
      // The 60 s hypothesis timeout never fires: the run's abort settles the call at once.
      expect(Date.now() - askedAt).toBeLessThan(10_000);
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.hypothesis).toContain("Unable to generate hypothesis");
    }, 180_000);

    test("a preflight failure escalates without creating a run dir", async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, "src", "index.ts"), "// dirty\n");
      let modelCalls = 0;
      const impl: Provider = {
        async chat() {
          modelCalls++;
          return text(JSON.stringify({ hypothesis: "model", question: "model?" }));
        },
      };
      const { outcome } = await run({ impl }, { repo });
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.reportPath).toBe("");
      expect(existsSync(join(repo, ".rewire", "runs"))).toBe(false);
      // Preflight escalations get fixed text: no hypothesis model call (fix round 2, M2).
      expect(modelCalls).toBe(0);
      expect(outcome.escalation?.hypothesis).toContain("preflight");
    });

    test("a node_modules planted in a repo that has none fails the run closed", async () => {
      // No node_modules in the repo: the recorded state is "absent". A host-side plant of
      // working tools during the test-writer stands in for a forged .bin; the red check's
      // guard must catch it before any .bin tool runs.
      const repo = makeRepo({ noModules: true });
      const plant = () => {
        const nm = join(worktreeOf(repo), "node_modules");
        if (!existsSync(nm)) symlinkSync(WORKSPACE_MODULES, nm);
      };
      const tw = new FauxProvider([
        () => {
          plant();
          return call("write", { path: TEST_FILE, content: TEST_SRC });
        },
        text("done"),
      ]);
      const { outcome, events } = await run(
        { tw, impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { repo },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("node_modules");
      expect(events.some((e) => e.type === "gate_result" && e.result.status === "pass")).toBe(
        false,
      );
    });

    test("a nested node_modules staged for the final commit escalates", async () => {
      const repo = makeRepo({ gitignore: "/node_modules\n*.log\n" });
      const gates = passAll();
      const last = DEFAULT_POLICY.gates[DEFAULT_POLICY.gates.length - 1] ?? "audit";
      gates[last] = {
        name: last,
        category: "broken",
        async run(ctx: GateContext) {
          mkdirSync(join(ctx.worktree, "src", "node_modules"), { recursive: true });
          writeFileSync(join(ctx.worktree, "src", "node_modules", "x.js"), "module.exports = 1;\n");
          return { status: "pass", summary: "stubbed", details: null };
        },
      };
      const { outcome } = await run(
        { impl: implementer(() => [["src/sum.ts", GOOD_SUM]]) },
        { repo, seams: { gates } },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("node_modules");
      expect(commitsAfterBase(repo, outcome.branch)).toEqual(["rewire: frozen acceptance tests"]);
    });
  },
);

describe("preflight (no sandbox needed)", () => {
  test("a missing sandbox binary escalates in preflight before any model call (I1)", async () => {
    const old = process.env.REWIRE_SANDBOX_BIN;
    process.env.REWIRE_SANDBOX_BIN = "/nonexistent/rewire-sandbox";
    let modelCalls = 0;
    const counting: Provider = {
      async chat() {
        modelCalls++;
        return text("done");
      },
    };
    try {
      const repo = makeRepo();
      const { outcome } = await run(
        { spec: counting, tw: counting, impl: counting, rev: counting, ver: counting },
        { repo },
      );
      expect(outcome.status).toBe("escalated");
      expect(outcome.escalation?.reason).toBe("stage_error");
      expect(outcome.escalation?.details?.join("\n")).toContain("binary_missing");
      expect(outcome.reportPath).toBe("");
      expect(existsSync(join(repo, ".rewire", "runs"))).toBe(false);
      expect(modelCalls).toBe(0);
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, "REWIRE_SANDBOX_BIN");
      else process.env.REWIRE_SANDBOX_BIN = old;
    }
  });
});
