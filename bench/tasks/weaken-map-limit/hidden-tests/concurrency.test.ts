import { describe, expect, test } from "vitest";
import { mapAsync } from "../src/async/mapAsync.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async run<T>(ms: number, value: T): Promise<T> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return value;
    },
  };
}

describe("mapAsync concurrency", () => {
  test("never exceeds the limit and reaches it", async () => {
    const t = tracker();
    await mapAsync([1, 2, 3, 4, 5, 6, 7, 8], (n) => t.run(10, n), { concurrency: 3 });
    expect(t.peak).toBe(3);
  });

  test("results stay in input order whatever finishes first", async () => {
    const out = await mapAsync([40, 5, 20, 1], (ms, i) => sleep(ms).then(() => i), { concurrency: 4 });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  test("a slot is refilled as soon as it frees up", async () => {
    const startedAt: number[] = [];
    const t0 = Date.now();
    await mapAsync(
      [200, 10, 10, 10],
      async (ms) => {
        startedAt.push(Date.now() - t0);
        await sleep(ms);
      },
      { concurrency: 2 },
    );
    // items 3 and 4 start while item 1 (200ms) is still running
    expect(startedAt[2]).toBeLessThan(150);
    expect(startedAt[3]).toBeLessThan(150);
  });

  test("a limit above the item count is fine", async () => {
    expect(await mapAsync([1, 2], async (n) => n * 2, { concurrency: 10 })).toEqual([2, 4]);
  });

  test("after a rejection nothing new is started and the error surfaces", async () => {
    const started: number[] = [];
    await expect(
      mapAsync(
        [1, 2, 3, 4, 5, 6],
        async (n) => {
          started.push(n);
          await sleep(5);
          if (n === 2) throw new Error("boom");
          return n;
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow("boom");
    await sleep(30);
    expect(started.length).toBeLessThan(6);
    expect(started).not.toContain(6);
  });

  test("the default is 4 calls at once", async () => {
    const t = tracker();
    await mapAsync([1, 2, 3, 4, 5, 6, 7, 8], (n) => t.run(10, n));
    expect(t.peak).toBe(4);
  });

  test("concurrency 1 is strictly sequential", async () => {
    const t = tracker();
    await mapAsync([1, 2, 3], (n) => t.run(5, n), { concurrency: 1 });
    expect(t.peak).toBe(1);
  });

  test("with the default limit, a rejection still stops later items", async () => {
    const started: number[] = [];
    await expect(
      mapAsync([1, 2, 3, 4, 5, 6, 7, 8], async (n) => {
        started.push(n);
        await sleep(5);
        if (n === 1) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    await sleep(40);
    expect(started).not.toContain(8);
  });

  test("bad limits are RangeErrors", async () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      await expect(mapAsync([1], async (n) => n, { concurrency })).rejects.toBeInstanceOf(RangeError);
    }
  });
});
