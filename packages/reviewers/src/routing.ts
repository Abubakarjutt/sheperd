import { type Finding, RewireError } from "@rewire/core";
import type { DiffSummary } from "./diff.js";
import type { Dropped } from "./evidence.js";
import {
  type ReviewerDef,
  type ReviewerInput,
  type ReviewResult,
  runReviewer,
} from "./framework.js";

/** An added line that suggests error-handling or fallback code worth a silent-failure review. */
export const SILENT_FAILURE_PATTERN =
  /\bcatch\b|\?\?|\|\||TODO|FIXME|console\.(error|warn)|\.catch\(|Promise\.allSettled|\bexcept\b|\brescue\b|\bfinally\b|\.then\(|unwrap_or|_ = err|if err != nil/;

/**
 * Text of every line the patch adds. Hunk-aware: inside a hunk (after `@@`) every `+` line is
 * added, including ones that start `++`; outside a hunk the `--- `/`+++ ` headers are skipped.
 */
function addedText(patch: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) inHunk = false;
    else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && l.startsWith("+")) out.push(l.slice(1));
  }
  return out;
}

export const REVIEWERS: ReviewerDef[] = [
  {
    name: "security",
    categories: ["security"],
    promptFile: "security.md",
    // Fixed floor (#17): every diff gets a security review.
    appliesTo: () => true,
  },
  {
    name: "spec-compliance",
    categories: ["spec_drift"],
    promptFile: "spec-compliance.md",
    appliesTo: () => true,
  },
  {
    name: "silent-failure",
    categories: ["silent_failure"],
    promptFile: "silent-failure.md",
    // A truncated patch hides added lines, so absence of a match proves nothing: run it.
    appliesTo: (diff) =>
      diff.truncated || addedText(diff.patch).some((l) => SILENT_FAILURE_PATTERN.test(l)),
  },
];

/** Reviewers that apply to the diff, in REVIEWERS order. */
export function selectReviewers(diff: DiffSummary): ReviewerDef[] {
  return REVIEWERS.filter((r) => r.appliesTo(diff));
}

export type PanelResult = {
  kept: Finding[];
  dropped: Dropped[];
  omitted: string[];
  truncated: boolean;
  /** True when the panel cannot vouch for a clean verdict. Never report "clean" when set. */
  escalate: boolean;
  escalationReasons: string[];
};

/**
 * Run the selected reviewers concurrently. Fail closed: if any reviewer rejects, the panel
 * rejects (after every reviewer has settled, so no promise is left dangling), naming the first
 * failing reviewer. Escalation is computed from the input diff itself, not only from reviewer
 * results, so a skipped reviewer cannot hide a truncated diff, omitted file or forced finding.
 */
export async function runPanel(input: ReviewerInput): Promise<PanelResult> {
  const selected = selectReviewers(input.diff);
  const settled = await Promise.allSettled(selected.map((def) => runReviewer(def, input)));

  const results: ReviewResult[] = [];
  for (const [i, s] of settled.entries()) {
    if (s.status === "rejected") {
      const reviewer = selected[i]?.name ?? "unknown";
      const reason: unknown = s.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      const code = reason instanceof RewireError ? reason.code : "reviewer_failed";
      const err = new RewireError(code, `reviewer "${reviewer}" failed: ${msg}`);
      (err as { cause?: unknown }).cause = reason;
      throw err;
    }
    results.push(s.value);
  }

  // Forced findings repeat (same id) across reviewers; reviewer findings are never re-filtered.
  const kept = new Map<string, Finding>();
  const dropped = new Map<string, Dropped>();
  const omitted = new Set<string>(input.diff.omitted);
  for (const r of results) {
    for (const f of r.kept) if (!kept.has(f.id)) kept.set(f.id, f);
    for (const d of r.dropped) {
      const key = JSON.stringify([d.finding.id, d.reason]);
      if (!dropped.has(key)) dropped.set(key, d);
    }
    for (const o of r.omitted) omitted.add(o);
  }

  const escalationReasons: string[] = [];
  if (input.diff.truncated)
    escalationReasons.push("diff was truncated; part of it was not reviewed");
  if (omitted.size > 0) {
    escalationReasons.push(`content omitted from review: ${[...omitted].join(", ")}`);
  }
  if (input.diff.forced.length > 0) {
    escalationReasons.push(
      `${input.diff.forced.length} forced security finding(s) decided by code`,
    );
  }

  return {
    kept: [...kept.values()],
    dropped: [...dropped.values()],
    omitted: [...omitted],
    truncated: input.diff.truncated,
    escalate: escalationReasons.length > 0,
    escalationReasons,
  };
}
