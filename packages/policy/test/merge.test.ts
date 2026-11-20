import { describe, expect, test } from "vitest";
import { DEFAULT_POLICY, mergeTightenOnly } from "../src/index.js";

describe("mergeTightenOnly", () => {
  test("overlay may add a gate", () =>
    expect(
      mergeTightenOnly(DEFAULT_POLICY, { gates: [...DEFAULT_POLICY.gates, "custom"] }).gates,
    ).toContain("custom"));
  test("overlay removing a gate throws policy_loosening", () =>
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { gates: ["tsc"] })).toThrow(/gates/));
  test("lowering reviewerMinConfidence throws", () =>
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: 0.2 })).toThrow(
      /reviewerMinConfidence/,
    ));
  test("raising maxFixRounds throws (more rounds = looser)", () =>
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { maxFixRounds: 20 })).toThrow(/maxFixRounds/));
  test("lowering numeric limits is allowed", () => {
    const p = mergeTightenOnly(DEFAULT_POLICY, {
      maxFixRounds: 3,
      gateTimeoutMs: 1000,
      reviewerMinConfidence: 0.9,
    });
    expect([p.maxFixRounds, p.gateTimeoutMs, p.reviewerMinConfidence]).toEqual([3, 1000, 0.9]);
  });
  test("commandRules are appended", () => {
    const rule = { pattern: ["git", "push"], decision: "forbidden" as const };
    expect(mergeTightenOnly(DEFAULT_POLICY, { commandRules: [rule] }).commandRules).toEqual([rule]);
  });
  test("error carries code policy_loosening", () => {
    try {
      mergeTightenOnly(DEFAULT_POLICY, { gates: [] });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "policy_loosening" });
    }
  });
});
