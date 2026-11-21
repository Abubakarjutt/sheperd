import { execFileSync } from "node:child_process";
import {
  cpSync,
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
import { type Contract, RewireError, type RunEvent } from "@rewire/core";
import { detectTsPack } from "@rewire/pack-typescript";
import { DEFAULT_POLICY } from "@rewire/policy";
import { call, FauxProvider, type ScriptEntry, text } from "@rewire/providers";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { afterAll, expect, test } from "vitest";
import { hashFiles, runTestWriterStage, scanExports, verifyFrozen } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// Real fixture: the gates package's ts-basic repo, copied into a temp git repo with the
// workspace's node_modules symlinked (offline, same versions), exactly as the gates tests do.
const FIXTURE = resolve(here, "../../gates/test/fixtures/ts-basic");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");
const model = { provider: "ollama", model: "faux" } as const;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tw-")));
  dirs.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const CONTRACT: Contract = {
  id: "c1",
  title: "math",
  criteria: [
    { id: "AC-1", statement: "adds" },
    { id: "AC-2", statement: "doubles" },
  ],
  nonGoals: [],
  affectedAreas: ["src/math.ts"],
  openQuestions: [],
};

// Fails with a real AssertionError against the fixture's implementation (2 + 2 is 4).
const failing = (id: string, name = "x") =>
  `test("${id}: ${name}", () => { expect(add(2, 2)).toBe(5); });\n`;
const HEAD = `import { expect, test } from "vitest";\nimport { add } from "../src/math.js";\n`;
const FAIL_BOTH = `${HEAD}${failing("AC-1", "adds")}${failing("AC-2", "doubles")}`;

const write = (path: string, content: string): ScriptEntry => call("write", { path, content });

async function run(
  script: ScriptEntry[],
  over: { contract?: Contract; client?: SandboxClient; events?: RunEvent[] } = {},
) {
  const root = makeRepo();
  const provider = new FauxProvider(script);
  const events = over.events ?? [];
  const promise = runTestWriterStage({
    contract: over.contract ?? CONTRACT,
    worktree: root,
    baseRef: "HEAD",
    model,
    provider,
    pack: await detectTsPack(root),
    emit: (e) => events.push(e),
    runId: "r1",
    policy: DEFAULT_POLICY,
    ...(over.client ? { client: over.client } : {}),
  });
  return { root, provider, events, promise };
}

const fails = async (p: Promise<unknown>): Promise<RewireError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(RewireError);
  return e as RewireError;
};

