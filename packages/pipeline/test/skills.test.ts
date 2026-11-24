import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunEvent } from "@rewire/core";
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
import {
  createSkillSet,
  discoverSkills,
  disposeSkillSet,
  makeWritable,
  type SkillSet,
  skillIndex,
} from "@rewire/skills";
import { afterAll, describe, expect, test } from "vitest";
import { type RoleRouting, runPipeline } from "../src/index.js";
import { authorSkills, skillMemoSize } from "../src/skills.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sum-lib");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");
const sandboxAvailable = sandboxIsAvailable();

const dirs: string[] = [];
const sets: SkillSet[] = [];
afterAll(async () => {
  for (const s of sets) disposeSkillSet(s);
  for (const d of dirs) await makeWritable(d).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-skills-")));
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

async function makeSet(): Promise<SkillSet> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-skillhome-")));
  dirs.push(base);
  const home = join(base, "home");
  const xdgConfig = join(base, "config");
  mkdirSync(join(home, ".claude", "skills", "tdd"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "tdd", "REFERENCE.md"), "bundled reference text\n");
  writeFileSync(
    join(home, ".claude", "skills", "tdd", "SKILL.md"),
    "---\nname: tdd\ndescription: Test-driven development helper\n---\nWrite the test first.\n",
  );
  const { skills } = await discoverSkills({ home, xdgConfig, repo: base });
  const set = createSkillSet(skills, { home, xdgConfig, cacheDir: join(base, "cache") });
  sets.push(set);
  return set;
}

const contractJson = JSON.stringify({
  id: "c1",
  title: "add sum",
  criteria: [{ id: "x", kind: "change", statement: "sum(a, b) returns a + b" }],
  nonGoals: [],
  affectedAreas: ["src/sum.ts"],
  openQuestions: [],
});
const TEST_SRC = `import { expect, test } from "vitest";\ntest("AC-1: adds two numbers", async () => {\n  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n  expect(typeof mod.sum).toBe("function");\n  expect(mod.sum?.(2, 3)).toBe(5);\n});\n`;
const GOOD_SUM = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";

const responder = (f: (req: ChatRequest) => ScriptedTurn): FauxProvider =>
  new FauxProvider(Array.from({ length: 500 }, () => f));
const lastIsTool = (req: ChatRequest): boolean =>
  req.messages[req.messages.length - 1]?.role === "tool";

const ROUTING: RoleRouting = {
  spec: { provider: "faux", model: "spec" },
  "test-writer": { provider: "faux", model: "tw" },
  implementer: { provider: "faux", model: "impl" },
  reviewer: { provider: "faux", model: "rev" },
  verifier: { provider: "faux", model: "ver" },
  independence: "cross-family",
};

const MARKED_SUM =
  "export function sum(a: number, b: number): number {\n  return a + b; // trusts caller input\n}\n";
const MARK = "return a + b; // trusts caller input";

async function run(
  skills: SkillSet | undefined,
  twLoadsSkill: boolean,
  o: { withFinding?: boolean; impl?: Provider } = {},
) {
  const spec = new FauxProvider([text("explored"), text(contractJson)]);
  const tw = new FauxProvider(
    twLoadsSkill
      ? [
          call("skill", { name: "tdd" }),
          call("write", { path: "tests/sum.test.ts", content: TEST_SRC }),
          text("done"),
        ]
      : [call("write", { path: "tests/sum.test.ts", content: TEST_SRC }), text("done")],
  );
  const sumSrc = o.withFinding ? MARKED_SUM : GOOD_SUM;
  const impl = (o.impl ??
    responder((req) =>
      lastIsTool(req)
        ? text("done")
        : {
            toolCalls: [
              { id: "", name: "write", arguments: { path: "src/sum.ts", content: sumSrc } },
            ],
          },
    )) as FauxProvider;
  const rev = responder((req) =>
    o.withFinding &&
    req.system.includes("## Your focus: security") &&
    (req.messages[0]?.content ?? "").includes(MARK)
      ? text(
          JSON.stringify({
            findings: [
              {
                category: "security",
                severity: 3,
                file: "src/sum.ts",
                lineStart: 2,
                lineEnd: 2,
                evidence: MARK,
                failureScenario: "unchecked input",
                confidence: 0.9,
                suggestedFix: "validate",
              },
            ],
          }),
        )
      : text(JSON.stringify({ findings: [] })),
  );
  const ver = responder((req) => {
    const ids = [...(req.messages[0]?.content ?? "").matchAll(/"id": "([0-9a-f]{16})"/g)].map(
      (m) => m[1],
    );
    return text(
      JSON.stringify({
        verdicts: [...new Set(ids)].map((findingId) => ({
          findingId,
          verdict: "refuted",
          reasoning: "not reproducible",
        })),
      }),
    );
  });
  const by: Record<string, FauxProvider> = { spec, tw, impl, rev, ver };
  const events: RunEvent[] = [];
  const outcome = await runPipeline({
    task: "add sum(a,b)",
    repo: makeRepo(),
    routing: ROUTING,
    providers: (ref: ModelRef): Provider => by[ref.model] as Provider,
    policy: DEFAULT_POLICY,
    ask: async () => null,
    emit: (e) => events.push(e),
    ...(skills ? { skills } : {}),
    seams: { implementerMaxTurns: 6, hypothesisTimeoutMs: 5000 },
  });
  return { outcome, events, by };
}

const UUID = /[0-9a-f]{8}-[0-9a-f-]{27}/g;
const toolNames = (r: ChatRequest): string[] => (r.tools ?? []).map((t) => t.name);

describe.skipIf(!sandboxAvailable)("skills in the author stages", { timeout: 240_000 }, () => {
  test("author stages get the index and tool; review and verify get neither", async () => {
    const set = await makeSet();
    const index = skillIndex(set).replace(UUID, "<uuid>");
    const { outcome, events, by } = await run(set, true, { withFinding: true });
    expect(outcome.status).toBe("verified");
    // the run released its per-stage skill tools
    expect(skillMemoSize(set, outcome.runId)).toBe(0);
    for (const k of ["spec", "tw", "impl"] as const) {
      const reqs = (by[k] as FauxProvider).requests;
      expect(reqs.length).toBeGreaterThan(0);
      // the spec compile call is structured output and carries no tools
      const agentReqs = reqs.filter((r) => toolNames(r).length > 0);
      expect(agentReqs.length).toBeGreaterThan(0);
      for (const r of agentReqs) {
        expect(r.system.replace(UUID, "<uuid>")).toContain(index);
        expect(toolNames(r)).toContain("skill");
      }
    }
    for (const k of ["rev", "ver"] as const) {
      // non-vacuous: the verifier only runs when a finding exists
      expect((by[k] as FauxProvider).requests.length).toBeGreaterThan(0);
      for (const r of (by[k] as FauxProvider).requests) {
        expect(r.system).not.toContain("untrusted_skills_index");
        expect(r.system).not.toContain("Test-driven development helper");
        expect(JSON.stringify(r.messages)).not.toContain("untrusted_skills_index");
        expect(toolNames(r)).not.toContain("skill");
      }
    }
    const loaded = events.filter((e) => e.type === "skill_loaded");
    expect(loaded).toHaveLength(1);
    expect(loaded.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
    expect(loaded[0]).toMatchObject({ stage: "test-writer", name: "tdd", source: "user" });
    for (const e of events) RunEvent.parse(e);
    const sha = (loaded[0] as { sha256: string }).sha256;
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("## Skills used");
    expect(report).toContain(`- tdd (user, sha256 ${sha.slice(0, 12)}) — test-writer`);
  });

  test("without skills the prompts and tool lists are unchanged and the report has no section", async () => {
    const { outcome, events, by } = await run(undefined, false);
    expect(outcome.status).toBe("verified");
    expect(events.some((e) => e.type === "skill_loaded")).toBe(false);
    expect(readFileSync(outcome.reportPath, "utf8")).not.toContain("Skills used");
    const snap = ["spec", "tw", "impl", "rev", "ver"].map((k) => ({
      k,
      // parallel reviewers hit one faux provider: order by content, not arrival
      calls: (by[k] as FauxProvider).requests
        .map((r) => ({ system: r.system, tools: toolNames(r) }))
        .sort((a, b) => a.system.localeCompare(b.system)),
    }));
    // Normalise per-run random fence ids so the snapshot is stable.
    const norm = JSON.stringify(snap, null, 1).replace(UUID, "<uuid>");
    expect(norm).toMatchSnapshot();
  });

  test("a sandboxed implementer reads a materialized bundled file but cannot write there", async () => {
    const set = await makeSet();
    const seen: string[] = [];
    let dir = "";
    let step = 0;
    const impl = responder((req) => {
      const last = req.messages[req.messages.length - 1];
      if (last?.role === "tool") seen.push(last.content);
      step++;
      if (step === 1) return call("skill", { name: "tdd" });
      if (step === 2) {
        dir = /are in: (\S+)/.exec(seen[0] ?? "")?.[1] ?? "";
        return call("bash", { command: `cat ${dir}/REFERENCE.md` });
      }
      if (step === 3) return call("bash", { command: `touch ${dir}/x` });
      if (step === 4) {
        return call("write", { path: "src/sum.ts", content: GOOD_SUM });
      }
      return text("done");
    });
    const { outcome } = await run(set, false, { impl });
    expect(outcome.status).toBe("verified");
    expect(dir).toContain(set.root ?? "<none>");
    expect(seen[1]).toContain("bundled reference text");
    expect(seen[2]).not.toContain("bundled reference text");
    expect(existsSync(join(dir, "x"))).toBe(false);
  });
});

describe("authorSkills", () => {
  test("one tool per stage per run: repeated builds report a skill once", async () => {
    const set = await makeSet();
    const events: RunEvent[] = [];
    const a = authorSkills(set, "test-writer", "r1", (e) => events.push(e));
    const b = authorSkills(set, "test-writer", "r1", (e) => events.push(e));
    expect(b.tools[0]).toBe(a.tools[0]);
    await a.tools[0]?.execute({ name: "tdd" });
    await b.tools[0]?.execute({ name: "tdd" });
    expect(events.filter((e) => e.type === "skill_loaded")).toHaveLength(1);
    const c = authorSkills(set, "implementer", "r1", (e) => events.push(e));
    expect(c.tools[0]).not.toBe(a.tools[0]);
    expect(authorSkills(undefined, "x", "r1", () => {}).tools).toEqual([]);
  });
});
