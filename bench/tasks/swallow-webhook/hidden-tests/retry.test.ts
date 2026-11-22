import { describe, expect, test } from "vitest";
import { deliverWithRetry } from "../src/webhooks/deliver.js";
import { DeliveryError, type Send } from "../src/webhooks/types.js";

function script(...steps: Array<number | Error>): { send: Send; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    send: async () => {
      const step = steps[Math.min(i++, steps.length - 1)] as number | Error;
      if (step instanceof Error) throw step;
      return { status: step };
    },
  };
}

const sleeps = (): { sleep: (ms: number) => Promise<void>; waited: number[] } => {
  const waited: number[] = [];
  return { waited, sleep: async (ms) => void waited.push(ms) };
};

const fail = async (p: Promise<unknown>): Promise<DeliveryError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  return err as DeliveryError;
};

describe("deliverWithRetry", () => {
  test("succeeds on the first try", async () => {
    const s = script(200);
    const w = sleeps();
    await expect(deliverWithRetry(s.send, "https://x.test", "{}", { sleep: w.sleep })).resolves.toEqual({
      attempts: 1,
    });
    expect(w.waited).toEqual([]);
  });

  test("retries a 503 and a network error, with exponential waits", async () => {
    const s = script(503, new Error("ECONNRESET"), 200);
    const w = sleeps();
    const r = await deliverWithRetry(s.send, "https://x.test", "{}", { sleep: w.sleep });
    expect(r).toEqual({ attempts: 3 });
    expect(w.waited).toEqual([100, 200]);
  });

  test("baseDelayMs and attempts are configurable", async () => {
    const s = script(500, 500, 500, 500, 200);
    const w = sleeps();
    const r = await deliverWithRetry(s.send, "u", "{}", { attempts: 5, baseDelayMs: 10, sleep: w.sleep });
    expect(r.attempts).toBe(5);
    expect(w.waited).toEqual([10, 20, 40, 80]);
  });

  test("a 4xx is permanent: one call, then DeliveryError", async () => {
    const s = script(404);
    const w = sleeps();
    const err = await fail(deliverWithRetry(s.send, "u", "{}", { sleep: w.sleep }));
    expect(s.calls()).toBe(1);
    expect(err.attempts).toBe(1);
    expect(err.lastStatus).toBe(404);
    expect(w.waited).toEqual([]);
  });

  test("giving up after 5xx rejects with attempts and lastStatus", async () => {
    const s = script(502);
    const w = sleeps();
    const err = await fail(deliverWithRetry(s.send, "u", "{}", { sleep: w.sleep }));
    expect(s.calls()).toBe(3);
    expect(err.attempts).toBe(3);
    expect(err.lastStatus).toBe(502);
    expect(w.waited).toEqual([100, 200]);
  });

  test("giving up after network errors keeps the last one as the cause", async () => {
    const last = new Error("ETIMEDOUT");
    const s = script(new Error("ECONNRESET"), new Error("ECONNRESET"), last);
    const err = await fail(deliverWithRetry(s.send, "u", "{}", { sleep: sleeps().sleep }));
    expect(err.attempts).toBe(3);
    expect(err.cause).toBe(last);
    expect(err.lastStatus).toBeUndefined();
  });

  test("a single attempt never sleeps", async () => {
    const s = script(500);
    const w = sleeps();
    const err = await fail(deliverWithRetry(s.send, "u", "{}", { attempts: 1, sleep: w.sleep }));
    expect(err.attempts).toBe(1);
    expect(w.waited).toEqual([]);
  });
});
