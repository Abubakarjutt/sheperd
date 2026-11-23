import { type Finding, type GateResult, RewireError, redact } from "@rewire/core";
import type { Policy } from "@rewire/policy";

/**
 * Fix-loop controller: a pure, deterministic state machine. No I/O, no model
 * calls, no clock. Each round's gate failures and blocking findings go in;
 * a decision (done / fix / replan / escalate) comes out.
 */

export type RoundState = {
  round: number;
  /**
   * Callers may pass all gate results. Only entries with `status !== "pass"`
   * count (both `fail` and `error`); `pass` entries are ignored, so an errored
   * gate can never read as clean.
   */
  gateFailures: GateResult[];
  blocking: Finding[];
  /** Reasons the review was incomplete (truncated diff, omitted files, forced findings, verifier error). */
  reviewEscalation?: string[];
};

export type EscalationReport = {
  reason:
    | "no_progress"
    | "oscillation"
    | "budget"
    | "dispute"
    | "clarification_required"
    | "interrupted"
    | "stage_error"
    | "review_incomplete"
    | "implementer_truncated";
  tried: string[];
  unresolved: Array<GateResult | Finding>;
  hypothesis: string;
  question: string;
  /** Extra context: review-incomplete reasons, the failing stage's error code and message. */
  details?: string[];
};

export type Decision =
  | { kind: "done" }
  | { kind: "fix"; feedback: string }
  | { kind: "replan"; history: string }
  | {
      kind: "escalate";
      reason: EscalationReport["reason"];
      unresolved: Array<GateResult | Finding>;
      details?: string[];
    };

// Severity scale: 0 nit, 1 minor, 2 significant, 3 critical.
const SEVERITY_WEIGHT = [1, 3, 5, 8] as const;
const GATE_WEIGHT = 10;
const FEEDBACK_CAP_BYTES = 16 * 1024;
const GATE_SUMMARY_CAP = 1000;
const FIELD_CAP = 1500;
const TOP_KEYS = 3;

const failing = (s: RoundState): GateResult[] => s.gateFailures.filter((g) => g.status !== "pass");

export function score(s: RoundState): number {
  let total = GATE_WEIGHT * failing(s).length;
  for (const f of s.blocking) {
    if (!Number.isInteger(f.severity) || f.severity < 0 || f.severity > 3) {
      throw new RewireError(
        "invalid_severity",
        `finding ${f.id} has invalid severity ${String(f.severity)}`,
      );
    }
    total += SEVERITY_WEIGHT[f.severity];
  }
  return total;
}

// Code-point-safe clip (never splits a surrogate pair).
const clip = (s: string, n: number): string => {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : s;
};
/** Clip to at most `bytes` UTF-8 bytes on a code-point boundary. */
const clipBytes = (s: string, bytes: number): string => {
  let used = 0;
  let out = "";
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (used + b > bytes) break;
    out += ch;
    used += b;
  }
  return out;
};
const NAME_CAP = 100;

const gateKey = (g: GateResult): string => `gate:${g.gate}`;
const roundKeys = (s: RoundState): Set<string> =>
  new Set([...failing(s).map(gateKey), ...s.blocking.map((f) => f.id)]);

const bySeverity = (a: Finding, b: Finding): number =>
  b.severity - a.severity ||
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
  a.lineStart - b.lineStart ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function findingBlock(f: Finding): string {
  return [
    `- ${redact(clip(f.file, FIELD_CAP))}:${f.lineStart} [${redact(clip(f.category, NAME_CAP))}] severity ${f.severity}`,
    `  scenario: ${redact(clip(f.failureScenario, FIELD_CAP))}`,
    `  fix: ${redact(clip(f.suggestedFix, FIELD_CAP))}`,
  ].join("\n");
}

