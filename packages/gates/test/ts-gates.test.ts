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

const AC_TEST = `import { expect, test } from "vitest";
import { add, double } from "../src/math.js";
test("AC-1: adds", () => { expect(add(1, 2)).toBe(3); });
test("AC-2: doubles", () => { expect(double(4)).toBe(8); });
`;

/** A frozen file covering AC-1 and AC-2, with a complete criteriaToTests mapping. */
async function freezeAc(root: string, text = AC_TEST): Promise<FrozenTestManifest> {
  write(root, "test/ac.test.ts", text);
  return {
    files: await hashFiles(root, ["test/ac.test.ts"]),
    criteriaToTests: { "AC-1": ["AC-1: adds"], "AC-2": ["AC-2: doubles"] },
  };
}

describe("grandchild", () => {
  test("a gate under a short timeout leaves no grandchild running", async () => {
    const marker = `32.${Date.now() % 1000}7`;
    const { ctx } = await makeRepo({}, 1500);
    const pack = { ...ctx.pack, lintCommand: ["sh", "-c", `sleep ${marker} & wait`] };
    const [r] = await runGates([lintGate], { ...ctx, pack });
    expect(r?.status).toBe("error");
    await new Promise((res) => setTimeout(res, 2500));
    let running = "";
    try {
      running = execFileSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" });
    } catch {
      // none
    }
    expect(running.trim()).toBe("");
  });
});

