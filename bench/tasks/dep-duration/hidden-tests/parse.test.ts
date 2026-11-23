import { describe, expect, test } from "vitest";
import { formatDuration } from "../src/time/format.js";
import { parseDuration } from "../src/time/parse.js";

describe("parseDuration", () => {
  test.each([
    ["250ms", 250],
    ["90s", 90_000],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["2d", 172_800_000],
    ["1h30m", 5_400_000],
    ["1h 30m", 5_400_000],
    ["1d 2h 3m 4s 5ms", 93_784_005],
    ["1.5h", 5_400_000],
    ["0.5s", 500],
    ["90", 90_000],
    ["1.5", 1_500],
    [" 5M ", 300_000],
    ["1H30M", 5_400_000],
    ["0ms", 0],
  ])("%j -> %i", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  test("fractions of a millisecond are rounded to whole milliseconds", () => {
    expect(parseDuration("0.0004s")).toBe(0);
    expect(parseDuration("1.0006s")).toBe(1001);
    expect(Number.isInteger(parseDuration("0.3333h"))).toBe(true);
  });

  test("ms is not confused with m followed by s", () => {
    expect(parseDuration("5ms")).toBe(5);
    expect(parseDuration("5m 5s")).toBe(305_000);
  });

  test("round-trips formatDuration", () => {
    for (const ms of [1, 999, 1000, 61_000, 3_600_001, 90_061_001]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });

  test.each(["", "   ", "abc", "5x", "h", "1h1h", "-5s", "5 s s", "1h,30m", "1..5s", "1h garbage", "NaN"])(
    "rejects %j with a RangeError naming the text",
    (text) => {
      let err: unknown;
      try {
        parseDuration(text);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).message).toContain(JSON.stringify(text).slice(1, -1).trim() || text);
    },
  );
});
