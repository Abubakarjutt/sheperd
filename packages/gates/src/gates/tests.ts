import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, normalize, relative } from "node:path";
import { z } from "zod";
import type { Gate, GateContext, GateOutput } from "../types.js";
import {
  baseFileList,
  baseText,
  changedTestFiles,
  GateExec,
  inNodeModules,
  matchesAnyGlob,
  realRootOf,
} from "./shared.js";

/*
 * KNOWN_LIMITS (for the T21 evidence report):
 *  - The tests run in the same process as the code under test. Tested code that patches both the
 *    JSON reporter and the stdout summary in-process can still forge a result. We detect the
 *    cheap forgery (report edited after the fact, or disagreeing with the runner's own summary
 *    line) but do not try to isolate the reporter.
 *  - vitest runs with a harness-owned config: no user setupFiles/globalSetup, plugins, aliases
 *    or tsconfig-paths from the project's vitest/vite config. A project that needs them fails
 *    closed (tests fail to run). Reproducing baseRef's config in-harness is not attempted.
 *  - jest has reduced guarantees: it keeps the project's own config (drift against baseRef is
 *    checked by the frozen-tests gate) and is pinned with --runTestsByPath instead.
 */

/** The subset of the vitest and jest JSON reporter shapes we rely on (both share it). */
const Assertion = z.object({
  title: z.string(),
  fullName: z.string().optional(),
  status: z.string(),
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
const ONLY_PATTERNS = [/\.only\s*\(/, /\b(?:fit|fdescribe)\s*\(/];
// Static skip markers on the suite/test API. `ctx.skip()` / `t.skip()` inside a test body is dynamic.
const SKIP_TOKEN =
  /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:skip|todo|skipIf|runIf)\b|\b(?:xit|xdescribe|xtest)\b/;
const MAX_LIST = 50;
/** Only these files are collected as tests; other files under the test globs are just hash-frozen. */
const RUNNABLE_TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const isRunnable = (p: string): boolean => RUNNABLE_TEST_RE.test(basename(p));
const HARNESS_HINT =
  "tests gate runs with a harness-owned config; project-specific vitest/jest config (aliases, plugins, setupFiles) is not supported in v0.1";
const RESOLVE_ERR_RE =
  /Failed to resolve|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|No test suite found|Failed to load|SyntaxError|ReferenceError/i;

type Flat = { file: string; title: string; fullName: string; status: string };

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
 * Totals from the runner's own console summary: vitest `Tests  1 failed | 2 passed (3)` (the first
 * `Tests` line after the last `Test Files` line, so test output cannot imitate it earlier) or
 * jest `Tests: 1 failed, 2 passed, 3 total` (the last such line).
 */
function summaryTotals(text: string): { total: number; failed: number } | undefined {
  const lines = stripAnsi(text).split("\n");
  let line: string | undefined;
  const tf = lines.map((l) => /^\s*Test Files\s/.test(l)).lastIndexOf(true);
  if (tf >= 0) {
    line = lines
      .slice(tf + 1)
      .map((l) => /^\s*Tests\s+(.+)$/.exec(l)?.[1])
      .find((x) => x !== undefined);
  } else {
    line = lines
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
    // Private dir for the harness config and the report; always removed.
    const gateDir = await mkdtemp(join(ctx.scratch, "gate-"));
    try {
      await chmod(gateDir, 0o700);
      return await runIn(ctx, gateDir);
    } finally {
      await rm(gateDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

async function runIn(ctx: GateContext, gateDir: string): Promise<GateOutput> {
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
    const baseHasRunnerConfig = baseList.some(
      (p) => !inNodeModules(p) && /^(?:vitest|vite|jest)\.config\./.test(basename(p)),
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
    const runFiles = [...new Set([...frozenFiles, ...baseTests.map((p) => normalize(p))])]
      .filter(isRunnable)
      .sort();

    // The runner must be one the project declared at baseRef (not one the worktree added).
    if (baseList.includes("package.json")) {
      try {
        const pj = JSON.parse(await baseText(ctx, g, "package.json")) as Record<string, unknown>;
        const deps = { ...(pj.dependencies as object), ...(pj.devDependencies as object) };
        if (!(ctx.pack.testRunner in deps)) {
          return err(`${ctx.pack.testRunner} is not a dependency at ${ctx.baseRef}`);
        }
      } catch {
        return err(`package.json at ${ctx.baseRef} is not valid JSON`);
      }
    }

    const outFile = join(gateDir, `tests-${randomUUID()}.json`);
    const argv = [...ctx.pack.testCommand, ...ctx.pack.testJsonArgs].map((a) =>
      a.replaceAll("<path>", outFile),
    );
    if (ctx.pack.testRunner === "vitest") {
      const cfg = join(gateDir, "vitest.harness.config.mjs");
      const include = runFiles.map(escapeGlob);
      await writeFile(
        cfg,
        `export default { cacheDir: ${JSON.stringify(join(gateDir, "cache"))}, test: { include: ${JSON.stringify(include)} } };\n`,
      );
      argv.push("--reporter=default", `--config=${cfg}`, `--root=${root}`);
    } else {
      // jest: harness-owned config; transform stays the jest default (babel-jest, whose
      // babel config files are drift-checked and protected). No setup files, reporters or
      // globalSetup are ever loaded from the project.
      const cfg = join(gateDir, "jest.harness.config.json");
      const testMatch = runFiles.map((f) => `<rootDir>/${escapeGlob(f)}`);
      await writeFile(cfg, JSON.stringify({ rootDir: root, testEnvironment: "node", testMatch }));
      argv.push(`--config=${cfg}`);
    }
    const r = await g.exec(argv);
    if (r.timedOut) return err("tests timed out");

    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      return err(
        `test runner wrote no JSON report (exit ${r.exitCode})${hint(`${r.stdout}\n${r.stderr}`)}`,
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
      return err(`test runner JSON report is not valid JSON (exit ${r.exitCode})`, {
        exitCode: r.exitCode,
      });
    }
    const parsed = Report.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(
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
        tests.push({ file, title: a.title, fullName: a.fullName ?? a.title, status: a.status });
      }
      if (tr.status === "failed" && tr.assertionResults.length === 0) {
        brokenSuites.push({ file, message: (tr.message ?? "").slice(0, 500) });
      }
    }

    // Cross-check the report against the runner's own console summary.
    const summary = summaryTotals(`${r.stdout}\n${r.stderr}`);
    const reportFailed = tests.filter((t) => t.status === "failed").length;
    const disagrees =
      summary === undefined
        ? tests.length > 0
        : summary.total !== tests.length || summary.failed !== reportFailed;
    if (disagrees) {
      return err("test report disagrees with the runner's console summary", {
        report: { total: tests.length, failed: reportFailed },
        summary: summary ?? null,
      });
    }

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
    const details: Record<string, unknown> = { exitCode: r.exitCode, totalTests: tests.length };
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
    if (r.exitCode !== 0) reasons.push(`test command exited ${r.exitCode}`);

    if (reasons.length > 0) {
      const all = `${r.stdout}\n${r.stderr}\n${brokenSuites.map((b) => b.message).join("\n")}`;
      return { status: "fail", summary: reasons.join("; ") + hint(all), details };
    }
    return {
      status: "pass",
      summary: `${tests.filter((t) => t.status === "passed").length} test(s) passed; ${contract.criteria.length} criteria covered`,
      details: null,
    };
  }
}
