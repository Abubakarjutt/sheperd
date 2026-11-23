import { describe, expect, test } from "vitest";
import { chunk } from "../src/list/chunk.js";
import { groupBy } from "../src/list/groupBy.js";
import { sortBy } from "../src/list/sortBy.js";

describe("list helpers", () => {
  test("sortBy is stable and does not mutate", () => {
    const input = [
      { n: 2, t: "a" },
      { n: 1, t: "b" },
      { n: 2, t: "c" },
    ];
    expect(sortBy(input, (x) => x.n).map((x) => x.t)).toEqual(["b", "a", "c"]);
    expect(input[0]?.t).toBe("a");
  });

  test("groupBy keeps order", () => {
    const g = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? "odd" : "even"));
    expect([...g.keys()]).toEqual(["odd", "even"]);
    expect(g.get("odd")).toEqual([1, 3, 5]);
  });

  test("chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
