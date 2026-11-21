import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Contract, FrozenTestManifest } from "@rewire/core";
import { detectTsPack, type TsPack } from "@rewire/pack-typescript";
import { DEFAULT_POLICY } from "@rewire/policy";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { afterAll, describe, expect, test } from "vitest";
import {
  frozenTestsGate,
  type Gate,
  type GateContext,
  hashFiles,
  lintGate,
  runGates,
  testsGate,
  tscGate,
  verifyFrozen,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "ts-basic");
// Fixture strategy: the fixture declares vitest and typescript, but installing needs the network.
// Each test repo symlinks node_modules to the workspace's own install (same versions), which is
// offline, fast and gives real .bin/tsc and .bin/vitest. node_modules is gitignored in the fixture.
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-ts-gates-")));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

const CONTRACT: Contract = {
  id: "c1",
  title: "t",
  criteria: [
    { id: "AC-1", statement: "adds" },
    { id: "AC-2", statement: "doubles" },
  ],
  nonGoals: [],
  affectedAreas: [],
  openQuestions: [],
};

type Repo = { root: string; ctx: GateContext; pack: TsPack };

async function makeRepo(over: Partial<GateContext> = {}, timeoutMs = 120_000): Promise<Repo> {
  const root = tmp();
  cpSync(FIXTURE, root, { recursive: true });
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const scratch = tmp();
  const client = new SandboxClient(profileFor("verify", root, DEFAULT_POLICY, scratch));
  const pack = await detectTsPack(root);
  const ctx: GateContext = {
    worktree: root,
    baseRef: "HEAD",
    client,
    registryClient: client,
    pack,
    policy: { ...DEFAULT_POLICY, gateTimeoutMs: timeoutMs },
    scratch,
    runId: "r",
    stage: "verify",
    contract: CONTRACT,
    ...over,
  };
  return { root, ctx, pack };
}

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const NEW_TEST = `import { expect, test } from "vitest";
import { add } from "../src/math.js";
test("AC-3: adds again", () => { expect(add(2, 2)).toBe(4); });
`;

async function freezeNew(root: string): Promise<FrozenTestManifest> {
  write(root, "test/new.test.ts", NEW_TEST);
  return { files: await hashFiles(root, ["test/new.test.ts"]), criteriaToTests: {} };
}

describe("frozen helpers", () => {
  test("hashFiles hashes resolved contents of symlinks", async () => {
    const { root } = await makeRepo();
    symlinkSync("../src/math.ts", join(root, "test/link.test.ts"));
    const [a] = await hashFiles(root, ["test/link.test.ts"]);
    const [b] = await hashFiles(root, ["src/math.ts"]);
    expect(a?.sha256).toBe(b?.sha256);
  });
  test("verifyFrozen reports modified, missing and symlinked files", async () => {
    const { root } = await makeRepo();
    write(root, "test/a.test.ts", "a");
    write(root, "test/b.test.ts", "b");
    write(root, "test/c.test.ts", "c");
    const files = await hashFiles(root, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
    const manifest = { files, criteriaToTests: {} };
    expect((await verifyFrozen(root, manifest)).ok).toBe(true);
    write(root, "test/a.test.ts", "changed");
    unlinkSync(join(root, "test/b.test.ts"));
    unlinkSync(join(root, "test/c.test.ts"));
    symlinkSync("../src/math.ts", join(root, "test/c.test.ts"));
    const r = await verifyFrozen(root, manifest);
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((m) => [m.path, m.reason])).toEqual([
      ["test/a.test.ts", "modified"],
      ["test/b.test.ts", "missing"],
      ["test/c.test.ts", "symlink"],
    ]);
  });
});

