import { execFileSync } from "node:child_process";
import {
  cpSync,
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

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/sum-lib");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");
const sandboxAvailable = sandboxIsAvailable();

const dirs: string[] = [];
const sets: SkillSet[] = [];
afterAll(async () => {
  for (const s of sets) disposeSkillSet(s);
  for (const d of dirs) await makeWritable(d);
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

async function run(skills: SkillSet | undefined, twLoadsSkill: boolean) {
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
  const impl = responder((req) =>
    lastIsTool(req)
      ? text("done")
      : {
          toolCalls: [
            { id: "", name: "write", arguments: { path: "src/sum.ts", content: GOOD_SUM } },
          ],
        },
  );
  const rev = responder(() => text(JSON.stringify({ findings: [] })));
  const ver = responder(() => text(JSON.stringify({ verdicts: [] })));
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
    const { outcome, events, by } = await run(set, true);
    expect(outcome.status).toBe("verified");
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
      for (const r of (by[k] as FauxProvider).requests) {
        expect(r.system).not.toContain("untrusted_skills_index");
        expect(r.system).not.toContain("Test-driven development helper");
        expect(JSON.stringify(r.messages)).not.toContain("untrusted_skills_index");
        expect(toolNames(r)).not.toContain("skill");
      }
    }
    const loaded = events.filter((e) => e.type === "skill_loaded");
    expect(loaded).toHaveLength(1);
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
      calls: (by[k] as FauxProvider).requests.map((r) => ({
        system: r.system,
        tools: toolNames(r),
      })),
    }));
    // Normalise per-run random fence ids so the snapshot is stable.
    const norm = JSON.stringify(snap, null, 1).replace(UUID, "<uuid>");
    expect(norm).toMatchSnapshot();
  });
});
