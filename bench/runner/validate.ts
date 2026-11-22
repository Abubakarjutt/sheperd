import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countFiles, git, loadTasks, makeFixtureRepo, runHiddenTests, type Task } from "./lib.js";
import { isTestPath, type Outcome, scoreTask, type TRAPS } from "./score.js";

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

/** Static checks that need no sandbox. Returns the problems found. */
export function staticChecks(t: Task): string[] {
  const bad: string[] = [];
  for (const p of ["task.md", "reference.patch", "meta.json", "fixture", "hidden-tests"]) {
    if (!existsSync(join(t.dir, p))) bad.push(`missing ${p}`);
  }
  if (bad.length > 0) return bad;
  if (readFileSync(t.taskFile, "utf8").trim() === "") bad.push("task.md is empty");
  const n = countFiles(join(t.dir, "fixture"));
  if (n >= MAX_FIXTURE_FILES) bad.push(`fixture has ${n} files (limit < ${MAX_FIXTURE_FILES})`);
  if (!statSync(join(t.dir, "hidden-tests")).isDirectory())
    bad.push("hidden-tests is not a directory");
  const c = t.meta.trapCheck;
  if (c.kind === "escalated_with") {
    if (t.meta.expect.status !== "escalated") bad.push("escalated_with needs expect escalated");
  } else if (t.meta.expect.status !== "verified") {
    bad.push(`${c.kind} needs expect verified`);
  }
  if ((c.kind === "diff_absent" || c.kind === "diff_present") && !c.pattern) {
    bad.push(`${c.kind} needs a pattern`);
  }
  if (c.kind === "file_unchanged" && !c.path) bad.push("file_unchanged needs a path");
  if (c.kind === "file_unchanged" && c.path && !existsSync(join(t.dir, "fixture", c.path))) {
    bad.push(`file_unchanged path ${c.path} is not in the fixture`);
  }
  if ((t.meta.trap === "ambiguous_spec") !== (c.kind === "escalated_with")) {
    bad.push("ambiguous_spec and escalated_with go together");
  }
  return bad;
}

export type Validation = { id: string; ok: boolean; problems: string[]; notes: string[] };

/** Hidden tests fail before, pass after reference.patch; the patch avoids its own trap. */
export async function validateTask(t: Task): Promise<Validation> {
  const problems = staticChecks(t);
  const notes: string[] = [];
  if (problems.length > 0) return { id: t.id, ok: false, problems, notes };
  const repo = makeFixtureRepo(t);
  try {
    const before = await runHiddenTests(repo, t);
    notes.push(
      `before: ${before.failed} failed, ${before.brokenSuites} broken suite(s) of ${before.total} tests`,
    );
    if (before.passed) problems.push("hidden tests already pass before the patch");
    if (before.total === 0 && before.brokenSuites === 0) {
      problems.push(`hidden tests did not run before the patch (${before.note})`);
    }

    git(repo, "checkout", "-q", "-b", "reference");
    try {
      git(repo, "apply", "--whitespace=nowarn", join(t.dir, "reference.patch"));
    } catch (e) {
      problems.push(`reference.patch does not apply: ${(e as Error).message.split("\n")[0]}`);
      return { id: t.id, ok: false, problems, notes };
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "reference");
    const diff = git(repo, "diff", "--no-renames", "main...reference");

    const touchedTests = diff
      .split("\n")
      .filter((l) => l.startsWith("diff --git "))
      .map((l) => /^diff --git a\/(.+?) b\/(.+)$/.exec(l)?.[1] ?? "")
      .filter((p) => isTestPath(p));
    if (touchedTests.length > 0) {
      problems.push(`reference.patch touches test files: ${touchedTests.join(", ")}`);
    }

    const after = await runHiddenTests(repo, t);
    notes.push(
      `after: ${after.passed ? "pass" : "FAIL"} (${after.total} tests, ${after.failed} failed)`,
    );
    if (!after.passed) problems.push(`hidden tests fail after the patch (${after.note})`);

    if (t.meta.trapCheck.kind !== "escalated_with") {
      const o: Outcome = {
        status: "verified",
        branchDiff: diff,
        hiddenTestsPassed: after.passed,
        events: [],
      };
      const s = scoreTask(t.meta, o);
      notes.push(`trapAvoided: ${s.trapAvoided}`);
      if (!s.trapAvoided) problems.push("reference.patch falls into its own trapCheck");
    }
    return { id: t.id, ok: problems.length === 0, problems, notes };
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(repo, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const fi = args.indexOf("--filter");
  const filter = fi >= 0 ? args[fi + 1] : undefined;
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
  for (const t of tasks) {
    const v = await validateTask(t);
    process.stdout.write(`${v.ok ? "PASS" : "FAIL"} ${v.id}  [${v.notes.join("; ")}]\n`);
    for (const p of v.problems) process.stdout.write(`     - ${p}\n`);
    if (!v.ok) failed++;
  }
  process.stdout.write(
    `${tasks.length - failed >= 0 ? tasks.length : 0} tasks checked, ${failed} problem(s)\n`,
  );
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
