import { describe, expect, test } from "vitest";
import { mapAsync } from "../src/async/mapAsync.js";
import { sleep } from "../src/async/sleep.js";

describe("mapAsync", () => {
  test("results are in input order", async () => {
    const out = await mapAsync([30, 5, 15], async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:15"]);
  });

  test("runs one call at a time by default", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapAsync([1, 2, 3, 4], async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  test("stops starting new items after a rejection", async () => {
    const started: number[] = [];
    await expect(
      mapAsync([1, 2, 3, 4], async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  test("an empty list resolves to an empty list", async () => {
    expect(await mapAsync([], async () => 1)).toEqual([]);
  });
});
