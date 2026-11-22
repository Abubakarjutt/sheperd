import type { Finding, GateResult } from "@rewire/core";
import type { Policy } from "@rewire/policy";

/**
 * Fix-loop controller: a pure, deterministic state machine. No I/O, no model
 * calls, no clock. Each round's gate failures and blocking findings go in;
 * a decision (done / fix / replan / escalate) comes out.
 */

export type RoundState = {
  round: number;
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
    | "review_incomplete";
  tried: string[];
  unresolved: Array<GateResult | Finding>;
  hypothesis: string;
  question: string;
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

export function score(s: RoundState): number {
  let total = GATE_WEIGHT * s.gateFailures.length;
  for (const f of s.blocking) total += SEVERITY_WEIGHT[f.severity];
  return total;
}

// Same pattern as `SECRET`/`redact` in @rewire/reviewers (framework.ts); pipeline
// does not depend on reviewers, so it is duplicated here. Keep in sync.
const SECRET = /(sk-|ghp_|AKIA)[A-Za-z0-9_-]+/g;
const redact = (s: string): string => s.replace(SECRET, "[redacted]");
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const gateKey = (g: GateResult): string => `gate:${g.gate}`;
const roundKeys = (s: RoundState): Set<string> =>
  new Set([...s.gateFailures.map(gateKey), ...s.blocking.map((f) => f.id)]);

const bySeverity = (a: Finding, b: Finding): number =>
  b.severity - a.severity ||
  (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
  a.lineStart - b.lineStart ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function findingBlock(f: Finding): string {
  return [
    `- ${f.file}:${f.lineStart} [${f.category}] severity ${f.severity}`,
    `  scenario: ${redact(clip(f.failureScenario, FIELD_CAP))}`,
    `  fix: ${redact(clip(f.suggestedFix, FIELD_CAP))}`,
  ].join("\n");
}

function buildFeedback(s: RoundState): string {
  const parts: string[] = [];
  for (const g of s.gateFailures) {
    parts.push(`Gate ${g.gate}: ${redact(clip(g.summary, GATE_SUMMARY_CAP))}`);
  }
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
  return Buffer.byteLength(out) > FEEDBACK_CAP_BYTES
    ? Buffer.from(out).subarray(0, FEEDBACK_CAP_BYTES).toString("utf8")
    : out;
}

function summarize(s: RoundState): string {
  const keys = [
    ...s.gateFailures.map(gateKey),
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
      unresolved: [...s.gateFailures, ...s.blocking],
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
