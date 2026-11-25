import { MIN_COMPACTION_LIMIT } from "@rewire/pipeline";
import type { ContextWindow } from "@rewire/providers";

/** No compaction limit, computed or configured, is below this many tokens. */
export const COMPACTION_FLOOR = MIN_COMPACTION_LIMIT;
/** Share of the window usable before compacting: the rest is room for the reply and the estimate's error. */
const WINDOW_SHARE = 0.85;
/** The formula's knee: at and below 32K the window share decides; above it the limit grows as W^0.6. */
const KNEE = 32768;
const GROWTH = 0.6;
/** The latency candidate needs this many prompt-reading samples. */
const MIN_PREFILL_SAMPLES = 2;
/** Recent user messages kept verbatim may take at most this share of the limit. */
const RECENT_USER_SHARE = 0.25;

export type LimitReason = "calibrated" | "formula" | "latency" | "window" | "override";
export type LimitCandidate = { reason: LimitReason; value: number };

export type CompactionLimitInput = {
  window: Pick<ContextWindow, "window" | "source" | "provisional">;
  /** A measured limit (calibration); replaces the formula. */
  calibrated?: number;
  /** The model's prompt-reading speed (`PrefillMeter.rate()`). */
  prefill?: { tokensPerSec: number; samples: number };
  /** Seconds of prompt reading one turn may cost. */
  latencyBudgetS: number;
  /** A configured limit (`[compaction.models."<ref>"] limit`); replaces everything. */
  override?: number;
};

export type CompactionLimit = {
  limit: number;
  reason: LimitReason;
  /** Every candidate considered, in order, so `/context` can show the breakdown. */
  candidates: LimitCandidate[];
};

const floor1k = (n: number): number => Math.floor(n / 1000) * 1000;
const usable = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0;

/** floor1k(min(0.85·W, 32768·(W/32768)^0.6)): the share of the window worth filling before compacting. */
export function formulaLimit(window: number): number {
  return floor1k(Math.min(WINDOW_SHARE * window, KNEE * (window / KNEE) ** GROWTH));
}

/**
 * The token count at which the chat session compacts: the smallest candidate (formula or
 * calibrated, the window share, and the latency budget once the prompt-reading speed has
 * `MIN_PREFILL_SAMPLES` samples), never below `COMPACTION_FLOOR`. A configured override replaces
 * the computation. Ties go to the earlier candidate.
 */
export function compactionLimit(input: CompactionLimitInput): CompactionLimit {
  if (usable(input.override)) {
    const value = Math.floor(input.override);
    return {
      limit: Math.max(COMPACTION_FLOOR, value),
      reason: "override",
      candidates: [{ reason: "override", value }],
    };
  }
  const W = input.window.window;
  const candidates: LimitCandidate[] = [
    usable(input.calibrated)
      ? { reason: "calibrated", value: Math.floor(input.calibrated) }
      : { reason: "formula", value: formulaLimit(W) },
    { reason: "window", value: floor1k(WINDOW_SHARE * W) },
  ];
  const p = input.prefill;
  if (p !== undefined && p.samples >= MIN_PREFILL_SAMPLES && usable(p.tokensPerSec)) {
    candidates.push({ reason: "latency", value: floor1k(p.tokensPerSec * input.latencyBudgetS) });
  }
  let best = candidates[0] as LimitCandidate;
  for (const c of candidates) if (c.value < best.value) best = c;
  return { limit: Math.max(COMPACTION_FLOOR, best.value), reason: best.reason, candidates };
}

/** Tokens of recent user messages kept verbatim: the configured value, capped at 25% of the limit. */
export function recentUserBudget(recentUserTokens: number, limit: number): number {
  return Math.min(recentUserTokens, Math.floor(limit * RECENT_USER_SHARE));
}

/** Below this time to first token the prompt was (mostly) a prefix-cache hit: not a reading speed. */
export const PREFILL_MIN_TTFT_MS = 300;
/** Prompts smaller than this are dominated by fixed overhead, not reading. */
export const PREFILL_MIN_TOKENS = 1000;
export const PREFILL_ALPHA = 0.3;

/**
 * One model's prompt-reading speed: an EMA (alpha 0.3, seeded by the first sample) of
 * inputTokens / time-to-first-token. Keep one per model.
 */
export class PrefillMeter {
  private tps: number | undefined;
  private n = 0;

  /** Record one model call; cache hits, tiny prompts and non-finite values are ignored. */
  sample(inputTokens: number, ttftMs: number): void {
    if (!Number.isFinite(inputTokens) || !Number.isFinite(ttftMs)) return;
    if (ttftMs < PREFILL_MIN_TTFT_MS || inputTokens < PREFILL_MIN_TOKENS) return;
    const rate = inputTokens / (ttftMs / 1000);
    this.tps =
      this.tps === undefined ? rate : PREFILL_ALPHA * rate + (1 - PREFILL_ALPHA) * this.tps;
    this.n++;
  }

  rate(): { tokensPerSec: number; samples: number } | undefined {
    return this.tps === undefined ? undefined : { tokensPerSec: this.tps, samples: this.n };
  }
}
