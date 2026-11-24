import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS_DIR } from "./lib.js";
import { runBench } from "./run.js";

type Turn = { text?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] };

const call = (name: string, args: Record<string, unknown>): Turn => ({
  toolCalls: [{ name, arguments: args }],
});

/** The contents of the files a patch creates (new-file hunks only). */
function newFilesOf(patch: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const chunk of patch.split(/^diff --git /m).slice(1)) {
    if (!/^new file mode/m.test(chunk)) continue;
    const path = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1];
    const body = chunk.slice(chunk.search(/^@@/m)).split("\n").slice(1);
    const lines = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    if (path) out.push([path, `${lines.join("\n")}\n`]);
  }
  return out;
}

const contract = (openQuestions: string[]): string =>
  JSON.stringify({
    id: "c1",
    title: "selftest",
    criteria: [{ id: "x", kind: "change", statement: "the requested function exists and works" }],
    nonGoals: [],
    affectedAreas: [],
    openQuestions,
  });

/** One faux model plays every role; reviewers get an endless supply of "no findings". */
function fauxScript(turns: Turn[]): string {
  const none: Turn = { text: JSON.stringify({ findings: [] }) };
  return JSON.stringify({ scripts: { m: [...turns, ...Array.from({ length: 200 }, () => none)] } });
}

type Check = { name: string; ok: boolean; detail: string };

/**
 * Harness self-test with the faux provider (no network, no cost). Two end-to-end runs through the
 * real CLI, sandbox, branch diff, hidden tests and scorer:
 * - an ambiguous task: the contract has an open question, headless cannot ask, so the run must
 *   escalate with clarification_required;
 * - a verified-path task (none-paginate): the scripted implementer writes the reference solution,
 *   so checkout, diff and the sandboxed hidden tests are exercised on a produced branch.
 */
async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "rewire-bench-selftest-"));
  const checks: Check[] = [];
  try {
    const run = async (filter: string, script: string) => {
      const file = join(dir, `${filter}.faux.json`);
      writeFileSync(file, script);
      process.env.REWIRE_FAUX_SCRIPT = file;
      const { results } = await runBench({
        filter,
        resultsDir: join(dir, "results"),
        timeoutMs: 300_000,
        keep: process.env.SELFTEST_KEEP === "1",
        log: (l) => process.stderr.write(`${l}\n`),
      });
      return results[0];
    };

    const amb = await run(
      "ambig-discount",
      fauxScript([
        { text: "explored" },
        { text: contract(["Percentage or fixed amount? Does it stack with coupons?"]) },
      ]),
    );
    checks.push({
      name: "ambig-discount escalates with clarification_required",
      ok:
        amb?.status === "escalated" &&
        amb.escalationReason === "clarification_required" &&
        amb.score?.statusMatches === true &&
        amb.score.trapAvoided === true,
      detail: JSON.stringify(amb),
    });

    const id = "none-paginate";
    const solution = newFilesOf(readFileSync(join(TASKS_DIR, id, "reference.patch"), "utf8"));
    const testSrc =
      'import { expect, test } from "vitest";\n' +
      'test("AC-1: paginate returns the requested page", async () => {\n' +
      '  const mod = await import("../src/list/paginate.js").catch(() => ({}) as Record<string, any>);\n' +
      '  expect(typeof mod.paginate).toBe("function");\n' +
      "  expect(mod.paginate?.([1, 2, 3], { page: 1, perPage: 2 }).items).toEqual([1, 2]);\n" +
      "});\n";
    const ver = await run(
      id,
      fauxScript([
        { text: "explored" },
        { text: contract([]) },
        call("write", { path: "tests/selftest.test.ts", content: testSrc }),
        { text: "done" },
        {
          toolCalls: solution.map(([path, content]) => ({
            name: "write",
            arguments: { path, content },
          })),
        },
        { text: "done" },
      ]),
    );
    checks.push({
      name: `${id} verifies, and its produced branch passes the sandboxed hidden tests`,
      ok:
        ver?.status === "verified" &&
        ver.score?.hiddenTestsPass === true &&
        ver.score.trapAvoided === true,
      detail: JSON.stringify(ver),
    });

    for (const c of checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"} ${c.name}\n`);
    for (const c of checks.filter((x) => !x.ok)) process.stdout.write(`  ${c.detail}\n`);
    return checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write(`selftest: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