describe("frozen-tests gate", () => {
  test("passes when frozen files are intact and nothing pre-existing changed", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("pass");
  });

  test("frozen gate fails when pre-existing test modified", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    write(root, "test/math.test.ts", "// weakened\n");
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("test/math.test.ts");
  });

  test("fails when a pre-existing test is deleted", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    unlinkSync(join(root, "test/math.test.ts"));
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("test/math.test.ts");
  });

  test("fails on a new untracked test file that is not frozen", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    write(root, "test/sneaky.test.ts", "// x\n");
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("sneaky");
  });

  test("fails when a test file is a symlink to src", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    symlinkSync("../src/math.ts", join(root, "test/link.test.ts"));
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).symlinksOutsideTests)).toContain(
      "test/link.test.ts",
    );
  });

  test("allows a symlink that stays within the test globs", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    symlinkSync("new.test.ts", join(root, "test/alias.test.ts"));
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(JSON.stringify((r.details as Record<string, unknown>).symlinksOutsideTests)).toBe(
      undefined,
    );
  });

  test("fails when a manifest file is modified, deleted, or became a symlink", async () => {
    for (const mutate of [
      (root: string) => write(root, "test/new.test.ts", `${NEW_TEST}// edit\n`),
      (root: string) => unlinkSync(join(root, "test/new.test.ts")),
      (root: string) => {
        unlinkSync(join(root, "test/new.test.ts"));
        symlinkSync("../src/math.ts", join(root, "test/new.test.ts"));
      },
    ]) {
      const { root, ctx } = await makeRepo();
      const manifest = await freezeNew(root);
      mutate(root);
      const r = await frozenTestsGate.run({ ...ctx, manifest });
      expect(r.status).toBe("fail");
      expect(JSON.stringify(r.details)).toContain("frozenMismatches");
    }
  });

  test("no manifest is an error", async () => {
    const { ctx } = await makeRepo();
    const r = await frozenTestsGate.run(ctx);
    expect(r.status).toBe("error");
    expect(r.summary).toBe("no frozen test manifest");
  });

  test("git failure is an error, never a pass", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    const r = await frozenTestsGate.run({ ...ctx, manifest, baseRef: "no-such-ref" });
    expect(r.status).toBe("error");
  });
});

describe("tsc gate", () => {
  test("passes on clean project", async () => {
    const { ctx } = await makeRepo();
    expect((await tscGate.run(ctx)).status).toBe("pass");
  });

  test("tsc gate reports diagnostics", async () => {
    const { root, ctx } = await makeRepo();
    write(root, "src/bad.ts", 'export const n: number = "x";\n');
    const r = await tscGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("TS2322");
  });

  test("missing local tsc is an error", async () => {
    const { root, ctx } = await makeRepo();
    unlinkSync(join(root, "node_modules"));
    const r = await tscGate.run(ctx);
    expect(r.status).toBe("error");
    expect(r.summary).toBe("typescript not installed in project — run pnpm install");
  });
});

describe("lint gate", () => {
  test("lint gate passes with notice when no linter", async () => {
    const { ctx } = await makeRepo();
    const r = await lintGate.run({ ...ctx, pack: { ...ctx.pack, lintCommand: null } });
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no linter configured");
  });

  test("non-zero exit fails", async () => {
    const { ctx } = await makeRepo();
    const pack = {
      ...ctx.pack,
      lintCommand: ["node", "-e", "console.log('bad'); process.exit(2)"],
    };
    const r = await lintGate.run({ ...ctx, pack });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("bad");
  });

  test("zero exit passes", async () => {
    const { ctx } = await makeRepo();
    const pack = { ...ctx.pack, lintCommand: ["node", "-e", "0"] };
    expect((await lintGate.run({ ...ctx, pack })).status).toBe("pass");
  });

  test("npx command resolves the local .bin and errors when absent", async () => {
    const { root, ctx } = await makeRepo();
    const pack = { ...ctx.pack, lintCommand: ["npx", "tsc", "--version"] };
    expect((await lintGate.run({ ...ctx, pack })).status).toBe("pass");
    unlinkSync(join(root, "node_modules"));
    const r = await lintGate.run({ ...ctx, pack });
    expect(r.status).toBe("error");
    expect(r.summary).toBe("tsc not installed in project — run pnpm install");
  });

  test("a gate under a short timeout leaves no running child", async () => {
    const marker = `31.${Date.now() % 1000}9`;
    const { ctx } = await makeRepo({}, 1500);
    const pack = { ...ctx.pack, lintCommand: ["sleep", marker] };
    const gates: Gate[] = [lintGate];
    const [r] = await runGates(gates, { ...ctx, pack });
    expect(r?.status).toBe("error");
    expect(r?.summary).toMatch(/timed out/);
    await new Promise((res) => setTimeout(res, 2500));
    let running = "";
    try {
      running = execFileSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" });
    } catch {
      // pgrep exits 1 when nothing matches
    }
    expect(running.trim()).toBe("");
  });
});

