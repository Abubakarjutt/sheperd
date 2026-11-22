import { describe, expect, test } from "vitest";
import { clip } from "../src/text/clip.js";

describe("clip", () => {
  test("leaves short text alone", () => {
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("hello", 50)).toBe("hello");
  });

  test("cuts plain text", () => {
    expect(clip("hello world", 5)).toBe("hello");
  });

  test("never splits an emoji", () => {
    expect(clip("👍👍👍", 2)).toBe("👍👍");
  });

  test("keeps ZWJ sequences whole", () => {
    expect(clip("👨‍👩‍👧👨‍👩‍👧", 1)).toBe("👨‍👩‍👧");
  });

  test("keeps combining accents with their letter", () => {
    expect(clip("ééé", 2)).toBe("éé");
  });

  test("max 0 gives an empty string", () => {
    expect(clip("abc", 0)).toBe("");
  });

  test("rejects a bad max", () => {
    expect(() => clip("abc", -1)).toThrow(RangeError);
    expect(() => clip("abc", 1.5)).toThrow(RangeError);
  });
});
