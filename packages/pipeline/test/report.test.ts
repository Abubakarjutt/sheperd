import type { Finding, GateResult } from "@rewire/core";
import { expect, test } from "vitest";
import { cell, fenced, type ReportData, renderReport } from "../src/report.js";

const SECRET = `sk-${"A".repeat(24)}`;

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  reviewer: "security",
  category: "security",
  severity: 3,
  file: "src/sum.ts",
  lineStart: 1,
  lineEnd: 1,
  evidence: "eval(x)",
  failureScenario: "attacker runs code",
  confidence: 0.9,
  suggestedFix: "do not eval",
  ...over,
});

const gate = (over: Partial<GateResult> = {}): GateResult => ({
  gate: "tsc",
  category: "broken",
  status: "pass",
  summary: "ok",
  details: null,
  durationMs: 5,
  ...over,
});

const base = (over: Partial<ReportData> = {}): ReportData => ({
  runId: "r1",
  task: "add sum(a,b)",
  status: "verified",
  branch: "rewire/r1",
  worktree: "/tmp/wt",
  worktreeKept: false,
  contract: {
    id: "c",
    title: "sum",
    criteria: [{ id: "AC-1", statement: "adds" }],
    nonGoals: [],
    affectedAreas: [],
    openQuestions: [],
  },
  manifest: {
    files: [{ path: "tests/sum.test.ts", sha256: "x" }],
    criteriaToTests: { "AC-1": ["tests/sum.test.ts::AC-1: adds"] },
  },
  gates: [gate()],
  review: { ran: true, kept: [], verdicts: [], dropped: [], escalationReasons: [] },
  routing: {
    spec: { provider: "faux", model: "a" },
    "test-writer": { provider: "faux", model: "a" },
    implementer: { provider: "faux", model: "a" },
    reviewer: { provider: "faux", model: "b" },
    verifier: { provider: "faux", model: "c" },
    independence: "cross-family",
  },
  rounds: [{ round: 1, score: 0 }],
  usage: {},
  knownLimitations: ["rules cover JS/TS only"],
  eventLogIncomplete: false,
  ...over,
});

const H2 = [
  "Status",
  "Contract",
  "Gates",
  "Review",
  "Models & independence",
  "Network exceptions",
  "Fix rounds",
  "Cost",
  "Known limitations",
  "Escalation",
];

test("sections in the brief's order; Escalation only when escalated", () => {
  const ok = renderReport(base());
  const heads = [...ok.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(heads).toEqual(H2.slice(0, -1));
  expect(ok).toMatch(/## Gates[\s\S]*\| tsc \| broken \| pass/);
  expect(ok).toContain("AC-1");
  expect(ok).toContain("tests/sum.test.ts::AC-1: adds");

  const esc = renderReport(
    base({
      status: "escalated",
      worktreeKept: true,
      escalation: {
        reason: "no_progress",
        tried: ["round 1: score 10"],
        unresolved: [gate({ status: "fail", summary: "TS2322" })],
        hypothesis: "h",
        question: "q?",
      },
    }),
  );
  expect([...esc.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(H2);
});

test("model-derived text renders inert and redacted", () => {
  const evil = `[x](http://evil) | ## Status\n## Status\n<img src=x onerror=alert(1)> \`\`\`\n# Heading ${SECRET}`;
  const md = renderReport(
    base({
      status: "escalated",
      worktreeKept: true,
      gates: [gate({ gate: "tests", status: "fail", summary: evil })],
      review: {
        ran: true,
        kept: [finding({ failureScenario: evil, file: `src/${evil}` })],
        verdicts: [
          { findingId: "f1", verdict: "upheld", reasoning: evil, verifierModel: "faux:c" },
        ],
        dropped: [{ finding: finding({ id: "f2", failureScenario: evil }), reason: evil }],
        escalationReasons: [evil],
      },
      contract: {
        id: "c",
        title: evil,
        criteria: [{ id: "AC-1", statement: evil }],
        nonGoals: [],
        affectedAreas: [],
        openQuestions: [],
      },
      escalation: {
        reason: "no_progress",
        tried: [evil],
        unresolved: [finding({ failureScenario: evil }), gate({ summary: evil, status: "fail" })],
        hypothesis: evil,
        question: evil,
        details: [evil],
      },
    }),
  );
  expect(md).not.toContain(SECRET);
  expect(md).toContain("[redacted]");
  // Outside fenced blocks: exactly the ten real H2 headings, one H1, and nothing can open a
  // link, an HTML tag or a code span.
  const outside = stripFences(md);
  expect([...outside.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(H2);
  expect(outside.match(/^#{1,6} /gm)?.length).toBe(H2.length + 1);
  expect(outside).not.toContain("[x](http://evil)");
  expect(outside).not.toMatch(/(?<!\\)\[x(?<!\\)\]/);
  expect(outside).not.toMatch(/(?<!\\)<img/);
  expect(outside).not.toMatch(/http:\/\//);
  // Table rows keep their column count: the injected pipe is escaped.
  const row = md.split("\n").find((l) => l.startsWith("| tests |"));
  expect(row?.split(/(?<!\\)\|/).length).toBe(6);
});

/** Remove fenced code blocks (any fence length >= 3 backticks). */
function stripFences(md: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of md.split("\n")) {
    const m = /^(`{3,})/.exec(line);
    if (fence !== undefined) {
      if (line.trim() === fence) fence = undefined;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  expect(fence).toBeUndefined();
  return out.join("\n");
}

test("fenced block cannot be closed by its content", () => {
  const f = fenced("a\n```\n## Status\n````x");
  const lines = f.split("\n");
  const open = /^`+/.exec(lines[0] ?? "")?.[0] ?? "";
  expect(open.length).toBeGreaterThanOrEqual(5);
  // Only the last line closes it: no content line is a run of backticks that long.
  expect(lines.slice(1, -1).some((l) => l.trim().startsWith(open))).toBe(false);
  expect(lines[lines.length - 1]).toBe(open);
});

test("cell escapes pipes, newlines and markup", () => {
  expect(cell("a|b\nc")).toBe("a\\|b c");
  expect(cell("[l](u)")).toBe("\\[l\\]\\(u\\)");
  expect(cell(SECRET)).toBe("[redacted]".replace(/[[\]]/g, "\\$&"));
});

test("event log incomplete is noted", () => {
  expect(renderReport(base({ eventLogIncomplete: true }))).toContain("event log incomplete");
});

test("same-family independence and costs are shown", () => {
  const md = renderReport(
    base({
      routing: { ...base().routing, independence: "same-family" },
      usage: { implementer: { inputTokens: 12, outputTokens: 34 } },
    }),
  );
  expect(md).toContain("same-family");
  expect(md).toMatch(/\| implementer \| 12 \| 34 \|/);
});
