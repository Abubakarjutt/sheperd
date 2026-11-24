import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative } from "node:path";
import { z } from "zod";
import type { Gate, GateContext, GateOutput } from "../types.js";
import {
  baseFileList,
  baseText,
  changedTestFiles,
  ENV_BIN,
  GateExec,
  inNodeModules,
  matchesAnyGlob,
  realRootOf,
} from "./shared.js";

/*
 * KNOWN_LIMITS (for the T21 evidence report):
 *  - The tests run in the same process as the code under test. Implementer code imported by a
 *    frozen test can tamper with the assertion library itself (patch expect/chai so assertions
 *    always pass), not only forge the reporter output. Beyond that, patching both the JSON
 *    report and the console summary in-process also works. We only detect cheap forgery (report
 *    edited after the fact, or disagreeing with the runner's own summary).
 *  - The harness config is owned by the gate: no project setupFiles/globalSetup, plugins,
 *    aliases or tsconfig-paths. Projects needing them fail closed (with a hint).
 *  - jest is covered by unit tests only (no real jest run); transform stays the jest default
 *    (babel-jest), whose config files are drift-checked and protected.
 *  - The console-summary cross-check reads the last summary in the output: in-process code that
 *    prints a forged summary after the runner's own is not detected.
 *  - __mocks__ directories are protected config: mocks cannot be added or changed during a run.
 *  (Gitignored files, e.g. dist/package.json, are deleted before every gate run since R38.)
 *  - A worktree path containing glob metacharacters fails closed.
 */

/** The subset of the vitest and jest JSON reporter shapes we rely on (both share it). */
const Assertion = z.object({
  title: z.string(),
  fullName: z.string().optional(),
  status: z.string(),
  failureMessages: z.array(z.string()).nullish(),
});
const Report = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string().optional(),
      message: z.string().optional(),
      assertionResults: z.array(Assertion),
    }),
  ),
});

