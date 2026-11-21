import { describe, expect, test } from "vitest";
import { add, double } from "../src/math.js";

describe("math", () => {
  test("AC-1: adds two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
  test("AC-2: doubles a number", () => {
    expect(double(4)).toBe(8);
  });
});
