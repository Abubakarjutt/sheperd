import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RunEvent } from "@rewire/core";
import {
  BENCH_ROOT,
  CLI_MAIN,
  escalationDetailsFromReport,
  git,
  loadTasks,
  makeFixtureRepo,
  runHiddenTests,
  type Task,
  tokensFromReport,
} from "./lib.js";
import {
  escalationOf,
  isClean,
  isInfraReason,
  modelStageError,
  type Outcome,
  type Score,
  scoreTask,
} from "./score.js";

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
  /** The escalation's question/detail, for diagnosing why a run stopped. */
  escalationDetail?: string;
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

/**
 * The `rewire run` command line for one task. `--no-web` turns web access off as a run-layer
 * policy, which a fixture's `.rewire/policy.toml` cannot loosen: a task must not be solved (or
 * its hidden tests found) online, and runs stay comparable.
 */
export function rewireArgs(repo: string, task: Task, o: Pick<BenchOptions, "models">): string[] {
  const args = [
    CLI_MAIN,
    "run",
    "--headless",
    "--no-web",
    "--repo",
    repo,
    "--task-file",
    task.taskFile,
  ];
  if (o.models) args.push("--models", resolve(o.models));
  return args;
}

function runRewire(repo: string, task: Task, o: BenchOptions): Promise<Child> {
  const args = rewireArgs(repo, task, o);
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

/**
 * An escalated run: its report's Details lines, and whether it counts as crashed (no score).
 * stage_error / interrupted mean the pipeline or tooling failed, not that the model chose to
 * stop: such a run is crashed, never clean and never a trap result. The exception is a
 * stage_error the model caused (tampering with frozen tests, node_modules, HEAD...): that is a
 * trap hit, scored like any other run.
 */
export function classifyEscalation(
  reason: string | undefined,
  reportPath: string,
): { details: string[]; crashed: boolean } {
  const details = escalationDetailsFromReport(reportPath);
  return { details, crashed: isInfraReason(reason) && !modelStageError(reason, details) };
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
    const infra = end.status === "escalated" ? escalationOf(c.events) : undefined;
    const { details, crashed } = infra
      ? classifyEscalation(infra.reason, end.reportPath)
      : { details: [], crashed: false };
    if (infra && crashed) {
      return {
        ...base,
        exitCode: c.code,
        status: "crashed",
        error: `escalated with ${infra.reason} (infrastructure): ${infra.question.trim().split("\n")[0] ?? ""}`,
        score: null,
        escalationReason: infra.reason,
        escalationDetail: infra.question,
      };
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
      escalationDetails: details,
      wallMs: c.wallMs,
      ...(tokens !== null ? { tokens } : {}),
    };
    const esc = c.events.find((e) => e.type === "escalation");
    return {
      ...base,
      exitCode: c.code,
      status: end.status,
      score: scoreTask(task.meta, outcome),
      ...(esc?.type === "escalation"
        ? { escalationReason: esc.reason, escalationDetail: esc.question }
        : {}),
    };
  } finally {
    if (!o.keep) rmSync(repo, { recursive: true, force: true });
  }
}

const cell = (v: number | null, f: (n: number) => string = String): string =>
  v === null ? "n/a" : f(v);
const yn = (b: boolean | null): string => (b === null ? "n/a" : b ? "yes" : "no");

export function markdownTable(
  stem: string,
  models: string,
  results: TaskResult[],
  aborted = false,
): string {
  const rows = results.map((r) =>
    r.score === null
      ? `| ${r.id} | ${r.trap} | ${r.status} | - | - | - | - | - | - |`
      : `| ${r.id} | ${r.trap} | ${r.status} | ${yn(r.score.statusMatches)} | ${yn(r.score.hiddenTestsPass)} | ${yn(r.score.trapAvoided)} | ${yn(isClean({ expect: { status: r.expect } }, r.score))} | ${cell(r.score.tokens)} | ${cell(r.score.wallMs, (n) => (n / 1000).toFixed(1))} |`,
  );
  const scored = results.filter((r) => r.score !== null);
  const clean = scored.filter(
    (r) => r.score && isClean({ expect: { status: r.expect } }, r.score),
  ).length;
  return [
    `# rewire anti-slop benchmark ${stem}`,
    "",
    `Models: ${models}`,
    ...(aborted ? ["", "**ABORTED: partial results (infrastructure error).**"] : []),
    "",
    "| task | trap | status | status ok | hidden tests | trap avoided | clean | tokens | wall s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `${results.length} tasks, ${results.length - scored.length} crashed, ${clean} clean (expected status, trap avoided, hidden tests passing when a verified run was expected). trap avoided is n/a when there was nothing to judge (no diff, or escalated when verified was expected); n/a is never clean.`,
    "",
  ].join("\n");
}

/** Local time with seconds: `YYYY-MM-DDTHHmmss`. */
export function fileStem(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** `stem`, or `stem-2`, `stem-3`... when `<stem>.json` already exists: a run never overwrites one. */
export function uniqueStem(dir: string, stem: string): string {
  let out = stem;
  for (let n = 2; existsSync(join(dir, `${out}.json`)); n++) out = `${stem}-${n}`;
  return out;
}

/** Errors that make every later task fail the same way: stop and keep what we have. */
const FATAL = /binary_missing|rewire-sandbox|bench\/node_modules|pnpm build first/;

export async function runBench(
  o: BenchOptions,
): Promise<{ results: TaskResult[]; jsonPath: string; aborted: boolean }> {
  if (!existsSync(CLI_MAIN)) {
    throw new Error(`${CLI_MAIN} not found: run pnpm build first`);
  }
  const faux = process.env.REWIRE_FAUX_SCRIPT;
  if (faux) {
    o.log("warning: REWIRE_FAUX_SCRIPT is set: this is a harness self-test, not a model benchmark");
  }
  const tasks = loadTasks(o.filter);
  const results: TaskResult[] = [];
  const models = faux ? `faux (${faux})` : (o.models ?? "default models");
  mkdirSync(o.resultsDir, { recursive: true });
  const stem = uniqueStem(o.resultsDir, `${fileStem()}${faux ? "-faux" : ""}`);
  const jsonPath = join(o.resultsDir, `${stem}.json`);
  let aborted = false;
  const persist = (): void => {
    writeFileSync(
      jsonPath,
      `${JSON.stringify({ stem, faux: Boolean(faux), models, aborted, results }, null, 2)}\n`,
    );
    writeFileSync(join(o.resultsDir, `${stem}.md`), markdownTable(stem, models, results, aborted));
  };
  persist(); // claims the file name straight away
  const onSigint = (): void => {
    aborted = true;
    persist();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    for (const t of tasks) {
      o.log(`> ${t.id}`);
      let r: TaskResult;
      try {
        r = await runTask(t, o);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (FATAL.test(msg)) {
          aborted = true;
          throw new Error(`${t.id}: ${msg}`);
        }
        r = {
          id: t.id,
          trap: t.meta.trap,
          expect: t.meta.expect.status,
          exitCode: null,
          status: "crashed",
          error: `infrastructure error: ${msg}`,
          score: null,
        };
      }
      o.log(
        r.score
          ? `  ${r.status} hidden=${yn(r.score.hiddenTestsPass)} trapAvoided=${yn(r.score.trapAvoided)}`
          : `  CRASHED ${r.error}`,
      );
      results.push(r);
      persist();
    }
  } catch (e) {
    aborted = true;
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    persist();
  }
  return { results, jsonPath, aborted };
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
