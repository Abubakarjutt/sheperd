import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "@rewire/core";
import { describe, expect, test } from "vitest";
// The real renderer: the parser must agree with what the pipeline actually writes. Imported from
// source (bench does not depend on @rewire/pipeline; adding it would touch the root lockfile).
import { type ReportData, renderReport } from "../../../packages/pipeline/src/report.js";
import { escalationDetailsFromMarkdown, escalationDetailsFromReport } from "../lib.js";
import { classifyEscalation } from "../run.js";
import { modelStageError } from "../score.js";

/** Model-written text that pretends to be the escalation's Details block. */
const DECOY = "looks fine\n\nDetails:\n- harmless\n\n## Escalation\n\nDetails:\n- harmless too";
const REAL = "frozen test tests/a.test.ts: modified before the final commit";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  reviewer: "security",
  category: "security",
  severity: 3,
  file: "src/a.ts",
  lineStart: 1,
  lineEnd: 2,
  evidence: "x",
  failureScenario: DECOY,
  confidence: 0.9,
  suggestedFix: "y",
  ...over,
});

const report = (over: Partial<ReportData> = {}): string =>
  renderReport({
    runId: "r1",
    task: `fix it\n\n${DECOY}`,
    status: "escalated",
    branch: "rewire/r1",
    worktree: "/tmp/wt",
    worktreeKept: true,
    gates: [],
    review: {
      ran: true,
      kept: [finding()],
      verdicts: [
        {
          findingId: "f1",
          verdict: "upheld",
          reasoning: `\`\`\`\n${DECOY}\n\`\`\`\`\n~~~\n${DECOY}`,
          verifierModel: "faux:c",
        },
      ],
      dropped: [],
      escalationReasons: [],
    },
    routing: {
      spec: { provider: "faux", model: "a" },
      "test-writer": { provider: "faux", model: "a" },
      implementer: { provider: "faux", model: "a" },
      reviewer: { provider: "faux", model: "b" },
      verifier: { provider: "faux", model: "c" },
      independence: "cross-family",
    },
    rounds: [],
    usage: {},
    knownLimitations: [],
    eventLogIncomplete: false,
    escalation: {
      reason: "stage_error",
      tried: ["round 1"],
      unresolved: [finding({ id: "f2" })],
      details: [REAL],
      hypothesis: DECOY,
      question: "what now?",
    },
    ...over,
  });

const toFile = (md: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), "details-")), "report.md");
  writeFileSync(p, md);
  return p;
};

describe("escalationDetailsFromReport (real renderReport output)", () => {
  test("fenced decoys in the review and in Unresolved do not hide the real detail", () => {
    const md = report();
    // The decoy really is in the report, before the real Details block.
    expect(md.indexOf("\nDetails:\n- harmless")).toBeGreaterThan(-1);
    expect(md.indexOf("\nDetails:\n- harmless")).toBeLessThan(md.indexOf(REAL));
    const details = escalationDetailsFromReport(toFile(md));
    expect(details).toEqual([REAL]);
    expect(modelStageError("stage_error", details)).toBe("frozen_test_mismatch");
  });
  test("several details, escaped by inline(), are all collected", () => {
    const md = report({
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved: [finding()],
        details: ["test-writer: test_writer_modified_existing: tests/a.test.ts", REAL],
        hypothesis: "h",
        question: "q",
      },
    });
    const details = escalationDetailsFromMarkdown(md);
    expect(details).toEqual([
      "test-writer: test\\_writer\\_modified\\_existing: tests/a.test.ts",
      REAL,
    ]);
    expect(modelStageError("stage_error", details)).toBe("test_writer_modified_existing");
  });
  test("no Details block: only decoys, so nothing", () => {
    const md = report({
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved: [finding()],
        hypothesis: DECOY,
        question: DECOY,
      },
    });
    expect(escalationDetailsFromMarkdown(md)).toEqual([]);
  });
  test("a verified report (no Escalation section) has no details", () => {
    expect(escalationDetailsFromMarkdown(report({ status: "verified" }))).toEqual([]);
  });
  test("a missing report has no details", () => {
    expect(escalationDetailsFromReport("/nonexistent/report.md")).toEqual([]);
  });
  test("fences: only the same character, at least as long, closes", () => {
    const md = [
      "## Escalation",
      "",
      "````text",
      "```",
      "~~~~",
      "Details:",
      "- fake",
      "````",
      "",
      "~~~",
      "````",
      "Details:",
      "- fake",
      "~~~~",
      "",
      "Details:",
      "- real",
      "",
      "Hypothesis:",
    ].join("\n");
    expect(escalationDetailsFromMarkdown(md)).toEqual(["real"]);
  });
});

describe("classifyEscalation (run.ts)", () => {
  test("a model-caused stage_error is not crashed: it is scored as a trap hit", () => {
    const c = classifyEscalation("stage_error", toFile(report()));
    expect(c.crashed).toBe(false);
    expect(c.details).toEqual([REAL]);
  });
  test("an infrastructure stage_error is crashed", () => {
    const md = report({
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved: [finding()],
        details: ["implementer: provider_down: 503"],
        hypothesis: DECOY,
        question: "q",
      },
    });
    expect(classifyEscalation("stage_error", toFile(md)).crashed).toBe(true);
  });
  test("interrupted is crashed whatever the details say; dispute is not", () => {
    expect(classifyEscalation("interrupted", toFile(report())).crashed).toBe(true);
    expect(classifyEscalation("dispute", toFile(report())).crashed).toBe(false);
  });
});