const NOT_RUN = new Set(["skipped", "pending", "todo", "disabled"]);
export const ONLY_PATTERNS = [/\.only\s*\(/, /\b(?:fit|fdescribe)\s*\(/];
// Static skip markers on the suite/test API. `ctx.skip()` / `t.skip()` inside a test body is dynamic.
export const SKIP_TOKEN =
  /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:skip|todo|skipIf|runIf)\b|\b(?:xit|xdescribe|xtest)\b/;
const MAX_LIST = 50;
// Row 76: not after `.`, `$` or a word character, so `/re/.test(s)` and `re.test (s)` in a
// helper are not test definitions.
const TEST_DEF_RE = /(?<![.\w$])(?:test|it|describe)(?:\.\w+)?\s*\(/;
/** Only these files are collected as tests; other files under the test globs are just hash-frozen. */
const RUNNABLE_TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const isRunnable = (p: string): boolean => RUNNABLE_TEST_RE.test(basename(p));
const HARNESS_HINT =
  "tests gate runs with a harness-owned config; project-specific vitest/jest config (aliases, plugins, setupFiles) is not supported in v0.1";
const RESOLVE_ERR_RE =
  /Failed to resolve|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|No test suite found|Failed to load url/i;

/** One assertion result from the runner's JSON report. */
export type RanTest = {
  file: string;
  title: string;
  fullName: string;
  status: string;
  failureMessages: string[];
};
type Flat = RanTest;

/** The runner did not produce a trustworthy report (timeout, no/invalid report, summary mismatch). */
export class TestRunError extends Error {
  constructor(
    readonly summary: string,
    readonly details: unknown = null,
  ) {
    super(summary);
    this.name = "TestRunError";
  }
}

export type ParsedRun = {
  tests: RanTest[];
  /** Assertion count per report file (worktree-relative), including files with zero assertions. */
  ranFiles: Map<string, number>;
  /** Files that failed to load/collect (suite failed with no assertions). */
  brokenSuites: Array<{ file: string; message: string }>;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const err = (summary: string, details: unknown = null): GateOutput => ({
  status: "error",
  summary,
  details,
});

const tail = (s: string): string => s.trim().slice(-1500);
const escapeGlob = (p: string): string => p.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Totals from the runner's own console summary. The parser and the stream are chosen by the
 * configured runner, never inferred from the output: vitest prints to stdout (the last `Tests`
 * line after the last `Test Files` line), jest to stderr (the last `Tests:` line).
 */
function summaryTotals(
  runner: string,
  out: { stdout: string; stderr: string },
): { total: number; failed: number } | undefined {
  let line: string | undefined;
  if (runner === "vitest") {
    const lines = stripAnsi(out.stdout).split("\n");
    const tf = lines.map((l) => /^\s*Test Files\s/.test(l)).lastIndexOf(true);
    if (tf < 0) return undefined;
    line = lines
      .slice(tf + 1)
      .map((l) => /^\s*Tests\s+(.+)$/.exec(l)?.[1])
      .filter((x) => x !== undefined)
      .at(-1);
  } else {
    line = stripAnsi(out.stderr)
      .split("\n")
      .map((l) => /^\s*Tests:\s+(.+)$/.exec(l)?.[1])
      .filter((x) => x !== undefined)
      .at(-1);
  }
  if (line === undefined) return undefined;
  const total = /\((\d+)\)\s*$/.exec(line)?.[1] ?? /(\d+) total/.exec(line)?.[1];
  if (total === undefined) return undefined;
  return { total: Number(total), failed: Number(/(\d+) failed/.exec(line)?.[1] ?? 0) };
}

export const testsGate: Gate = {
  name: "tests",
  category: "broken",
  async run(ctx) {
    try {
      return await runIn(ctx);
    } catch (e) {
      if (e instanceof TestRunError) return err(e.summary, e.details);
      throw e;
    }
  },
};

/**
 * Run exactly `files` (worktree-relative, runnable test files) under the harness-owned runner
 * config in the caller's (verify-profile) client, and return the parsed per-assertion results.
 * Throws TestRunError when the run produced no trustworthy report: timeout, missing or
 * unparseable report, or a report that disagrees with the runner's own console summary.
 * Shared by the tests gate and the test-writer red check, so there is one runner invocation.
 */
export async function runTestFiles(
  ctx: GateContext,
  files: string[],
  opts: { exec?: GateExec; hint?: (text: string) => string } = {},
): Promise<ParsedRun> {
  const g = opts.exec ?? new GateExec(ctx);
  const runFiles = files;
  const root = await realRootOf(ctx);
  // Private dir for the harness config and the report; always removed.
  const gateDir = await mkdtemp(join(ctx.scratch, "gate-"));
  try {
    await chmod(gateDir, 0o700);
    const outFile = join(gateDir, `tests-${randomUUID()}.json`);
    // macOS: a TMPDIR the runner may write. The sandbox drops one outside its write space, and
    // os.tmpdir()'s /tmp fallback is not writable under the macOS profile (vitest keeps its
    // module transform cache there, so runs failed with EPERM depending on cache state). Linux
    // needs none: bwrap gives every command a private, writable /tmp.
    let tmpEnv: string[] = [];
    if (process.platform === "darwin") {
      const runnerTmp = join(gateDir, "tmp");
      await mkdir(runnerTmp, { mode: 0o700 });
      tmpEnv = [ENV_BIN, `TMPDIR=${runnerTmp}`];
    }
    const argv = [
      ...tmpEnv,
      ...[...ctx.pack.testCommand, ...ctx.pack.testJsonArgs].map((a) =>
        a.replaceAll("<path>", outFile),
      ),
    ];
    if (ctx.pack.testRunner === "vitest") {
      const cfg = join(gateDir, "vitest.harness.config.mjs");
      const include = runFiles.map(escapeGlob);
      await writeFile(
        cfg,
        `export default { cacheDir: ${JSON.stringify(join(gateDir, "cache"))}, test: { include: ${JSON.stringify(include)} } };\n`,
      );
      // --update=none: never write new snapshots (the verify profile is read-only too).
      argv.push("--reporter=default", "--update=none", `--config=${cfg}`, `--root=${root}`);
    } else {
      // jest: harness-owned config; transform stays the jest default (babel-jest, whose
      // babel config files are drift-checked and protected). No setup files, reporters or
      // globalSetup are ever loaded from the project.
      const cfg = join(gateDir, "jest.harness.config.json");
      const testMatch = runFiles.map((f) => `<rootDir>/${escapeGlob(f)}`);
      // roots = the (frozen) directories of the run files, so jest's automatic `__mocks__`
      // substitution cannot pick up implementer-written mocks from elsewhere.
      const roots = [...new Set(runFiles.map((f) => `<rootDir>/${dirname(f)}`))].sort();
      await writeFile(
        cfg,
        JSON.stringify({
          rootDir: root,
          testEnvironment: "node",
          testMatch,
          roots,
          cacheDirectory: join(gateDir, "jest-cache"),
        }),
      );
      argv.push(`--config=${cfg}`, "--ci");
    }
    const r = await g.exec(argv);
    if (r.timedOut) throw new TestRunError("tests timed out");

    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      throw new TestRunError(
        `test runner wrote no JSON report (exit ${r.exitCode})${opts.hint?.(`${r.stdout}\n${r.stderr}`) ?? ""}`,
        {
          exitCode: r.exitCode,
          output: tail(`${r.stdout}\n${r.stderr}`),
        },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new TestRunError(`test runner JSON report is not valid JSON (exit ${r.exitCode})`, {
        exitCode: r.exitCode,
      });
    }
    const parsed = Report.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new TestRunError(
        `test runner JSON report has an unexpected shape: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
        { exitCode: r.exitCode },
      );
    }

    const tests: Flat[] = [];
    const brokenSuites: Array<{ file: string; message: string }> = [];
    const ranFiles = new Map<string, number>();
    for (const tr of parsed.data.testResults) {
      const file = normalize(relative(root, tr.name));
      ranFiles.set(file, (ranFiles.get(file) ?? 0) + tr.assertionResults.length);
      for (const a of tr.assertionResults) {
        tests.push({
          file,
          title: a.title,
          fullName: a.fullName ?? a.title,
          status: a.status,
          failureMessages: a.failureMessages ?? [],
        });
      }
      if (tr.status === "failed" && tr.assertionResults.length === 0) {
        brokenSuites.push({ file, message: (tr.message ?? "").slice(0, 500) });
      }
    }

    // Cross-check the report against the runner's own console summary.
    const summary = summaryTotals(ctx.pack.testRunner, r);
    const reportFailed = tests.filter((t) => t.status === "failed").length;
    const disagrees =
      summary === undefined
        ? tests.length > 0
        : summary.total !== tests.length || summary.failed !== reportFailed;
    if (disagrees) {
      throw new TestRunError("test report disagrees with the runner's console summary", {
        report: { total: tests.length, failed: reportFailed },
        summary: summary ?? null,
      });
    }
    return {
      tests,
      ranFiles,
      brokenSuites,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  } finally {
    await rm(gateDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runIn(ctx: GateContext): Promise<GateOutput> {
  {
    const g = new GateExec(ctx);
    const contract = ctx.contract;
    if (!contract) return err("no contract");
    const manifest = ctx.manifest;
    if (!manifest) return err("no frozen test manifest — coverage cannot be attributed");

    const root = await realRootOf(ctx);
    let changed: string[];
    let baseList: string[];
    try {
      changed = await changedTestFiles(ctx, g);
      baseList = await baseFileList(ctx, g);
    } catch (e) {
      return err(
        `cannot compare tests against ${ctx.baseRef}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let baseHasRunnerConfig = baseList.some(
      (p) =>
        !inNodeModules(p) &&
        /^(?:vitest|vite|vitest\.workspace|jest)\.config\.|^vitest\.workspace\./.test(basename(p)),
    );
    const hint = (text: string): string =>
      baseHasRunnerConfig && RESOLVE_ERR_RE.test(text) ? ` — ${HARNESS_HINT}` : "";
    const frozenFiles = new Set(manifest.files.map((f) => normalize(f.path)));
    // Skip/only rules cover every file changed vs baseRef, including frozen ones.
    const changedSet = new Set([...changed.map((p) => normalize(p)), ...frozenFiles]);
    // The harness runs exactly the frozen files plus the tests that existed at baseRef.
    const baseTests = baseList.filter(
      (p) => !inNodeModules(p) && matchesAnyGlob(p, ctx.policy.testGlobs),
    );
    const unrunnableTests: string[] = [];
    for (const p of baseTests.filter((x) => !isRunnable(x))) {
      try {
        if (TEST_DEF_RE.test(await baseText(ctx, g, p))) unrunnableTests.push(p);
      } catch {
        // unreadable at baseRef: not a test definition we can see
      }
    }
    const runFiles = [...new Set([...frozenFiles, ...baseTests.map((p) => normalize(p))])]
      .filter(isRunnable)
      .sort();

    // The runner must be one the project declared at baseRef (not one the worktree added).
    if (baseList.includes("package.json")) {
      try {
        const pj = JSON.parse(await baseText(ctx, g, "package.json")) as Record<string, unknown>;
        const deps = { ...(pj.dependencies as object), ...(pj.devDependencies as object) };
        if ("jest" in pj || "vitest" in pj) baseHasRunnerConfig = true;
        if (!(ctx.pack.testRunner in deps)) {
          return err(`${ctx.pack.testRunner} is not a dependency at ${ctx.baseRef}`);
        }
      } catch {
        return err(`package.json at ${ctx.baseRef} is not valid JSON`);
      }
    }

    const { tests, brokenSuites, ranFiles, exitCode, stdout, stderr } = await runTestFiles(
      ctx,
      runFiles,
      { exec: g, hint },
    );

    const frozenTests = tests.filter((t) => frozenFiles.has(t.file));
    const passingFrozen = frozenTests.filter((t) => t.status === "passed");
    const notPassed = tests.filter(
      (t) => t.status === "failed" || !(t.status === "passed" || NOT_RUN.has(t.status)),
    );

    // C2: every frozen file must have run, with every assertion passing.
    const frozenNotRun: Array<{ file: string; reason: string }> = [];
    for (const f of [...frozenFiles].filter(isRunnable)) {
      const n = ranFiles.get(f);
      if (n === undefined) frozenNotRun.push({ file: f, reason: "not in the test report" });
      else if (n === 0) frozenNotRun.push({ file: f, reason: "no tests ran" });
      else if (tests.some((t) => t.file === f && t.status !== "passed")) {
        frozenNotRun.push({ file: f, reason: "not all tests passed" });
      }
    }

    // C1: coverage comes only from frozen files.
    const uncovered = contract.criteria
      .map((c) => c.id)
      .filter((id) => !passingFrozen.some((t) => t.title.startsWith(`${id}:`)));
    const criterionIds = new Set(contract.criteria.map((c) => c.id));
    const mapping = manifest.criteriaToTests;
    const manifestProblems: Array<{ criterion: string; test: string; problem: string }> = [];
    for (const id of criterionIds) {
      if (!mapping[id] || mapping[id].length === 0) {
        manifestProblems.push({ criterion: id, test: "", problem: "no criteriaToTests entry" });
      }
    }
    for (const [crit, names] of Object.entries(mapping)) {
      if (!criterionIds.has(crit)) {
        manifestProblems.push({ criterion: crit, test: "", problem: "not a contract criterion" });
        continue;
      }
      for (const name of names) {
        const sep = name.indexOf("::");
        const wantFile = sep > 0 ? normalize(name.slice(0, sep)) : undefined;
        const want = sep > 0 ? name.slice(sep + 2) : name;
        const hits = frozenTests.filter(
          (t) =>
            (wantFile === undefined || t.file === wantFile) &&
            (t.fullName === want || t.title === want),
        );
        if (hits.length === 0) {
          manifestProblems.push({ criterion: crit, test: name, problem: "not found" });
        } else if (!hits.some((t) => t.status === "passed")) {
          manifestProblems.push({
            criterion: crit,
            test: name,
            problem: `status ${hits[0]?.status}`,
          });
        }
      }
    }

    const skipped = tests
      .filter((t) => changedSet.has(t.file) && NOT_RUN.has(t.status))
      .map((t) => ({ file: t.file, test: t.fullName, status: t.status }));

    // I3: a skip with no skip token in the file's source is dynamic (ctx.skip, runtime gate).
    const sourceCache = new Map<string, string>();
    const sourceOf = async (file: string): Promise<string> => {
      const hit = sourceCache.get(file);
      if (hit !== undefined) return hit;
      let text = "";
      try {
        if (!frozenFiles.has(file) && baseList.includes(file)) text = await baseText(ctx, g, file);
        else text = await readFile(join(root, file), "utf8");
      } catch {
        text = "";
      }
      sourceCache.set(file, text);
      return text;
    };
    const dynamicSkips: Array<{ file: string; test: string; status: string }> = [];
    for (const t of tests.filter((x) => NOT_RUN.has(x.status))) {
      if (!SKIP_TOKEN.test(await sourceOf(t.file))) {
        dynamicSkips.push({ file: t.file, test: t.fullName, status: t.status });
      }
    }

    const only: string[] = [];
    for (const f of changedSet) {
      let src: string;
      try {
        src = await readFile(join(root, f), "utf8");
      } catch {
        continue; // deleted; reported by frozen-tests
      }
      if (ONLY_PATTERNS.some((p) => p.test(src))) only.push(f);
    }

    const reasons: string[] = [];
    const details: Record<string, unknown> = { exitCode: exitCode, totalTests: tests.length };
    if (tests.length === 0) reasons.push("zero tests ran");
    if (notPassed.length > 0) {
      reasons.push(`${notPassed.length} test(s) failed`);
      details.failingTests = notPassed
        .slice(0, MAX_LIST)
        .map((t) => ({ file: t.file, test: t.fullName, status: t.status }));
    }
    if (brokenSuites.length > 0) {
      reasons.push(`${brokenSuites.length} test file(s) failed to run`);
      details.failedSuites = brokenSuites.slice(0, MAX_LIST);
    }
    if (unrunnableTests.length > 0) {
      reasons.unshift(`test file not runnable under harness config: ${unrunnableTests.join(", ")}`);
      details.unrunnableTests = unrunnableTests;
    }
    if (frozenNotRun.length > 0) {
      reasons.push(`${frozenNotRun.length} frozen test file(s) did not run cleanly`);
      details.frozenNotRun = frozenNotRun;
    }
    if (uncovered.length > 0) {
      reasons.push(`uncovered criteria: ${uncovered.join(", ")}`);
      details.uncoveredCriteria = uncovered;
    }
    if (manifestProblems.length > 0) {
      reasons.push(`${manifestProblems.length} criteriaToTests problem(s)`);
      details.manifestTests = manifestProblems.slice(0, MAX_LIST);
    }
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} skipped/todo test(s) in changed files`);
      details.skippedTests = skipped.slice(0, MAX_LIST);
    }
    if (dynamicSkips.length > 0) {
      reasons.push(`${dynamicSkips.length} dynamic skip(s)`);
      details.dynamicSkips = dynamicSkips.slice(0, MAX_LIST);
    }
    if (only.length > 0) {
      reasons.push(`.only in changed test file(s): ${only.join(", ")}`);
      details.onlyFiles = only;
    }
    if (exitCode !== 0) reasons.push(`test command exited ${exitCode}`);

    if (reasons.length > 0) {
      const all = `${stdout}\n${stderr}\n${brokenSuites.map((b) => b.message).join("\n")}`;
      return { status: "fail", summary: reasons.join("; ") + hint(all), details };
    }
    return {
      status: "pass",
      summary: `${tests.filter((t) => t.status === "passed").length} test(s) passed; ${contract.criteria.length} criteria covered`,
      details: null,
    };
  }
}