describe("tests gate", () => {
  test("passes when frozen tests cover every criterion", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("no manifest is an error (coverage cannot be attributed)", async () => {
    const { ctx } = await makeRepo();
    const r = await testsGate.run(ctx);
    expect(r.status).toBe("error");
    expect(r.summary).toMatch(/no frozen test manifest/);
  });

  test("implementer-written tests never count toward coverage", async () => {
    const { root, ctx } = await makeRepo();
    // The pre-existing math.test.ts already has passing AC-1 and AC-2 titles.
    const manifest = await freezeAc(
      root,
      `import { expect, test } from "vitest";
test("AC-1: adds", () => { expect(1).toBe(1); });
`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect((r.details as { uncoveredCriteria: string[] }).uncoveredCriteria).toEqual(["AC-2"]);
  });

  test("tests gate fails when AC-2 has no passing test", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(
      root,
      `import { expect, test } from "vitest";
test("AC-1: adds", () => { expect(1).toBe(1); });
test("AC-2: doubles", () => { expect(1).toBe(2); });
`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/AC-2/);
  });

  test("criterion with no criteriaToTests entry, or unknown key, fails", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const missing = { ...manifest, criteriaToTests: { "AC-1": ["AC-1: adds"] } };
    const r1 = await testsGate.run({ ...ctx, manifest: missing });
    expect(r1.status).toBe("fail");
    expect(JSON.stringify(r1.details)).toContain("AC-2");
    const extra = { ...manifest, criteriaToTests: { ...manifest.criteriaToTests, "AC-77": ["x"] } };
    const r2 = await testsGate.run({ ...ctx, manifest: extra });
    expect(r2.status).toBe("fail");
    expect(JSON.stringify(r2.details)).toContain("AC-77");
  });

  test("a criteriaToTests title absent from the frozen files fails", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    manifest.criteriaToTests = { "AC-1": ["AC-1: adds"], "AC-2": ["AC-2: doubles two numbers"] };
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).manifestTests)).toContain(
      "not found",
    );
  });

  test("a frozen file that did not run is a fail (C2)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    // Frozen file reported by the runner with no tests: an empty-body file has no suite.
    manifest.files = [
      ...manifest.files,
      ...(await (async () => {
        write(root, "test/empty.test.ts", "export {};\n");
        return hashFiles(root, ["test/empty.test.ts"]);
      })()),
    ];
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).frozenNotRun)).toContain(
      "test/empty.test.ts",
    );
  });

  test("a frozen file excluded by implementer config does not run and fails (C2)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    // Implementer vitest config tries to exclude the frozen file: the harness config ignores it.
    write(
      root,
      "vitest.config.mjs",
      "export default { test: { exclude: ['test/ac.test.ts', '**/node_modules/**'] } };\n",
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("pass");
  });

  test("implementer setupFiles in the worktree config are not loaded", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    write(root, "evil-setup.mjs", "throw new Error('setup must not run');\n");
    write(
      root,
      "vitest.config.mjs",
      "export default { test: { setupFiles: ['./evil-setup.mjs'] } };\n",
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("pass");
  });

  test("fails when a criterion has no test at all", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const contract = {
      ...CONTRACT,
      criteria: [...CONTRACT.criteria, { id: "AC-9", statement: "nothing" }],
    };
    const r = await testsGate.run({ ...ctx, manifest, contract });
    expect(r.status).toBe("fail");
    expect((r.details as { uncoveredCriteria: string[] }).uncoveredCriteria).toEqual(["AC-9"]);
  });

  test("tests gate fails on newly added it.skip in a frozen file", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(
      root,
      `${AC_TEST}import { it } from "vitest";\nit.skip("AC-3: later", () => {});\n`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).skippedTests)).toContain(
      "ac.test.ts",
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
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest, baseRef: "HEAD" });
    expect(r.status).toBe("pass");
  });

  test("a dynamic skip (no skip token in source) fails, even in an unchanged file (I3)", async () => {
    const { root, ctx } = await makeRepo();
    write(
      root,
      "test/dyn.test.ts",
      `import { test } from "vitest";
test("dyn", (t) => { t.skip(); });
`,
    );
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "dynamic skip");
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest, baseRef: "HEAD" });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).dynamicSkips)).toContain(
      "dyn.test.ts",
    );
  });

  test("newly added .only fails", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    write(
      root,
      "test/only.test.ts",
      `import { expect, it } from "vitest";
it.only("AC-3: focus", () => { expect(1).toBe(1); });
`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).onlyFiles)).toContain(
      "only.test.ts",
    );
  });

  test("zero tests is a fail", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    unlinkSync(join(root, "test/math.test.ts"));
    unlinkSync(join(root, "test/ac.test.ts"));
    const pack = { ...ctx.pack, testCommand: [...ctx.pack.testCommand, "--passWithNoTests"] };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/zero tests/);
  });

  test("non-zero exit with all tests passing is a fail with the exit code", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const pack = {
      ...ctx.pack,
      testCommand: ["sh", "-c", '"$@"; exit 3', "sh", ...ctx.pack.testCommand],
    };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/exited 3/);
    expect((r.details as { exitCode: number }).exitCode).toBe(3);
  });

  test("a failing test fails the gate", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(
      root,
      `import { expect, test } from "vitest";
test("AC-1: adds", () => { expect(1).toBe(2); });
test("AC-2: doubles", () => { expect(2).toBe(2); });
`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).failingTests)).toContain("AC-1");
  });

  test("no contract is an error", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest, contract: undefined });
    expect(r.status).toBe("error");
    expect(r.summary).toBe("no contract");
  });

  test("worktree given as a symlinked (non-realpath) path still works (I1)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const holder = tmp();
    const link = join(holder, "wt");
    symlinkSync(root, link);
    const r = await testsGate.run({ ...ctx, worktree: link, manifest });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
    const f = await frozenTestsGate.run({ ...ctx, worktree: link, manifest });
    expect(f.status).toBe("pass");
  });

  test("a report whose totals disagree with the runner summary is an error (S19b)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    // A shim runs the real vitest, then rewrites the JSON to claim an extra passing test.
    const shim = join(tmp(), "shim.mjs");
    writeFileSync(
      shim,
      `import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
const out = args.find((a) => a.startsWith("--outputFile=")).split("=")[1];
const j = JSON.parse(readFileSync(out, "utf8"));
j.testResults[0].assertionResults.push({ title: "AC-9: fake", fullName: "AC-9: fake", status: "passed" });
writeFileSync(out, JSON.stringify(j));
process.exit(r.status ?? 1);
`,
    );
    const pack = { ...ctx.pack, testCommand: ["node", shim, ...ctx.pack.testCommand] };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.status).toBe("error");
    expect(r.summary).toMatch(/disagree|summary/);
  });

  const node = (script: string): string[] => ["node", "-e", script];
  test.each([
    ["missing output file", "0"],
    ["unparseable JSON", "require('fs').writeFileSync(process.argv[2].split('=')[1], '{nope')"],
    ["schema mismatch", "require('fs').writeFileSync(process.argv[2].split('=')[1], '{\"a\":1}')"],
  ])("%s is an error", async (_name, script) => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const pack = { ...ctx.pack, testCommand: node(script) };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.status).toBe("error");
  });
});

