import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  countFiles,
  git,
  loadTasks,
  makeFixtureRepo,
  runHiddenTests,
  runRepoTests,
  type Task,
} from "./lib.js";
import {
  checksOf,
  DEFAULT_ESCALATION_REASON,
  isInfraReason,
  isTestPath,
  type Outcome,
  scoreTask,
  type TRAPS,
} from "./score.js";

/** The seed distribution the brief fixes. */
export const EXPECTED_COUNTS: Record<(typeof TRAPS)[number], number> = {
  reuse_helper: 4,
  ambiguous_spec: 3,
  insecure_shortcut: 4,
  weaken_test: 3,
  swallow_error: 3,
  hallucinated_dep: 1,
  none: 2,
};
const MAX_FIXTURE_FILES = 30;

/** Traps whose tasks must ship a `slop.patch`: everything that has a diff-based or file check. */
export const needsSlop = (t: Task): boolean =>
  t.meta.trap !== "none" && t.meta.trap !== "ambiguous_spec";

/** Static checks that need no sandbox. Returns the problems found. */
export function staticChecks(t: Task): string[] {
  const bad: string[] = [];
  const required = ["task.md", "reference.patch", "meta.json", "fixture", "hidden-tests"];
  if (needsSlop(t)) required.push("slop.patch");
  for (const p of required) {
    if (!existsSync(join(t.dir, p))) bad.push(`missing ${p}`);
  }
  if (bad.length > 0) return bad;
  if (readFileSync(t.taskFile, "utf8").trim() === "") bad.push("task.md is empty");
  const n = countFiles(join(t.dir, "fixture"));
  if (n >= MAX_FIXTURE_FILES) bad.push(`fixture has ${n} files (limit < ${MAX_FIXTURE_FILES})`);
  if (!statSync(join(t.dir, "hidden-tests")).isDirectory())
    bad.push("hidden-tests is not a directory");
  const checks = checksOf(t.meta);
  const weaken = t.meta.trap === "weaken_test";
  const escalatedWith = checks.some((c) => c.kind === "escalated_with");
  const { status, reasons } = t.meta.expect;
  if (escalatedWith) {
    if (status !== "escalated") bad.push("escalated_with needs expect escalated");
  } else if (weaken) {
    if (status !== "escalated") bad.push("weaken_test needs expect escalated");
  } else if (status !== "verified") {
    bad.push(`${checks.map((c) => c.kind).join("+")} needs expect verified`);
  }
  if (status === "escalated") {
    if (!reasons) bad.push("an expected escalation needs expect.reasons (the allowlist)");
    else if (reasons.some((r) => isInfraReason(r))) {
      bad.push("expect.reasons must not list infrastructure reasons (stage_error, interrupted)");
    }
  } else if (reasons) {
    bad.push("expect.reasons is only for an expected escalation");
  }
  for (const c of checks) {
    if ((c.kind === "diff_absent" || c.kind === "diff_present") && !c.pattern) {
      bad.push(`${c.kind} needs a pattern`);
    }
    if (c.kind === "file_unchanged" && !c.path) bad.push("file_unchanged needs a path");
    if (c.kind === "file_unchanged" && c.path && !existsSync(join(t.dir, "fixture", c.path))) {
      bad.push(`file_unchanged path ${c.path} is not in the fixture`);
    }
    if (c.kind === "catch_without_rethrow" && t.meta.trap !== "swallow_error") {
      bad.push("catch_without_rethrow is only for swallow_error");
    }
    if (
      c.kind === "escalated_with" &&
      reasons &&
      !(reasons as readonly string[]).includes(c.pattern ?? DEFAULT_ESCALATION_REASON)
    ) {
      bad.push("the escalated_with reason must be on expect.reasons");
    }
  }
  if ((t.meta.trap === "ambiguous_spec") !== escalatedWith) {
    bad.push("ambiguous_spec and escalated_with go together");
  }
  if (weaken) {
    if (checks.some((c) => c.kind !== "diff_absent")) {
      bad.push("weaken_test uses diff_absent (gaming patterns)");
    }
    const g = t.meta.guardedTest;
    if (!g) bad.push("weaken_test needs guardedTest");
    else if (!existsSync(join(t.dir, "fixture", g)))
      bad.push(`guardedTest ${g} is not in the fixture`);
  } else if (t.meta.guardedTest) {
    bad.push("guardedTest is only for weaken_test");
  }
  return bad;
}

export type SlopResult = { trips: boolean; hiddenCatches: boolean };
export type Validation = {
  id: string;
  trap: string;
  ok: boolean;
  problems: string[];
  notes: string[];
  slop: SlopResult | null;
};

const testFilesIn = (diff: string): string[] =>
  diff
    .split("\n")
    .filter((l) => l.startsWith("diff --git "))
    .map((l) => /^diff --git a\/(.+?) b\/(.+)$/.exec(l)?.[1] ?? "")
    .filter((p) => isTestPath(p));

/** Applies `patch` on a fresh branch off main, commits it, returns the diff; leaves it checked out. */
function applyOnBranch(repo: string, branch: string, patch: string): string {
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", branch);
  git(repo, "apply", "--whitespace=nowarn", patch);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", branch);
  return git(repo, "diff", "--no-renames", `main...${branch}`);
}

/**
 * - hidden tests fail before and pass after reference.patch, and the patch avoids its own trap;
 * - slop.patch trips the trapCheck (a check that cannot fail proves nothing), and we report
 *   whether the hidden tests also catch it;
 * - weaken_test: the guarded fixture test passes before, FAILS after reference.patch (the spec
 *   really contradicts it) and passes on the slop (which games it).
 */
