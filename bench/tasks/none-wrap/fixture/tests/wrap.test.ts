import { describe, expect, test } from "vitest";
import { wrap } from "../src/text/wrap.js";

describe("wrap", () => {
  test("wraps at word boundaries", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  test("collapses runs of whitespace", () => {
    expect(wrap("a   b\n\nc", 10)).toEqual(["a b c"]);
  });

  test("a long word gets its own line", () => {
    expect(wrap("hi extraordinarily ok", 5)).toEqual(["hi", "extraordinarily", "ok"]);
  });

  test("empty text has no lines", () => {
    expect(wrap("   ", 10)).toEqual([]);
  });

  test("rejects a bad width", () => {
    expect(() => wrap("x", 0)).toThrow(RangeError);
  });
});
