import { describe, expect, test } from "vitest";
import { ValidationError } from "../src/errors.js";
import { assertNonEmpty, isEmail, parseIntStrict } from "../src/validate/guards.js";

describe("guards", () => {
  test("isEmail", () => {
    expect(isEmail("ann@example.com")).toBe(true);
    expect(isEmail("ann@example")).toBe(false);
    expect(isEmail("ann example@x.io")).toBe(false);
  });

  test("assertNonEmpty trims", () => {
    expect(assertNonEmpty("  x ", "f")).toBe("x");
    expect(() => assertNonEmpty("  ", "f")).toThrow(ValidationError);
  });

  test("parseIntStrict", () => {
    expect(parseIntStrict(" 12 ", "n")).toBe(12);
    expect(() => parseIntStrict("12abc", "n")).toThrow(ValidationError);
    expect(() => parseIntStrict("3", "n", { min: 5 })).toThrow(ValidationError);
  });
});