describe("config drift and baseRef commands (S20)", () => {
  test.each([
    ["vitest config added", (r: string) => write(r, "vitest.config.mjs", "export default {};\n")],
    ["tsconfig changed", (r: string) => write(r, "tsconfig.json", '{"compilerOptions":{}}\n')],
    ["tsconfig deleted", (r: string) => unlinkSync(join(r, "tsconfig.json"))],
    [".gitignore changed", (r: string) => write(r, ".gitignore", "")],
    [
      "package.json scripts changed",
      (r: string) =>
        write(
          r,
          "package.json",
          JSON.stringify({ type: "module", scripts: { test: "true" }, devDependencies: {} }),
        ),
    ],
  ])("frozen gate fails on config drift: %s", async (_n, mutate) => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    mutate(root);
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect((r.details as Record<string, unknown>).configDrift).toBeDefined();
  });

  test("package.json changes outside scripts/jest/vitest are not drift", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pj.dependencies = { left: "1.0.0" };
    write(root, "package.json", JSON.stringify(pj));
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("pass");
  });

  async function lintRepo() {
    const repo = await makeRepo();
    const pj = JSON.parse(readFileSync(join(repo.root, "package.json"), "utf8"));
    pj.scripts = { lint: 'node -e "process.exit(2)"' };
    write(repo.root, "package.json", JSON.stringify(pj));
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "-m", "lint script");
    repo.ctx.pack = await detectTsPack(repo.root);
    return repo;
  }

  test("lint command comes from baseRef: removed script is a fail, not 'no linter'", async () => {
    const { root, ctx } = await lintRepo();
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pj.scripts = {};
    write(root, "package.json", JSON.stringify(pj));
    const pack = { ...ctx.pack, lintCommand: null };
    const r = await lintGate.run({ ...ctx, pack });
    expect(r.status).toBe("fail");
    expect(r.summary).not.toBe("no linter configured");
  });

  test("lint script weakened in the worktree is a fail", async () => {
    const { root, ctx } = await lintRepo();
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pj.scripts = { lint: "node -e 0" };
    write(root, "package.json", JSON.stringify(pj));
    const r = await lintGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/baseRef/);
  });

  test("baseRef lint script runs and its failure fails the gate", async () => {
    const { ctx } = await lintRepo();
    const r = await lintGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain('"exitCode":2');
  });
});