function buildFeedback(s: RoundState): string {
  const parts: string[] = [];
  const gates = failing(s).map((g) => ({
    prefix: `Gate ${redact(clip(g.gate, NAME_CAP))}: `,
    summary: redact(clip(g.summary, GATE_SUMMARY_CAP)),
  }));
  const gateBytes = (): number =>
    gates.reduce((n, g) => n + Buffer.byteLength(g.prefix) + Buffer.byteLength(g.summary) + 1, 0);
  if (gates.length > 0 && gateBytes() > FEEDBACK_CAP_BYTES) {
    // Shrink every summary proportionally; gates are never dropped.
    const fixed = gates.reduce((n, g) => n + Buffer.byteLength(g.prefix) + 1, 0);
    const per = Math.max(0, Math.floor((FEEDBACK_CAP_BYTES - fixed) / gates.length));
    for (const g of gates) g.summary = clipBytes(g.summary, per);
  }
  for (const g of gates) parts.push(`${g.prefix}${g.summary}`);
  let used = Buffer.byteLength(parts.join("\n"));
  const sorted = [...s.blocking].sort(bySeverity);
  const omittedLine = (n: number): string => `… ${n} more findings omitted`;
  const reserve = Buffer.byteLength(`\n${omittedLine(sorted.length)}`);
  let shown = 0;
  for (const f of sorted) {
    const block = findingBlock(f);
    const size = Buffer.byteLength(block) + 1;
    if (used + size + reserve > FEEDBACK_CAP_BYTES) break;
    parts.push(block);
    used += size;
    shown++;
  }
  if (shown < sorted.length) parts.push(omittedLine(sorted.length - shown));
  const out = parts.join("\n");
  // Gate lines are individually capped, but an absurd number of gates could still overflow.
  return Buffer.byteLength(out) > FEEDBACK_CAP_BYTES ? clipBytes(out, FEEDBACK_CAP_BYTES) : out;
}

function summarize(s: RoundState): string {
  const keys = [
    ...failing(s).map(gateKey),
    ...[...s.blocking].sort(bySeverity).map((f) => f.id.slice(0, 12)),
  ].slice(0, TOP_KEYS);
  return `round ${s.round}: score ${score(s)}; top: ${keys.join(", ") || "none"}`;
}

export class FixLoopController {
  replanned = false;
  private best: number | undefined;
  private stagnant = 0;
  private keyHistory: Array<Set<string>> = [];
  private summaries: string[] = [];

  constructor(private readonly policy: Policy) {}

  record(s: RoundState): Decision {
    const sc = score(s);
    const reasons = s.reviewEscalation ?? [];
    if (sc === 0) {
      if (reasons.length === 0) return { kind: "done" };
      return {
        kind: "escalate",
        reason: "review_incomplete",
        unresolved: [],
        details: [...reasons],
      };
    }

    const keys = roundKeys(s);
    const oscillating = this.oscillates(keys);

    if (this.best === undefined || sc < this.best) {
      this.best = sc;
      this.stagnant = 0;
    } else {
      this.stagnant++;
    }
    const noProgress = this.stagnant >= this.policy.noProgressRounds;
    const overBudget = s.round > this.policy.maxFixRounds;

    this.keyHistory.push(keys);
    this.summaries.push(summarize(s));

    const trigger: EscalationReport["reason"] | undefined = oscillating
      ? "oscillation"
      : noProgress
        ? "no_progress"
        : overBudget
          ? "budget"
          : undefined;

    if (trigger === undefined) return { kind: "fix", feedback: buildFeedback(s) };

    if (!this.replanned) {
      this.replanned = true;
      const history = this.summaries.join("\n");
      this.best = undefined;
      this.stagnant = 0;
      this.keyHistory = [];
      this.summaries = [];
      return { kind: "replan", history };
    }
    return {
      kind: "escalate",
      reason: trigger,
      unresolved: [...failing(s), ...s.blocking],
      ...(reasons.length > 0 ? { details: [...reasons] } : {}),
    };
  }

  /** A key present in round i, absent in a later round j, and present now. */
  private oscillates(now: Set<string>): boolean {
    for (const k of now) {
      let seen = false;
      let gap = false;
      for (const past of this.keyHistory) {
        if (past.has(k)) {
          if (gap) return true;
          seen = true;
        } else if (seen) gap = true;
      }
      if (seen && gap) return true;
    }
    return false;
  }
}