test("missing AC coverage rejected", async () => {
  const { promise } = await run([
    write("test/ac.test.ts", `${HEAD}${failing("AC-1", "adds")}`),
    text("done"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("criteria_uncovered");
  expect(err.message).toBe("AC-2");
});

test("red check rejects tests failing with import error", async () => {
  const bad = `import { expect, test } from "vitest";\nimport { nope } from "../src/nope.js";\ntest("AC-1: a", () => { expect(nope).toBe(1); });\ntest("AC-2: b", () => { expect(nope).toBe(2); });\n`;
  const { promise, provider } = await run([
    write("test/ac.test.ts", bad),
    text("done"),
    write("test/ac.test.ts", bad),
    text("done again"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("red_check_failed");
  expect(err.message).toContain("test/ac.test.ts");
  expect(provider.callCount).toBe(4); // exactly one retry
});

test("red check rejects tests that already pass", async () => {
  const passing = `import { expect, test } from "vitest";\ntest("AC-1: a", () => { expect(1).toBe(1); });\ntest("AC-2: b", () => { expect(2).toBe(2); });\n`;
  const { promise } = await run([
    write("test/ac.test.ts", passing),
    text("done"),
    write("test/ac.test.ts", passing),
    text("done"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("red_check_failed");
  expect(err.message).toMatch(/test passed, it must fail/);
});

test("red check accepts assertion failures and freezes hashes", async () => {
  const events: RunEvent[] = [];
  const { promise, root } = await run([write("test/ac.test.ts", FAIL_BOTH), text("done")], {
    events,
  });
  const m = await promise;
  expect(m.files).toHaveLength(1);
  expect(m.files[0]?.path).toBe("test/ac.test.ts");
  expect(m.files[0]?.sha256).toHaveLength(64);
  expect(m.criteriaToTests).toEqual({
    "AC-1": ["test/ac.test.ts::AC-1: adds"],
    "AC-2": ["test/ac.test.ts::AC-2: doubles"],
  });
  expect((await verifyFrozen(root, m)).ok).toBe(true);
  expect(events[0]).toMatchObject({ type: "stage_start", stage: "test-writer", runId: "r1" });
  const end = events.at(-1);
  expect(end?.type === "stage_end" && end.ok).toBe(true);
});

test("verifyFrozen detects modified test file", async () => {
  const { promise, root } = await run([write("test/ac.test.ts", FAIL_BOTH), text("done")]);
  const m = await promise;
  writeFileSync(
    join(root, "test/ac.test.ts"),
    `${readFileSync(join(root, "test/ac.test.ts"), "utf8")} `,
  );
  const r = await verifyFrozen(root, m);
  expect(r.ok).toBe(false);
  expect(r.mismatches).toEqual([{ path: "test/ac.test.ts", reason: "modified" }]);
  // hashFiles agrees the content changed.
  expect((await hashFiles(root, ["test/ac.test.ts"]))[0]?.sha256).not.toBe(m.files[0]?.sha256);
});

test("modifying a pre-existing test file is a stage error", async () => {
  const { promise, root } = await run([
    call("edit", { path: "test/math.test.ts", oldString: "toBe(3)", newString: "toBe(4)" }),
    write("test/ac.test.ts", FAIL_BOTH),
    text("done"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("test_writer_modified_existing");
  expect(err.message).toBe("test/math.test.ts");
  expect(root).toBeTruthy();
});

test("a change outside the test globs is out of scope", async () => {
  const root0 = makeRepo();
  // Defense in depth: a client whose sandbox is wider than the profile should be.
  const wide = new SandboxClient({
    ...profileFor("test-writer", root0, DEFAULT_POLICY, root0),
    write: ["**"],
    writeDeny: [],
  });
  try {
    const provider = new FauxProvider([
      write("src/evil.ts", "export const x = 1;\n"),
      text("done"),
    ]);
    const err = await fails(
      runTestWriterStage({
        contract: CONTRACT,
        worktree: root0,
        baseRef: "HEAD",
        model,
        provider,
        pack: await detectTsPack(root0),
        emit: () => {},
        runId: "r1",
        policy: DEFAULT_POLICY,
        client: wide,
      }),
    );
    expect(err.code).toBe("test_writer_out_of_scope");
    expect(err.message).toBe("src/evil.ts");
  } finally {
    wide.dispose();
  }
});

test("a title for an unknown criterion is rejected", async () => {
  const { promise } = await run([
    write("test/ac.test.ts", `${FAIL_BOTH}${failing("AC-9", "ghost")}`),
    text("done"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("unknown_criterion");
  expect(err.message).toBe("AC-9");
});

test("a failed red check is retried once with details, and the retry can succeed", async () => {
  const passing = `import { expect, test } from "vitest";\ntest("AC-1: a", () => { expect(1).toBe(1); });\n`;
  const { promise, provider } = await run([
    write("test/ac.test.ts", passing),
    text("done"),
    write("test/ac.test.ts", FAIL_BOTH),
    text("fixed"),
  ]);
  const m = await promise;
  expect(provider.callCount).toBe(4);
  const retry = provider.requests[2]?.messages[0]?.content ?? "";
  expect(retry).toContain("Red check failed");
  expect(retry).toContain("test passed, it must fail");
  expect(retry).toContain("test/ac.test.ts :: AC-1: a");
  // Frozen hash is of the final (retried) content.
  expect(m.files).toHaveLength(1);
  expect(Object.keys(m.criteriaToTests).sort()).toEqual(["AC-1", "AC-2"]);
});

test("snapshot assertions fail the red check", async () => {
  const snap = `import { expect, test } from "vitest";\nimport { add } from "../src/math.js";\ntest("AC-1: a", () => { expect(add(1, 2)).toMatchSnapshot(); });\ntest("AC-2: b", () => { expect(add(1, 2)).toMatchInlineSnapshot(); });\n`;
  const { promise } = await run([
    write("test/ac.test.ts", snap),
    text("done"),
    write("test/ac.test.ts", snap),
    text("done"),
  ]);
  const err = await fails(promise);
  expect(err.code).toBe("red_check_failed");
  expect(err.message).toContain("snapshot assertions cannot be red-checked");
});

test("helper files are frozen in the manifest but ignored by the red check", async () => {
  const test1 = `import { expect, test } from "vitest";\nimport { add } from "../src/math.js";\nimport { WRONG } from "./helpers/data.js";\ntest("AC-1: adds", () => { expect(add(2, 2)).toBe(WRONG); });\ntest("AC-2: doubles", () => { expect(add(2, 2)).toBe(WRONG); });\n`;
  const { promise, root } = await run([
    write("test/helpers/data.ts", "export const WRONG = 5;\n"),
    write("test/ac.test.ts", test1),
    text("done"),
  ]);
  const m = await promise;
  expect(m.files.map((f) => f.path)).toEqual(["test/ac.test.ts", "test/helpers/data.ts"]);
  expect(Object.values(m.criteriaToTests).flat()).toEqual([
    "test/ac.test.ts::AC-1: adds",
    "test/ac.test.ts::AC-2: doubles",
  ]);
  expect((await verifyFrozen(root, m)).ok).toBe(true);
});

test("scanExports lists declarations, lists and default exports", () => {
  const src = `export function a() {}\nexport async function b() {}\nexport const c = 1;\nexport interface D {}\nexport type E = 1;\nexport { x, y as z };\nexport default class F {}\nconst hidden = 1;\n`;
  expect(scanExports(src)).toEqual([
    "function a",
    "function b",
    "const c",
    "interface D",
    "type E",
    "class F",
    "export x",
    "export z",
  ]);
});
