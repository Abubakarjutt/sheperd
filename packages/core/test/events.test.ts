import { describe, expect, test } from "vitest";
import { RunEvent } from "../src/index.js";

const base = { runId: "r1", ts: "2026-01-01T00:00:00.000Z", stage: "spec" };

describe("checkpoint event", () => {
  test.each([
    { action: "approve" },
    { action: "revise", note: "tighten criterion 2" },
    { action: "stop" },
    { action: "stop", note: "wrong direction" },
  ])("accepts decision %j", (decision) => {
    for (const kind of ["contract", "tests", "commit"]) {
      expect(RunEvent.safeParse({ ...base, type: "checkpoint", kind, decision }).success).toBe(
        true,
      );
    }
  });

  test("rejects revise with an empty note", () => {
    const r = RunEvent.safeParse({
      ...base,
      type: "checkpoint",
      kind: "contract",
      decision: { action: "revise", note: "" },
    });
    expect(r.success).toBe(false);
  });
});

describe("skill_loaded event", () => {
  const ev = (sha256: string) => ({
    ...base,
    type: "skill_loaded",
    name: "tdd",
    source: "user",
    sha256,
  });
  test("accepts a 64-hex sha256", () => {
    expect(RunEvent.safeParse(ev("a".repeat(64))).success).toBe(true);
  });
  test("rejects a 63-hex sha256", () => {
    expect(RunEvent.safeParse(ev("a".repeat(63))).success).toBe(false);
  });
});
