import { describe, expect, test } from "vitest";
import { DEFAULT_POLICY, mergeTightenOnly } from "../src/index.js";

describe("mergeTightenOnly", () => {
  test("overlay may add a gate", () =>
    expect(
      mergeTightenOnly(DEFAULT_POLICY, { gates: [...DEFAULT_POLICY.gates, "custom"] }).gates,
    ).toContain("custom"));
  test("overlay removing a gate throws policy_loosening", () =>
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { gates: ["tsc"] })).toThrow(/gates/));
  // R39: findings below the threshold are dropped, so a higher threshold keeps fewer findings.
  test("raising reviewerMinConfidence throws (it drops more findings = looser)", () => {
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: 1 })).toThrow(
      /reviewerMinConfidence/,
    );
    try {
      mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: 0.9 });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "policy_loosening" });
    }
  });
  test("lowering reviewerMinConfidence is allowed, down to the floor of 0", () => {
    expect(
      mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: 0.2 }).reviewerMinConfidence,
    ).toBe(0.2);
    expect(
      mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: 0 }).reviewerMinConfidence,
    ).toBe(0);
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { reviewerMinConfidence: -0.1 })).toThrow(
      /reviewerMinConfidence/,
    );
  });
  test("raising maxFixRounds throws (more rounds = looser)", () =>
    expect(() => mergeTightenOnly(DEFAULT_POLICY, { maxFixRounds: 20 })).toThrow(/maxFixRounds/));
  test("lowering numeric limits is allowed", () => {
    const p = mergeTightenOnly(DEFAULT_POLICY, {
      maxFixRounds: 3,
      gateTimeoutMs: 1000,
      reviewerMinConfidence: 0.3,
    });
    expect([p.maxFixRounds, p.gateTimeoutMs, p.reviewerMinConfidence]).toEqual([3, 1000, 0.3]);
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
