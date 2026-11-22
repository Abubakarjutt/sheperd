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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY } from "@rewire/policy";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { type Meta, MetaSchema } from "./score.js";

const here = dirname(fileURLToPath(import.meta.url));
/** `bench/` (this file runs from bench/dist/). */
export const BENCH_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(BENCH_ROOT, "..");
export const TASKS_DIR = join(BENCH_ROOT, "tasks");
export const CLI_MAIN = join(REPO_ROOT, "packages/cli/dist/main.js");
/** Fixtures resolve vitest and typescript through this (a symlink target, never installed per task). */
export const BENCH_MODULES = join(BENCH_ROOT, "node_modules");
export const HIDDEN_DIR_NAME = "__bench_hidden__";

export type Task = { id: string; dir: string; meta: Meta; taskFile: string };

/** Every task under bench/tasks, schema-checked, in id order; `filter` is a comma list of ids. */
export function loadTasks(filter?: string): Task[] {
  const want = filter
    ? new Set(
        filter
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : undefined;
  const ids = readdirSync(TASKS_DIR)
    .filter((d) => statSync(join(TASKS_DIR, d)).isDirectory())
    .sort();
  if (want) {
    const missing = [...want].filter((w) => !ids.includes(w));
    if (missing.length > 0) throw new Error(`unknown task id(s): ${missing.join(", ")}`);
  }
  return ids
    .filter((id) => !want || want.has(id))
    .map((id) => {
      const dir = join(TASKS_DIR, id);
      const meta = MetaSchema.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
      if (meta.id !== id) throw new Error(`${id}/meta.json has id "${meta.id}"`);
      return { id, dir, meta, taskFile: join(dir, "task.md") };
    });
}

/** The host environment without any GIT_* variable. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  }
  return env;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

/**
 * A temp git repo (branch main, one commit) holding the task's fixture. node_modules is a
 * gitignored symlink to bench/node_modules: no install per task. linkNodeModules in the
 * pipeline realpaths `<repo>/node_modules` and links when that is a directory, so a symlink works.
 */
export function makeFixtureRepo(task: Task): string {
  if (!existsSync(join(BENCH_MODULES, "vitest"))) {
    throw new Error("bench/node_modules is missing vitest: run pnpm install");
  }
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `rewire-bench-${task.id}-`)));
  cpSync(join(task.dir, "fixture"), repo, { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules\n.rewire/\n");
  // The pipeline picks `<pm> exec vitest` from the lockfile; without one it would use npx, which
  // cannot run in the no-network sandbox. The lockfile lists no packages: nothing is installed.
  const lock = join(repo, "pnpm-lock.yaml");
  if (!existsSync(lock)) writeFileSync(lock, "lockfileVersion: '9.0'\n");
  symlinkSync(BENCH_MODULES, join(repo, "node_modules"), "dir");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "bench@example.invalid");
  git(repo, "config", "user.name", "rewire-bench");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

export type HiddenResult = {
  passed: boolean;
  total: number;
  failed: number;
  /** Test files that failed to load (missing module, syntax error). */
  brokenSuites: number;
  note: string;
};

function vitestEntry(): string {
  const req = createRequire(join(BENCH_ROOT, "package.json"));
  return join(dirname(req.resolve("vitest/package.json")), "vitest.mjs");
}

/**
 * Run the task's hidden tests against the checked-out tree in `repo`, inside rewire-sandbox with
 * the verify (no-network, read-only apart from a scratch dir) profile. Never unsandboxed: a
 * missing binary throws. The tests are copied to `__bench_hidden__/` and run with a config written
 * outside the tree, so nothing on the branch (vitest config, setup files, its own tests) can
 * shadow or skip them.
 */
export function runHiddenTests(repo: string, task: Task): Promise<HiddenResult> {
  return runVitest(repo, [`${HIDDEN_DIR_NAME}/**/*.test.ts`], join(task.dir, "hidden-tests"));
}

/**
 * Run existing test files of the repo itself (e.g. a weaken_test fixture's guarded test) with the
 * same sandbox and config as the hidden tests. `paths` are repo-relative.
 */
export function runRepoTests(repo: string, paths: string[]): Promise<HiddenResult> {
  return runVitest(repo, paths);
}

async function runVitest(
  repo: string,
  include: string[],
  copyHiddenFrom?: string,
): Promise<HiddenResult> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rewire-bench-scratch-")));
  const hidden = join(repo, HIDDEN_DIR_NAME);
  let client: SandboxClient | undefined;
  // The verify profile only writes to scratch; the sandbox passes TMPDIR through when it is
  // inside scratch, so vite and the tests get a writable temp dir.
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    client = new SandboxClient(profileFor("verify", repo, DEFAULT_POLICY, scratch)); // throws binary_missing
    rmSync(hidden, { recursive: true, force: true });
    if (copyHiddenFrom) cpSync(copyHiddenFrom, hidden, { recursive: true });
    const cfg = join(scratch, "vitest.bench.config.mjs");
    writeFileSync(
      cfg,
      `export default ${JSON.stringify({
        root: repo,
        cacheDir: join(scratch, "cache"),
        test: {
          include,
          exclude: ["**/node_modules/**"],
          testTimeout: 15000,
          passWithNoTests: false,
        },
      })};\n`,
    );
    const out = join(scratch, "report.json");
    const r = await client.exec(
      [
        process.execPath,
        vitestEntry(),
        "run",
        `--config=${cfg}`,
        `--root=${repo}`,
        "--reporter=json",
        `--outputFile=${out}`,
        "--update=none",
      ],
      { timeoutMs: 180_000, cwd: repo },
    );
    if (r.timedOut) return { passed: false, total: 0, failed: 0, brokenSuites: 0, note: "timeout" };
    let json: {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numFailedTestSuites?: number;
      numPendingTests?: number;
      numTodoTests?: number;
    };
    try {
      json = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      return {
        passed: false,
        total: 0,
        failed: 0,
        brokenSuites: 0,
        note: `no JSON report (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(-300)}`,
      };
    }
    const total = json.numTotalTests ?? 0;
    const passedN = json.numPassedTests ?? 0;
    const brokenSuites = json.numFailedTestSuites ?? 0;
    // Every collected test must pass: skipped/todo tests and unloadable files never count.
    const passed = r.exitCode === 0 && total > 0 && passedN === total && brokenSuites === 0;
    return {
      passed,
      total,
      failed: json.numFailedTests ?? 0,
      brokenSuites,
      note: passed
        ? ""
        : `exit ${r.exitCode}: ${
            (json as { testResults?: { message?: string }[] }).testResults
              ?.map((t) => t.message ?? "")
              .join(" ")
              .trim()
              .slice(0, 300) ?? ""
          }`,
    };
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    client?.dispose();
    rmSync(hidden, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Total tokens from the evidence report's Cost table (`| role | input | output |`), else null. */
export function tokensFromReport(reportPath: string): number | null {
  let md: string;
  try {
    md = readFileSync(reportPath, "utf8");
  } catch {
    return null;
  }
  const at = md.search(/\|\s*role\s*\|\s*input tokens\s*\|/);
  if (at < 0) return null;
  let total = 0;
  let rows = 0;
  for (const line of md.slice(at).split("\n").slice(2)) {
    const m = /^\|\s*[\w-]+\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/.exec(line);
    if (!m) break;
    total += Number(m[1]) + Number(m[2]);
    rows++;
  }
  return rows > 0 ? total : null;
}

export function mkdirp(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** The escalation's "Details:" bullet lines from an evidence report ([] when absent). */
export function escalationDetailsFromReport(reportPath: string): string[] {
  let md: string;
  try {
    md = readFileSync(reportPath, "utf8");
  } catch {
    return [];
  }
  const at = md.indexOf("\nDetails:\n");
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of md.slice(at + "\nDetails:\n".length).split("\n")) {
    if (!line.startsWith("- ")) break;
    out.push(line.slice(2));
  }
  return out;
}
