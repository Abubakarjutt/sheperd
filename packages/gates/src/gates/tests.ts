import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";
import { z } from "zod";
import type { Gate, GateOutput } from "../types.js";
import { changedTestFiles, GateExec } from "./shared.js";

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
const MAX_LIST = 50;

type Flat = { file: string; title: string; fullName: string; status: string };

const err = (summary: string, details: unknown = null): GateOutput => ({
  status: "error",
  summary,
  details,
});

const tail = (s: string): string => s.trim().slice(-1500);

export const testsGate: Gate = {
  name: "tests",
  category: "broken",
  async run(ctx) {
    const contract = ctx.contract;
    if (!contract) return err("no contract");

    const g = new GateExec(ctx);
    let changed: string[];
    try {
      changed = await changedTestFiles(ctx, g);
    } catch (e) {
      return err(
        `cannot compare tests against ${ctx.baseRef}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Skip/only rules cover every file changed vs baseRef, including frozen ones.
    const changedSet = new Set(
      [...changed, ...(ctx.manifest?.files.map((f) => f.path) ?? [])].map((p) => normalize(p)),
    );

    const outFile = join(ctx.scratch, `tests-${randomUUID()}.json`);
    const argv = [...ctx.pack.testCommand, ...ctx.pack.testJsonArgs].map((a) =>
      a.replaceAll("<path>", outFile),
    );
    const r = await g.exec(argv);
    if (r.timedOut) return err("tests timed out");

    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      return err(`test runner wrote no JSON report (exit ${r.exitCode})`, {
        exitCode: r.exitCode,
        output: tail(`${r.stdout}\n${r.stderr}`),
      });
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
    for (const tr of parsed.data.testResults) {
      const file = normalize(relative(ctx.worktree, tr.name));
      for (const a of tr.assertionResults) {
        tests.push({ file, title: a.title, fullName: a.fullName ?? a.title, status: a.status });
      }
      if (tr.status === "failed" && tr.assertionResults.length === 0) {
        brokenSuites.push({ file, message: (tr.message ?? "").slice(0, 500) });
      }
    }

    const passing = tests.filter((t) => t.status === "passed");
    const notPassed = tests.filter(
      (t) => t.status === "failed" || !(t.status === "passed" || NOT_RUN.has(t.status)),
    );
    const uncovered = contract.criteria
      .map((c) => c.id)
      .filter((id) => !passing.some((t) => t.title.startsWith(`${id}:`)));

    const manifestProblems: Array<{ criterion: string; test: string; problem: string }> = [];
    for (const [crit, names] of Object.entries(ctx.manifest?.criteriaToTests ?? {})) {
      for (const name of names) {
        const hits = tests.filter((t) => t.fullName === name || t.title === name);
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

    const only: string[] = [];
    for (const f of changedSet) {
      let src: string;
      try {
        src = await readFile(join(ctx.worktree, f), "utf8");
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
    if (uncovered.length > 0) {
      reasons.push(`uncovered criteria: ${uncovered.join(", ")}`);
      details.uncoveredCriteria = uncovered;
    }
    if (manifestProblems.length > 0) {
      reasons.push(`${manifestProblems.length} frozen criterion test(s) missing or not passing`);
      details.manifestTests = manifestProblems.slice(0, MAX_LIST);
    }
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} skipped/todo test(s) in changed files`);
      details.skippedTests = skipped.slice(0, MAX_LIST);
    }
    if (only.length > 0) {
      reasons.push(`.only in changed test file(s): ${only.join(", ")}`);
      details.onlyFiles = only;
    }
    if (r.exitCode !== 0) reasons.push(`test command exited ${r.exitCode}`);

    if (reasons.length > 0) return { status: "fail", summary: reasons.join("; "), details };
    return {
      status: "pass",
      summary: `${passing.length} test(s) passed; ${contract.criteria.length} criteria covered`,
      details: null,
    };
  },
};