describe("fix round 2", () => {
  test("helpers, fixtures and snapshots in the manifest are hash-frozen but not run (NB1)", async () => {
    const { root, ctx } = await makeRepo();
    write(root, "test/helpers.ts", "export const h = 1;\n");
    write(root, "test/fixtures/x.json", "{}\n");
    write(root, "test/a.test.ts", AC_TEST);
    const manifest: FrozenTestManifest = {
      files: await hashFiles(root, ["test/helpers.ts", "test/fixtures/x.json", "test/a.test.ts"]),
      criteriaToTests: { "AC-1": ["AC-1: adds"], "AC-2": ["AC-2: doubles"] },
    };
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("a pre-existing non-test helper under the test globs is not collected (NB1)", async () => {
    const { root, ctx } = await makeRepo();
    write(root, "test/util.ts", 'throw new Error("must not be collected");\n');
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "util");
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("a console line imitating the summary does not win (m1)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root, `${AC_TEST}console.log("Tests  99 passed (99)");\n`);
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("the private gate dir is removed after the run (m5)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    await testsGate.run({ ...ctx, manifest });
    expect(readdirSync(ctx.scratch).filter((f) => f.startsWith("gate-"))).toEqual([]);
  });

  test("a project needing its own vitest config gets the harness-config hint (R18)", async () => {
    const { root, ctx } = await makeRepo();
    write(root, "vitest.config.mjs", "export default { test: { alias: { '@lib': './src' } } };\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "alias config");
    const manifest = await freezeAc(
      root,
      `import { expect, test } from "vitest";
import { add } from "@lib/math.js";
test("AC-1: adds", () => { expect(add(1, 2)).toBe(3); });
test("AC-2: doubles", () => { expect(2).toBe(2); });
`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/harness-owned config; project-specific vitest\/jest config/);
  });

  test("jest runs with a harness-owned config and explicit runnable paths (S23)", async () => {
    const { root, ctx } = await makeRepo();
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pj.devDependencies.jest = "^30.0.0";
    write(root, "package.json", JSON.stringify(pj));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "jest dep");
    write(root, "test/helpers.ts", "export const h = 1;\n");
    const manifest = await freezeAc(root);
    manifest.files = [...manifest.files, ...(await hashFiles(root, ["test/helpers.ts"]))];
    const out = join(ctx.scratch, "argv.json");
    const cfgCopy = join(ctx.scratch, "cfg-copy.json");
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(process.argv.slice(1)));const c=process.argv.find(a=>a.startsWith('--config=')).slice(9);fs.writeFileSync(${JSON.stringify(cfgCopy)},fs.readFileSync(c));`;
    const pack: TsPack = {
      ...ctx.pack,
      testRunner: "jest",
      testCommand: ["node", "-e", script, "--"],
      testJsonArgs: ["--json", "--outputFile=<path>"],
    };
    await testsGate.run({ ...ctx, manifest, pack });
    const argv: string[] = JSON.parse(readFileSync(out, "utf8"));
    expect(argv.some((a) => a.startsWith("--outputFile=") && a.includes(ctx.scratch))).toBe(true);
    expect(argv).not.toContain("--runTestsByPath");
    const cfg = JSON.parse(readFileSync(cfgCopy, "utf8"));
    expect(cfg.rootDir).toBe(root);
    expect(cfg.testEnvironment).toBe("node");
    expect(cfg.roots).toEqual(["<rootDir>/test"]);
    expect(cfg.cacheDirectory).toContain("jest-cache");
    expect(argv).toContain("--ci");
    expect(cfg.testMatch.join(" ")).toContain("ac.test.ts");
    expect(cfg.testMatch.join(" ")).toContain("math.test.ts");
    expect(cfg.testMatch.join(" ")).not.toContain("helpers.ts");
    for (const k of ["setupFiles", "setupFilesAfterEnv", "globalSetup", "reporters", "transform"]) {
      expect(cfg).not.toHaveProperty(k);
    }
  });

  async function committed(files: Record<string, string>) {
    const repo = await makeRepo();
    for (const [p, t] of Object.entries(files)) write(repo.root, p, t);
    git(repo.root, "add", "-A");
    git(repo.root, "commit", "-q", "--allow-empty", "-m", "inputs");
    return repo;
  }

  test.each([
    [".eslintignore modified", { ".eslintignore": "dist\n" }, ".eslintignore", "dist\nsrc\n"],
    [".prettierignore modified", { ".prettierignore": "dist\n" }, ".prettierignore", ""],
    [".npmrc modified", { ".npmrc": "a=b\n" }, ".npmrc", "a=c\n"],
    ["babel config modified", { "babel.config.json": "{}\n" }, "babel.config.json", '{"x":1}\n'],
    [".babelrc added", {}, ".babelrc", "{}\n"],
    ["nested .gitignore added", {}, "pkg/.gitignore", "*\n"],
    [
      "nested package.json eslintConfig changed",
      { "pkg/package.json": "{}\n" },
      "pkg/package.json",
      '{"eslintConfig":{"rules":{}}}\n',
    ],
  ])("frozen gate fails on drift: %s", async (_n, base, file, next) => {
    const { root, ctx } = await committed(base);
    const manifest = await freezeNew(root);
    write(root, file, next);
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).configDrift)).toContain(file);
  });

  test("package.json absent at baseRef but present now is drift (m3)", async () => {
    const { root, ctx } = await makeRepo();
    unlinkSync(join(root, "package.json"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "no package.json");
    const manifest = await freezeNew(root);
    write(root, "package.json", '{"scripts":{"lint":"true"}}\n');
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).configDrift)).toContain(
      "package.json",
    );
  });

  test("DEFAULT_POLICY protects the widened input set", () => {
    for (const g of [
      "**/.eslintignore",
      "**/.prettierignore",
      "**/biome.jsonc",
      "**/.npmrc",
      "**/.yarnrc",
      "**/.yarnrc.yml",
      "**/pnpm-workspace.yaml",
      "**/babel.config.*",
      "**/.babelrc",
      "**/.babelrc.*",
      "**/.swcrc",
      "**/.gitignore",
      "**/__mocks__/**",
    ]) {
      expect(DEFAULT_POLICY.protectedGlobs).toContain(g);
    }
    expect(DEFAULT_POLICY.protectedGlobs).not.toContain(".gitignore");
  });

  test("vitest: a fake summary block on stderr does not win (S26a)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(root);
    const shim = join(tmp(), "shim.mjs");
    writeFileSync(
      shim,
      `import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
const out = args.find((a) => a.startsWith("--outputFile=")).split("=")[1];
const j = JSON.parse(readFileSync(out, "utf8"));
j.testResults[0].assertionResults.push({ title: "AC-9: fake", fullName: "AC-9: fake", status: "passed" });
writeFileSync(out, JSON.stringify(j));
process.stderr.write("\\n Test Files  1 passed (1)\\n      Tests  5 passed (5)\\n");
process.exit(r.status ?? 1);
`,
    );
    const pack = { ...ctx.pack, testCommand: ["node", shim, ...ctx.pack.testCommand] };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.status).toBe("error");
    expect(r.summary).toMatch(/disagrees/);
  });

  test("jest: a fake vitest-style block on stdout does not win (S26b)", async () => {
    const { root, ctx } = await makeRepo();
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pj.devDependencies.jest = "^30.0.0";
    write(root, "package.json", JSON.stringify(pj));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "jest dep");
    const manifest = await freezeAc(root);
    const shim = join(tmp(), "jestshim.mjs");
    writeFileSync(
      shim,
      `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith("--outputFile=")).split("=")[1];
const cfg = JSON.parse(readFileSync(args.find((a) => a.startsWith("--config=")).slice(9), "utf8"));
const a = (t) => ({ title: t, fullName: t, status: "passed" });
writeFileSync(out, JSON.stringify({ testResults: [{ name: cfg.rootDir + "/test/ac.test.ts", status: "passed", assertionResults: [a("AC-1: adds"), a("AC-2: doubles")] }] }));
process.stdout.write("\\n Test Files  1 passed (1)\\n      Tests  3 passed (3)\\n");
process.stderr.write("Tests:       2 passed, 2 total\\n");
`,
    );
    const pack: TsPack = {
      ...ctx.pack,
      testRunner: "jest",
      testCommand: ["node", shim],
      testJsonArgs: ["--json", "--outputFile=<path>"],
    };
    const r = await testsGate.run({ ...ctx, manifest, pack });
    expect(r.details).toBeNull();
    expect(r.status).toBe("pass");
  });

  test("a new __mocks__ file is config drift (jest auto-mock substitution)", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeNew(root);
    write(root, "src/__mocks__/x.js", "module.exports = {};\n");
    const r = await frozenTestsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(JSON.stringify((r.details as Record<string, unknown>).configDrift)).toContain(
      "__mocks__",
    );
  });

  test("a baseRef file that defines tests but is not runnable fails (S24)", async () => {
    const { root, ctx } = await makeRepo();
    write(root, "tests/legacy.ts", 'import { test } from "vitest";\ntest("x", () => {});\n');
    write(root, "tests/helper.ts", "export const h = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "legacy");
    const manifest = await freezeAc(root);
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/test file not runnable under harness config: tests\/legacy\.ts/);
    expect((r.details as { unrunnableTests: string[] }).unrunnableTests).toEqual([
      "tests/legacy.ts",
    ]);
  });

  test("snapshots are never written: toMatchSnapshot without a snapshot file fails", async () => {
    const { root, ctx } = await makeRepo();
    const manifest = await freezeAc(
      root,
      `${AC_TEST}test("AC-3: snap", () => { expect({ a: 1 }).toMatchSnapshot(); });\n`,
    );
    const r = await testsGate.run({ ...ctx, manifest });
    expect(r.status).toBe("fail");
    expect(existsSync(join(root, "test/__snapshots__"))).toBe(false);
  });
});
