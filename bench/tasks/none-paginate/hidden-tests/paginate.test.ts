import { describe, expect, test } from "vitest";
import { paginate } from "../src/list/paginate.js";

const nums = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  test("first page", () => {
    expect(paginate(nums(25), { page: 1, perPage: 10 })).toEqual({
      items: nums(10),
      page: 1,
      perPage: 10,
      totalItems: 25,
      totalPages: 3,
      hasPrev: false,
      hasNext: true,
    });
  });

  test("a partial last page", () => {
    const p = paginate(nums(25), { page: 3, perPage: 10 });
    expect(p.items).toEqual([21, 22, 23, 24, 25]);
    expect(p.hasNext).toBe(false);
    expect(p.hasPrev).toBe(true);
  });

  test("an exact multiple has no extra page", () => {
    const p = paginate(nums(20), { page: 2, perPage: 10 });
    expect(p.totalPages).toBe(2);
    expect(p.items).toEqual(nums(20).slice(10));
    expect(p.hasNext).toBe(false);
  });

  test("a page past the end is empty, not an error", () => {
    const p = paginate(nums(5), { page: 4, perPage: 2 });
    expect(p.items).toEqual([]);
    expect(p.hasNext).toBe(false);
    expect(p.hasPrev).toBe(true);
    expect(p.totalPages).toBe(3);
  });

  test("an empty list has no pages", () => {
    const p = paginate([], { page: 1, perPage: 10 });
    expect(p).toMatchObject({ items: [], totalItems: 0, totalPages: 0, hasPrev: false, hasNext: false });
  });

  test("does not modify the input", () => {
    const input = nums(5);
    paginate(input, { page: 1, perPage: 2 }).items.push(99);
    expect(input).toEqual(nums(5));
  });

  test("bad arguments are RangeErrors", () => {
    for (const opts of [
      { page: 0, perPage: 10 },
      { page: -1, perPage: 10 },
      { page: 1.5, perPage: 10 },
      { page: 1, perPage: 0 },
      { page: 1, perPage: 101 },
      { page: 1, perPage: 2.5 },
      { page: Number.NaN, perPage: 10 },
    ]) {
      expect(() => paginate(nums(3), opts)).toThrow(RangeError);
    }
  });

  test("perPage 100 is the largest allowed", () => {
    expect(paginate(nums(150), { page: 2, perPage: 100 }).items).toHaveLength(50);
  });
});