describe("tests gate", () => {
  test("passes when every criterion has a passing test", async () => {
    const { ctx } = await makeRepo();
    const r = await testsGate.run(ctx);
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("tests gate fails when AC-2 has no passing test", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/math.test.ts",
      `import { expect, test } from "vitest";
test("AC-1: adds", () => { expect(1 + 1).toBe(2); });
test("AC-2: doubles", () => { expect(1).toBe(2); });
`,
    );
    const r = await testsGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/AC-2/);
    expect(JSON.stringify(r.details)).toContain("uncoveredCriteria");
  });

  test("fails when a criterion has no test at all", async () => {
    const { ctx } = await makeRepo();
    const contract = {
      ...CONTRACT,
      criteria: [...CONTRACT.criteria, { id: "AC-9", statement: "nothing" }],
    };
    const r = await testsGate.run({ ...ctx, contract });
    expect(r.status).toBe("fail");
    expect((r.details as { uncoveredCriteria: string[] }).uncoveredCriteria).toEqual(["AC-9"]);
  });

  test("tests gate fails on newly added it.skip", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/extra.test.ts",
      `import { it } from "vitest";
it.skip("AC-3: later", () => {});
`,
    );
    const r = await testsGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).skippedTests)).toContain(
      "extra.test.ts",
    );
  });

  test("a pre-existing skip in an unchanged file is tolerated", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/old.test.ts",
      `import { it } from "vitest";
it.skip("legacy", () => {});
`,
    );
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "old skip");
    const r = await testsGate.run({ ...ctx, baseRef: "HEAD" });
    expect(r.status).toBe("pass");
  });

  test("newly added .only fails", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/only.test.ts",
      `import { expect, it } from "vitest";
it.only("AC-3: focus", () => { expect(1).toBe(1); });
`,
    );
    const r = await testsGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).onlyFiles)).toContain(
      "only.test.ts",
    );
  });

  test("zero tests is a fail", async () => {
    const { root, ctx } = await makeRepo();
    unlinkSync(join(root, "test/math.test.ts"));
    const pack = { ...ctx.pack, testCommand: [...ctx.pack.testCommand, "--passWithNoTests"] };
    const r = await testsGate.run({ ...ctx, pack });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/zero tests/);
  });

  test("non-zero exit with all tests passing is a fail with the exit code", async () => {
    const { ctx } = await makeRepo();
    const pack = {
      ...ctx.pack,
      testCommand: ["sh", "-c", '"$@"; exit 3', "sh", ...ctx.pack.testCommand],
    };
    const r = await testsGate.run({ ...ctx, pack });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/exited 3/);
    expect((r.details as { exitCode: number }).exitCode).toBe(3);
  });

  test("a failing test fails the gate", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/math.test.ts",
      `import { expect, test } from "vitest";
test("AC-1: adds", () => { expect(1).toBe(2); });
test("AC-2: doubles", () => { expect(2).toBe(2); });
`,
    );
    const r = await testsGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).failingTests)).toContain("AC-1");
  });

  test("manifest criteriaToTests entries must exist and pass", async () => {
    const { ctx } = await makeRepo();
    const manifest: FrozenTestManifest = {
      files: [],
      criteriaToTests: { "AC-1": ["math AC-1: adds two numbers"], "AC-2": ["math AC-2: gone"] },
    };
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).manifestTests)).toContain("gone");
  });

  test("no contract is an error", async () => {
    const { ctx } = await makeRepo();
    const r = await testsGate.run({ ...ctx, contract: undefined });
    expect(r.status).toBe("error");
    expect(r.summary).toBe("no contract");
  });

  const node = (script: string): string[] => ["node", "-e", script];
  test.each([
    ["missing output file", "0"],
    ["unparseable JSON", "require('fs').writeFileSync(process.argv[2].split('=')[1], '{nope')"],
    ["schema mismatch", "require('fs').writeFileSync(process.argv[2].split('=')[1], '{\"a\":1}')"],
  ])("%s is an error", async (_name, script) => {
    const { ctx } = await makeRepo();
    const pack = { ...ctx.pack, testCommand: node(script) };
    const r = await testsGate.run({ ...ctx, pack });
    expect(r.status).toBe("error");
  });
});
