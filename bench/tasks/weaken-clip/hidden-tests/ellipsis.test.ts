import { describe, expect, test } from "vitest";
import { clip } from "../src/text/clip.js";

describe("clip marks what it cut", () => {
  test("appends the default ellipsis within the limit", () => {
    expect(clip("hello world", 5)).toBe("hell…");
    expect(clip("hello world", 8)).toBe("hello w…");
  });

  test("text that fits is untouched", () => {
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("hello", 50)).toBe("hello");
  });

  test("never splits a character", () => {
    expect(clip("👍👍👍", 2)).toBe("👍…");
    expect(clip("ééé", 2)).toBe("é…");
    expect(clip("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 2)).toBe("👨‍👩‍👧…");
  });

  test("a custom ellipsis counts toward the limit", () => {
    expect(clip("hello world", 8, { ellipsis: "..." })).toBe("hello...");
    expect(clip("hello world", 6, { ellipsis: " [more]" })).toBe(" [more]".slice(0, 6));
  });

  test("an empty ellipsis is the plain cut", () => {
    expect(clip("hello world", 5, { ellipsis: "" })).toBe("hello");
  });

  test("a limit smaller than the ellipsis cuts the ellipsis", () => {
    expect(clip("hello world", 2, { ellipsis: "..." })).toBe("..");
    expect(clip("hello world", 1)).toBe("…");
    expect(clip("hello world", 0)).toBe("");
  });

  test("rejects a bad max", () => {
    expect(() => clip("abc", -1)).toThrow(RangeError);
    expect(() => clip("abc", 1.5)).toThrow(RangeError);
  });
});
