import { describe, expect, test } from "vitest";
import { formatDuration } from "../src/time/format.js";

describe("formatDuration", () => {
  test.each([
    [0, "0ms"],
    [250, "250ms"],
    [90_000, "1m 30s"],
    [5_400_000, "1h 30m"],
    [90_061_001, "1d 1h 1m 1s 1ms"],
  ])("%i -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  test("rejects fractions and negatives", () => {
    expect(() => formatDuration(1.5)).toThrow(RangeError);
    expect(() => formatDuration(-1)).toThrow(RangeError);
  });
});
