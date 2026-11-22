import { describe, expect, test } from "vitest";
import { wrapParagraphs } from "../src/text/paragraph.js";
import { wrap } from "../src/text/wrap.js";

describe("wrap respects width", () => {
  test("the reported example", () => {
    expect(wrap("aaa bbb", 6)).toEqual(["aaa", "bbb"]);
  });

  test("a line may be exactly width characters long", () => {
    expect(wrap("aaa bbb", 7)).toEqual(["aaa bbb"]);
    expect(wrap("ab cd ef", 5)).toEqual(["ab cd", "ef"]);
  });

  test("no line is longer than width unless it is a single word", () => {
    const text = "the quick brown fox jumps over the lazy dog and keeps running far away";
    for (let width = 1; width <= 30; width++) {
      for (const line of wrap(text, width)) {
        if (line.includes(" ")) expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("words are never lost or reordered", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    for (let width = 1; width <= 20; width++) {
      expect(wrap(text, width).join(" ")).toBe(text);
    }
  });

  test("long words still get a line of their own", () => {
    expect(wrap("hi extraordinarily ok", 5)).toEqual(["hi", "extraordinarily", "ok"]);
  });

  test("paragraphs wrap the same way", () => {
    expect(wrapParagraphs("aaa bbb\n\nccc ddd", 6)).toBe("aaa\nbbb\n\nccc\nddd");
  });
});
