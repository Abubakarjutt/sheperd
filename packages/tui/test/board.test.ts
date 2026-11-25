import type { RunEvent } from "@rewire/core";
import { describe, expect, it } from "vitest";
import { type BoardState, initialBoard, reduceBoard, withCheckpoint } from "../src/board.js";
import { fit, width } from "../src/fit.js";

const base = { runId: "r1", ts: "2026-01-01T00:00:00.000Z" };
const ev = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as RunEvent;
const run = (...es: RunEvent[]): BoardState => es.reduce(reduceBoard, initialBoard());
const gate = (name: string, status: "pass" | "fail" | "error") =>
  ev({
    type: "gate_result",
    stage: "gates",
    result: { gate: name, status, category: "other", summary: "s", details: null, durationMs: 1 },
  });

describe("reduceBoard", () => {
  it("spec start/end ok gives Spec done", () => {
    const s = run(
      ev({ type: "stage_start", stage: "spec" }),
      ev({ type: "stage_end", stage: "spec", ok: true }),
    );
    expect(s.rows.Spec.status).toBe("done");
    expect(s.rows.Tests.status).toBe("pending");
  });

  it("a failed stage_end gives failed", () => {
    const s = run(
      ev({ type: "stage_start", stage: "spec" }),
      ev({ type: "stage_end", stage: "spec", ok: false }),
    );
    expect(s.rows.Spec.status).toBe("failed");
  });

  it("a failing gate fails Gates and names it; passed/total counts", () => {
    const s = run(gate("types", "pass"), gate("semgrep", "fail"));
    expect(s.rows.Gates.status).toBe("failed");
    expect(s.rows.Gates.detail).toBe("1/2 passed · failed: semgrep");
  });

  it("a gate that passes on the next round clears the failure", () => {
    const s = run(
      gate("tests", "fail"),
      ev({ type: "fix_round", round: 1, score: 1 }),
      gate("tests", "pass"),
    );
    expect(s.rows.Gates.status).toBe("running");
    expect(s.rows.Gates.detail).toBe("1/1 passed");
  });

  it("fix_round 2 shows round 2 on Implement", () => {
    const s = run(ev({ type: "fix_round", round: 2, score: 3 }));
    expect(s.rows.Implement.detail).toBe("round 2");
    expect(s.rows.Implement.status).toBe("running");
  });

  it("tests: red check and frozen show in the Tests detail", () => {
    let s = run(
      ev({ type: "stage_start", stage: "test-writer" }),
      ev({ type: "stage_end", stage: "test-writer", ok: true }),
    );
    expect(s.rows.Tests.detail).toBe("red ✓");
    s = withCheckpoint(s, { kind: "tests", files: 3 });
    s = reduceBoard(s, ev({ type: "stage_start", stage: "implementer" }));
    expect(s.rows.Tests.detail).toBe("3 test files · red ✓ · frozen");
  });

  it("the running stage shows its last tool call", () => {
    const s = run(
      ev({ type: "stage_start", stage: "implementer" }),
      ev({
        type: "tool_call",
        stage: "implementer",
        tool: "edit",
        isError: false,
        summary: "src/a.ts",
      }),
    );
    expect(s.rows.Implement.detail).toBe("edit: src/a.ts");
  });

  it("findings and verdicts, then verified run_end completes everything", () => {
    let s = run(
      gate("types", "pass"),
      ev({ type: "finding", stage: "review", finding: { id: "f1" } }),
      ev({
        type: "verdict",
        stage: "review",
        verdict: { findingId: "f1", verdict: "refuted", reasoning: "", verifierModel: "m" },
      }),
    );
    expect(s.rows.Gates.status).toBe("done");
    expect(s.rows.Review.detail).toBe("1 finding · 0 upheld · 1 refuted");
    s = reduceBoard(s, ev({ type: "run_end", status: "verified", reportPath: "r" }));
    expect(s.rows.Review.status).toBe("done");
    expect(s.rows.Commit.status).toBe("done");
  });

  it("escalation fails the running stage", () => {
    const s = run(
      ev({ type: "stage_start", stage: "implementer" }),
      ev({ type: "escalation", reason: "x", question: "q" }),
    );
    expect(s.rows.Implement.status).toBe("failed");
  });

  it("contract checkpoint facts give the criteria counts", () => {
    const s = withCheckpoint(initialBoard(), { kind: "contract", changes: 2, preserves: 1 });
    expect(s.rows.Spec.detail).toBe("2 change · 1 preserve");
  });
});

describe("fit", () => {
  it("counts wide characters as two columns", () => {
    const out = fit("日本語日本語日本語", 10);
    expect(width(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
  it("never throws and never exceeds tiny widths", () => {
    for (const n of [-5, 0, 1, 2, 3, 9]) {
      expect(width(fit("hello 😀 world", n))).toBeLessThanOrEqual(Math.max(0, n));
    }
  });
  it("sanitizes before cutting, so an escape cannot survive a cut", () => {
    expect(fit("ab\x1b]52;c;ZXZpbA==\x07cd", 3)).toBe("ab…");
    expect(fit("x\x1b[31mred\x1b[0m", 80)).toBe("xred");
  });
});
