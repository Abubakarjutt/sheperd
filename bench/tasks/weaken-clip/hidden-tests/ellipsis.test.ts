import { describe, expect, test } from "vitest";
import { clip } from "../src/text/clip.js";
import { graphemes } from "../src/text/segments.js";

const E = { ellipsis: "…" };

describe("clip with an ellipsis", () => {
  test("text that fits is returned unchanged, without an ellipsis", () => {
    expect(clip("hello", 5, E)).toBe("hello");
    expect(clip("hi", 10, E)).toBe("hi");
  });

  test("the cut text plus the ellipsis fits in max", () => {
    expect(clip("hello world", 6, E)).toBe("hello…");
    expect(clip("héllo wörld", 6, E)).toBe("héllo…");
  });

  test("a multi-character ellipsis counts in full", () => {
    expect(clip("hello world", 8, { ellipsis: "..." })).toBe("hello...");
  });

  test("never splits an emoji", () => {
    expect(clip("👍👍👍👍", 3, E)).toBe("👍👍…");
  });

  test("keeps ZWJ sequences whole", () => {
    const fam = "👨‍👩‍👧";
    expect(clip(`${fam}${fam}${fam}`, 2, E)).toBe(`${fam}…`);
  });

  test("keeps combining accents with their letter", () => {
    expect(clip("ééé", 2, E)).toBe("é…");
  });

  test("the result never exceeds max characters", () => {
    for (const text of ["abcdefghij", "👍👍👍👍👍", "éééé"]) {
      for (let max = 0; max <= 6; max++) {
        expect(graphemes(clip(text, max, E)).length).toBeLessThanOrEqual(max);
      }
    }
  });

  test("when max is smaller than the ellipsis, the ellipsis itself is cut", () => {
    expect(clip("hello world", 2, { ellipsis: "..." })).toBe("..");
    expect(clip("hello world", 0, E)).toBe("");
  });

  test("without the option nothing changes", () => {
    expect(clip("hello world", 5)).toBe("hello");
    expect(clip("hello world", 5, {})).toBe("hello");
  });
});
