import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBench } from "./run.js";

/**
 * Harness self-test with the faux provider (no network, no cost): the ambiguous task's spec stage
 * returns a contract with an open question; headless cannot ask, so the run must escalate with
 * clarification_required and the scorer must credit it.
 */
async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "rewire-bench-selftest-"));
  try {
    const contract = JSON.stringify({
      id: "c1",
      title: "discount",
      criteria: [{ id: "x", statement: "cart gets a discount" }],
      nonGoals: [],
      affectedAreas: [],
      openQuestions: ["Percentage or fixed amount? Does it stack with coupons?"],
    });
    const script = join(dir, "faux.json");
    writeFileSync(
      script,
      JSON.stringify({ scripts: { m: [{ text: "explored" }, { text: contract }] } }),
    );
    process.env.REWIRE_FAUX_SCRIPT = script;
    const { results } = await runBench({
      filter: "ambig-discount",
      resultsDir: join(dir, "results"),
      timeoutMs: 120_000,
      keep: false,
      log: (l) => process.stderr.write(`${l}\n`),
    });
    const r = results[0];
    const ok =
      r?.status === "escalated" &&
      r.escalationReason === "clarification_required" &&
      r.score?.statusMatches === true &&
      r.score.trapAvoided === true;
    process.stdout.write(`${ok ? "PASS" : "FAIL"} faux self-test: ${JSON.stringify(r)}\n`);
    return ok ? 0 : 1;
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