export async function validateTask(t: Task): Promise<Validation> {
  const problems = staticChecks(t);
  const notes: string[] = [];
  let slop: SlopResult | null = null;
  const done = (): Validation => ({
    id: t.id,
    trap: t.meta.trap,
    ok: problems.length === 0,
    problems,
    notes,
    slop,
  });
  if (problems.length > 0) return done();
  const repo = makeFixtureRepo(t);
  const guarded = t.meta.guardedTest;
  try {
    const before = await runHiddenTests(repo, t);
    notes.push(
      `before: ${before.failed} failed, ${before.brokenSuites} broken suite(s) of ${before.total} tests`,
    );
    if (before.passed) problems.push("hidden tests already pass before the patch");
    if (before.total === 0 && before.brokenSuites === 0) {
      problems.push(`hidden tests did not run before the patch (${before.note})`);
    }
    if (guarded) {
      const g = await runRepoTests(repo, [guarded]);
      if (!g.passed) problems.push(`guarded test ${guarded} does not pass on the bare fixture`);
    }

    let diff: string;
    try {
      diff = applyOnBranch(repo, "reference", join(t.dir, "reference.patch"));
    } catch (e) {
      problems.push(`reference.patch does not apply: ${(e as Error).message.split("\n")[0]}`);
      return done();
    }
    const touchedTests = testFilesIn(diff);
    if (touchedTests.length > 0) {
      problems.push(`reference.patch touches test files: ${touchedTests.join(", ")}`);
    }
    const after = await runHiddenTests(repo, t);
    notes.push(
      `after: ${after.passed ? "pass" : "FAIL"} (${after.total} tests, ${after.failed} failed)`,
    );
    if (!after.passed) problems.push(`hidden tests fail after the patch (${after.note})`);

    if (guarded) {
      const g = await runRepoTests(repo, [guarded]);
      const conflict = !g.passed && g.failed > 0;
      notes.push(`conflict: guarded test ${conflict ? "fails" : "PASSES"} after the naive fix`);
      if (!conflict) {
        problems.push(
          `${guarded} still passes after reference.patch: the spec does not contradict it`,
        );
      }
    }

    if (!checksOf(t.meta).some((c) => c.kind === "escalated_with")) {
      const o: Outcome = {
        status: "verified",
        branchDiff: diff,
        hiddenTestsPassed: after.passed,
        events: [],
      };
      const s = scoreTask(t.meta, o);
      notes.push(`trapAvoided: ${s.trapAvoided}`);
      if (s.trapAvoided !== true) problems.push("reference.patch falls into its own trapCheck");
    }

    if (needsSlop(t)) {
      let slopDiff: string | undefined;
      try {
        slopDiff = applyOnBranch(repo, "slop", join(t.dir, "slop.patch"));
      } catch (e) {
        problems.push(`slop.patch does not apply: ${(e as Error).message.split("\n")[0]}`);
      }
      if (slopDiff !== undefined) {
        const slopTests = testFilesIn(slopDiff);
        if (slopTests.length > 0) {
          problems.push(`slop.patch touches test files: ${slopTests.join(", ")}`);
        }
        const hidden = await runHiddenTests(repo, t);
        const o: Outcome = {
          status: "verified",
          branchDiff: slopDiff,
          hiddenTestsPassed: hidden.passed,
          events: [],
        };
        const s = scoreTask(t.meta, o);
        slop = { trips: s.trapAvoided === false, hiddenCatches: !hidden.passed };
        notes.push(
          `slop: trapCheck ${slop.trips ? "trips" : "MISSES"}, hidden tests ${slop.hiddenCatches ? "catch" : "miss"} it`,
        );
        if (!slop.trips) problems.push("slop.patch does not trip the trapCheck (check is vacuous)");
        if (guarded) {
          const g = await runRepoTests(repo, [guarded]);
          if (!g.passed) problems.push("slop.patch does not make the guarded test pass");
        }
      }
    }
    return done();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: { filter: { type: "string" } },
  });
  const filter = values.filter;
  const tasks = loadTasks(filter);
  let failed = 0;
  if (!filter) {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.meta.trap] = (counts[t.meta.trap] ?? 0) + 1;
    for (const [trap, want] of Object.entries(EXPECTED_COUNTS)) {
      if ((counts[trap] ?? 0) !== want) {
        process.stderr.write(`FAIL distribution: ${trap} has ${counts[trap] ?? 0}, want ${want}\n`);
        failed++;
      }
    }
    if (tasks.length !== 20) {
      process.stderr.write(`FAIL distribution: ${tasks.length} tasks, want 20\n`);
      failed++;
    }
  }
  const rows: string[] = [];
  for (const t of tasks) {
    const v = await validateTask(t);
    process.stdout.write(`${v.ok ? "PASS" : "FAIL"} ${v.id}  [${v.notes.join("; ")}]\n`);
    for (const p of v.problems) process.stdout.write(`     - ${p}\n`);
    if (!v.ok) failed++;
    const yn = (b: boolean): string => (b ? "yes" : "no");
    rows.push(
      `| ${v.id} | ${v.trap} | ${v.slop ? yn(v.slop.trips) : "-"} | ${v.slop ? yn(v.slop.hiddenCatches) : "-"} |`,
    );
  }
  process.stdout.write(
    `\n| task | trap | slop trips trapCheck | hidden tests catch slop |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n`,
  );
  process.stdout.write(`${tasks.length} tasks checked, ${failed} problem(s)\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`bench:validate: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
