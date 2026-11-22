import type { RunEvent } from "@rewire/core";
import type { RunOutcome } from "@rewire/pipeline";
import { oneLine } from "./sanitize.js";

/** One terminal line for an event, or undefined when the event is not shown. */
export function renderEvent(e: RunEvent): string | undefined {
  switch (e.type) {
    case "stage_start":
      return `▶ ${oneLine(e.stage, 80)}`;
    case "gate_result": {
      const g = oneLine(e.result.gate, 80);
      return e.result.status === "pass" ? `✓ ${g}` : `✗ ${g}: ${oneLine(e.result.summary)}`;
    }
    case "finding": {
      const f = e.finding;
      return `● [${f.severity}] ${oneLine(`${f.file}:${f.lineStart} ${f.evidence}`)}`;
    }
    default:
      return undefined;
  }
}

/** `verified → branch <b>, report <p>` or `escalated (<reason>)[ → <path>]`. */
export function finalLine(o: RunOutcome): string {
  if (o.status === "verified") {
    return `verified → branch ${oneLine(o.branch, 120)}, report ${oneLine(o.reportPath, 300)}`;
  }
  const reason = oneLine(o.escalation?.reason ?? "unknown", 80);
  return o.reportPath === ""
    ? `escalated (${reason})`
    : `escalated (${reason}) → ${oneLine(o.reportPath, 300)}`;
}

const DETAIL_CAP = 10;
function detailLines(details: string[]): string[] {
  const shown = details.slice(0, DETAIL_CAP).map((d) => `  ${oneLine(d)}`);
  if (details.length > DETAIL_CAP) shown.push(`  … ${details.length - DETAIL_CAP} more`);
  return shown;
}

/** Sanitized one-line context under an escalation. */
export function escalationDetail(o: RunOutcome): string[] {
  const esc = o.escalation;
  if (!esc) return [];
  return [
    ...detailLines(esc.details ?? []),
    ...(esc.question ? [`  question: ${oneLine(esc.question)}`] : []),
  ];
}

/** Extra guidance for known, unfixable-in-run escalations. */
export function escalationHint(o: RunOutcome): string | undefined {
  const esc = o.escalation;
  if (!esc) return undefined;
  const text = [
    esc.reason,
    esc.hypothesis,
    esc.question,
    ...(esc.details ?? []),
    ...esc.unresolved.map((u) => ("summary" in u ? u.summary : u.evidence)),
  ].join("\n");
  // Strings from packages/pipeline/src/orchestrator.ts (`node_modules is in the index before the
  // final commit: ...` and TAMPERED = "node_modules link tampered").
  if (/node_modules is in the index/.test(text)) {
    return "hint: repos that commit node_modules are unsupported in v0.1; untrack it (git rm -r --cached node_modules), add it to .gitignore and re-run";
  }
  if (/node_modules link tampered/.test(text)) {
    return "hint: the agent modified node_modules; the run was rejected";
  }
  return undefined;
}
