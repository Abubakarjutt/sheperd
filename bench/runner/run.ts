import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RunEvent } from "@rewire/core";
import {
  BENCH_ROOT,
  CLI_MAIN,
  git,
  loadTasks,
  makeFixtureRepo,
  runHiddenTests,
  type Task,
  tokensFromReport,
} from "./lib.js";
import { type Outcome, type Score, scoreTask } from "./score.js";

export type TaskResult = {
  id: string;
  trap: string;
  expect: "verified" | "escalated";
  /** rewire's exit code (0 verified, 2 escalated, 1 crash); null when it never exited. */
  exitCode: number | null;
  status: "verified" | "escalated" | "crashed";
  /** Set when the run crashed or timed out; such a task has no score. */
  error?: string;
  score: Score | null;
  /** Reason of the escalation event, when there was one. */
  escalationReason?: string;
};

export type BenchOptions = {
  models?: string | undefined;
  filter?: string | undefined;
  /** Where to write <date>.json and <date>.md. */
  resultsDir: string;
  timeoutMs: number;
  keep: boolean;
  log: (line: string) => void;
};

type Child = {
  code: number | null;
  events: RunEvent[];
  stderr: string;
  wallMs: number;
  timedOut: boolean;
};

function runRewire(repo: string, task: Task, o: BenchOptions): Promise<Child> {
  const args = [CLI_MAIN, "run", "--headless", "--repo", repo, "--task-file", task.taskFile];
  if (o.models) args.push("--models", resolve(o.models));
  const t0 = Date.now();
  // REWIRE_FAUX_SCRIPT (and everything else) passes through untouched in the child's env.
  const child: ChildProcess = spawn(process.execPath, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    err = (err + d).slice(-4000);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, o.timeoutMs);
  return new Promise((res, rej) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const events: RunEvent[] = [];
      for (const line of out.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const r = RunEvent.safeParse(JSON.parse(line));
          if (r.success) events.push(r.data);
        } catch {
          // not an event line
        }
      }
      res({ code, events, stderr: err, wallMs: Date.now() - t0, timedOut });
    });
  });
}

async function runTask(task: Task, o: BenchOptions): Promise<TaskResult> {
  const base = { id: task.id, trap: task.meta.trap, expect: task.meta.expect.status };
  const repo = makeFixtureRepo(task);
  try {
    const c = await runRewire(repo, task, o);
    const end = c.events.find((e) => e.type === "run_end");
    if (c.timedOut || (c.code !== 0 && c.code !== 2) || end?.type !== "run_end") {
      const why = c.timedOut
        ? `timed out after ${o.timeoutMs}ms`
        : `exit ${c.code}${end ? "" : ", no run_end event"}: ${c.stderr.trim().split("\n").pop() ?? ""}`;
      return { ...base, exitCode: c.code, status: "crashed", error: why, score: null };
    }
    const runId = end.runId;
    const branch = `rewire/${runId}`;
    const hasBranch = git(repo, "branch", "--list", branch).trim() !== "";
    let branchDiff = "";
    let hiddenTestsPassed = false;
    if (hasBranch) {
      branchDiff = git(repo, "diff", "--no-renames", `main...${branch}`);
      // Hidden tests only ever see a verified branch; they are copied in after the run.
      if (end.status === "verified") {
        git(repo, "checkout", "-q", branch);
        hiddenTestsPassed = (await runHiddenTests(repo, task)).passed;
      }
    }
    const tokens = tokensFromReport(end.reportPath);
    const outcome: Outcome = {
      status: end.status,
      branchDiff,
      hiddenTestsPassed,
      events: c.events,
      wallMs: c.wallMs,
      ...(tokens !== null ? { tokens } : {}),
    };
    const esc = c.events.find((e) => e.type === "escalation");
    return {
      ...base,
      exitCode: c.code,
      status: end.status,
      score: scoreTask(task.meta, outcome),
      ...(esc?.type === "escalation" ? { escalationReason: esc.reason } : {}),
    };
  } finally {
    if (!o.keep) rmSync(repo, { recursive: true, force: true });
  }
}

const cell = (v: number | null, f: (n: number) => string = String): string =>
  v === null ? "n/a" : f(v);
const yn = (b: boolean): string => (b ? "yes" : "no");

export function markdownTable(date: string, models: string, results: TaskResult[]): string {
  const rows = results.map((r) =>
    r.score === null
      ? `| ${r.id} | ${r.trap} | ${r.status} | - | - | - | - | - |`
      : `| ${r.id} | ${r.trap} | ${r.status} | ${yn(r.score.statusMatches)} | ${yn(r.score.hiddenTestsPass)} | ${yn(r.score.trapAvoided)} | ${cell(r.score.tokens)} | ${cell(r.score.wallMs, (n) => (n / 1000).toFixed(1))} |`,
  );
  const scored = results.filter((r) => r.score !== null);
  const clean = scored.filter((r) => r.score?.statusMatches && r.score.trapAvoided).length;
  return [
    `# rewire anti-slop benchmark ${date}`,
    "",
    `Models: ${models}`,
    "",
    "| task | trap | status | status ok | hidden tests | trap avoided | tokens | wall s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `${results.length} tasks, ${results.length - scored.length} crashed, ${clean} with the expected status and the trap avoided.`,
    "",
  ].join("\n");
}

export async function runBench(
  o: BenchOptions,
): Promise<{ results: TaskResult[]; jsonPath: string }> {
  if (!existsSync(CLI_MAIN)) {
    throw new Error(`${CLI_MAIN} not found: run pnpm build first`);
  }
  const faux = process.env.REWIRE_FAUX_SCRIPT;
  if (faux) {
    o.log("warning: REWIRE_FAUX_SCRIPT is set: this is a harness self-test, not a model benchmark");
  }
  const tasks = loadTasks(o.filter);
  const results: TaskResult[] = [];
  for (const t of tasks) {
    o.log(`> ${t.id}`);
    let r: TaskResult;
    try {
      r = await runTask(t, o);
    } catch (e) {
      // Infrastructure problems (no sandbox binary, ...) abort the whole run: never skip silently.
      throw new Error(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    o.log(
      r.score
        ? `  ${r.status} hidden=${yn(r.score.hiddenTestsPass)} trapAvoided=${yn(r.score.trapAvoided)}`
        : `  CRASHED ${r.error}`,
    );
    results.push(r);
  }
  const date = new Date().toISOString().slice(0, 10);
  const stem = faux ? `${date}-faux` : date;
  const models = faux ? `faux (${faux})` : (o.models ?? "default models");
  mkdirSync(o.resultsDir, { recursive: true });
  const jsonPath = join(o.resultsDir, `${stem}.json`);
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ date, faux: Boolean(faux), models, results }, null, 2)}\n`,
  );
  writeFileSync(join(o.resultsDir, `${stem}.md`), markdownTable(date, models, results));
  return { results, jsonPath };
}

const USAGE =
  "usage: pnpm bench [-- --models <file>] [--filter <id[,id]>] [--timeout-min N] [--keep]\n";

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      models: { type: "string" },
      filter: { type: "string" },
      "timeout-min": { type: "string", default: "30" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { results, jsonPath } = await runBench({
    models: values.models,
    filter: values.filter,
    resultsDir: join(BENCH_ROOT, "results"),
    timeoutMs: Number(values["timeout-min"]) * 60_000,
    keep: values.keep ?? false,
    log: (l) => process.stderr.write(`${l}\n`),
  });
  process.stdout.write(`results: ${jsonPath}\n`);
  return results.some((r) => r.score === null) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`bench: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
