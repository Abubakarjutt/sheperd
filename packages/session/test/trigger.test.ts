import { describe, expect, test } from "vitest";
import {
  COMPACTION_FLOOR,
  compactionLimit,
  formulaLimit,
  PrefillMeter,
  recentUserBudget,
} from "../src/trigger.js";

const loaded = (W: number) => ({ window: W, source: "loaded" as const, provisional: false });

describe("compactionLimit", () => {
  // formula = floor1k(min(0.85·W, 32768·(W/32768)^0.6)), window = floor1k(0.85·W).
  test.each([
    [8192, 6000, 6000, "formula"],
    [32768, 27000, 27000, "formula"],
    [131072, 75000, 111000, "formula"],
    [200000, 97000, 170000, "formula"],
    [262144, 114000, 222000, "formula"],
    [1048576, 262000, 891000, "formula"],
  ] as const)("W=%i: formula %i, window %i", (W, formula, window, reason) => {
    expect(formulaLimit(W)).toBe(formula);
    const r = compactionLimit({ window: loaded(W), latencyBudgetS: 60 });
    expect(r.limit).toBe(formula);
    expect(r.reason).toBe(reason);
    expect(r.candidates).toEqual([
      { reason: "formula", value: formula },
      { reason: "window", value: window },
    ]);
  });

  test("latency wins on a slow prompt reader, but only after 2 samples", () => {
    // 500 tok/s × 60 s = 30000 < formula 75000 at 128K.
    const slow = { tokensPerSec: 500, samples: 2 };
    const r = compactionLimit({ window: loaded(131072), prefill: slow, latencyBudgetS: 60 });
    expect(r).toEqual({
      limit: 30000,
      reason: "latency",
      candidates: [
        { reason: "formula", value: 75000 },
        { reason: "window", value: 111000 },
        { reason: "latency", value: 30000 },
      ],
    });
    const one = compactionLimit({
      window: loaded(131072),
      prefill: { tokensPerSec: 500, samples: 1 },
      latencyBudgetS: 60,
    });
    expect(one.reason).toBe("formula");
    expect(one.candidates.map((c) => c.reason)).not.toContain("latency");
  });

  test("a fast reader leaves the formula in charge, and latency is floored to 1K", () => {
    const r = compactionLimit({
      window: loaded(131072),
      prefill: { tokensPerSec: 2345.6, samples: 5 },
      latencyBudgetS: 60,
    });
    expect(r.reason).toBe("formula");
    expect(r.candidates).toContainEqual({ reason: "latency", value: 140000 });
  });

  test("calibrated replaces the formula", () => {
    const r = compactionLimit({ window: loaded(131072), calibrated: 50000, latencyBudgetS: 60 });
    expect(r).toEqual({
      limit: 50000,
      reason: "calibrated",
      candidates: [
        { reason: "calibrated", value: 50000 },
        { reason: "window", value: 111000 },
      ],
    });
    // A calibration above the window is still capped by the window.
    const big = compactionLimit({ window: loaded(32768), calibrated: 40000, latencyBudgetS: 60 });
    expect(big).toMatchObject({ limit: 27000, reason: "window" });
  });

  test("override replaces everything", () => {
    const r = compactionLimit({
      window: loaded(131072),
      calibrated: 50000,
      prefill: { tokensPerSec: 100, samples: 9 },
      latencyBudgetS: 60,
      override: 32000,
    });
    expect(r).toEqual({
      limit: 32000,
      reason: "override",
      candidates: [{ reason: "override", value: 32000 }],
    });
  });

  test("the limit never drops below 4096", () => {
    expect(COMPACTION_FLOOR).toBe(4096);
    const small = compactionLimit({ window: loaded(8192), latencyBudgetS: 60 });
    expect(small.limit).toBe(6000);
    const slow = compactionLimit({
      window: loaded(131072),
      prefill: { tokensPerSec: 10, samples: 3 },
      latencyBudgetS: 5,
    });
    expect(slow).toMatchObject({ limit: 4096, reason: "latency" });
    expect(slow.candidates).toContainEqual({ reason: "latency", value: 0 });
  });

  test("ignores a non-finite or non-positive calibration or prefill rate", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = compactionLimit({
        window: loaded(131072),
        calibrated: bad,
        prefill: { tokensPerSec: bad, samples: 4 },
        latencyBudgetS: 60,
      });
      expect(r.reason).toBe("formula");
      expect(r.limit).toBe(75000);
    }
  });
});

describe("compactionLimit window guards", () => {
  test("a window under ~4.8K is capped at 0.85·W, not raised above it by the floor", () => {
    expect(compactionLimit({ window: loaded(2048), latencyBudgetS: 60 }).limit).toBe(1740);
    expect(compactionLimit({ window: loaded(4096), latencyBudgetS: 60 }).limit).toBe(3481);
  });

  test("a non-positive or non-finite window is treated as the 32K default", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = compactionLimit({ window: loaded(bad), latencyBudgetS: 60 });
      expect(r.limit).toBe(27000);
      expect(Number.isFinite(r.limit)).toBe(true);
    }
  });

  test("a non-finite latency budget drops the latency candidate", () => {
    const r = compactionLimit({
      window: loaded(131072),
      prefill: { tokensPerSec: 100, samples: 5 },
      latencyBudgetS: Number.NaN,
    });
    expect(r).toMatchObject({ limit: 75000, reason: "formula" });
    expect(r.candidates.map((c) => c.reason)).not.toContain("latency");
  });
});

describe("recentUserBudget", () => {
  test("is the configured value, capped at 25% of the limit", () => {
    expect(recentUserBudget(20000, 200000)).toBe(20000);
    expect(recentUserBudget(20000, 27000)).toBe(6750);
  });
});

describe("PrefillMeter", () => {
  test("is empty until a usable sample", () => {
    expect(new PrefillMeter().rate()).toBeUndefined();
  });

  test("ignores prefix-cache hits (TTFT < 300 ms) and tiny prompts (< 1000 tokens)", () => {
    const m = new PrefillMeter();
    m.sample(50000, 299);
    m.sample(999, 5000);
    m.sample(Number.NaN, 5000);
    m.sample(5000, Number.POSITIVE_INFINITY);
    expect(m.rate()).toBeUndefined();
    m.sample(1000, 300);
    expect(m.rate()).toEqual({ tokensPerSec: 1000 / 0.3, samples: 1 });
  });

  test("keeps an EMA with alpha 0.3 seeded by the first sample", () => {
    const m = new PrefillMeter();
    m.sample(10000, 1000); // 10000 tok/s
    m.sample(20000, 10000); // 2000 tok/s
    const r = m.rate();
    expect(r?.samples).toBe(2);
    expect(r?.tokensPerSec).toBeCloseTo(0.3 * 2000 + 0.7 * 10000, 6);
  });
});
