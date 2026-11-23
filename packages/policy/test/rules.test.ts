import { describe, expect, test } from "vitest";
import { evaluateCommand, selfTestRules } from "../src/index.js";

describe("command rules", () => {
  test("forbidden rule with alternatives matches", () =>
    expect(
      evaluateCommand(
        [{ pattern: ["npm", ["install", "i"]], decision: "forbidden" }],
        ["npm", "i", "left-pad"],
      ),
    ).toBe("forbidden"));
  test("no matching rule allows", () =>
    expect(
      evaluateCommand([{ pattern: ["git", "push"], decision: "forbidden" }], ["git", "status"]),
    ).toBe("allow"));
  test("forbidden wins over allow", () =>
    expect(
      evaluateCommand(
        [
          { pattern: ["git"], decision: "allow" },
          { pattern: ["git", "push"], decision: "forbidden" },
        ],
        ["git", "push", "origin"],
      ),
    ).toBe("forbidden"));
  test("self-test fails when a match example does not match", () =>
    expect(() =>
      selfTestRules([{ pattern: ["git", "push"], decision: "forbidden", match: ["git status"] }]),
    ).toThrow(/policy_selftest_failed|git status/));
  test("self-test fails when a notMatch example matches", () =>
    expect(() =>
      selfTestRules([
        { pattern: ["git", "push"], decision: "forbidden", notMatch: ["git push origin"] },
      ]),
    ).toThrow(/git push origin/));
  test("self-test lists every failure", () => {
    expect(() =>
      selfTestRules([{ pattern: ["git", "push"], decision: "forbidden", match: ["a b", "c d"] }]),
    ).toThrow(/a b[\s\S]*c d/);
  });
  test("self-test passes for good rules", () =>
    expect(() =>
      selfTestRules([
        {
          pattern: ["git", "push"],
          decision: "forbidden",
          match: ["git push 'x y'"],
          notMatch: ["git status"],
        },
      ]),
    ).not.toThrow());
  test("self-test error has code policy_selftest_failed", () => {
    try {
      selfTestRules([{ pattern: ["a"], decision: "forbidden", match: ["b"] }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "policy_selftest_failed" });
    }
  });
});
