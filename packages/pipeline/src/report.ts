import {
  type Contract,
  type Finding,
  type FrozenTestManifest,
  type GateResult,
  redact,
  stripControls,
  type Verdict,
} from "@rewire/core";
import { modelFamily, type Usage } from "@rewire/providers";
import type { Dropped } from "@rewire/reviewers";
import type { EscalationReport } from "./fix-loop.js";
import { ROLES, type Role, type RoleRouting } from "./routing.js";

export type ReviewData = {
  /** False when the review step did not run (a gate failed in the last round). */
  ran: boolean;
  kept: Finding[];
  verdicts: Verdict[];
  dropped: Dropped[];
  escalationReasons: string[];
};

export type SkillUse = { name: string; source: "user" | "repo"; sha256: string; stages: string[] };

export type ReportData = {
  runId: string;
  task: string;
  status: "verified" | "escalated";
  branch: string;
  worktree: string;
  worktreeKept: boolean;
  contract?: Contract;
  manifest?: FrozenTestManifest;
  /** Gate results of the last round. */
  gates: GateResult[];
  /** Review of the last round. */
  review?: ReviewData;
  routing: RoleRouting;
  rounds: Array<{ round: number; score: number }>;
  usage: Partial<Record<Role, Usage>>;
  knownLimitations: string[];
  /** Decides the network-exception text (M3). Default: this process's platform. */
  platform?: NodeJS.Platform;
  /** Ignored untracked entries deleted before gate runs and the final commit (R38). */
  removedIgnored?: string[];
  escalation?: EscalationReport;
  /** Skills the author stages loaded; the section is omitted when empty or absent. */
  skillsUsed?: SkillUse[];
  eventLogIncomplete: boolean;
};

/*
 * Every string that a model, the repo or a tool produced goes through `redact` and then either
 * `cell`/`inline` (escaped so it cannot form a link, HTML, a heading, a code span or a table
 * column) or `fenced` (a code block its content cannot close).
 */

const MARKUP = /[\\`*_[\]<>()#!|~{}]/g;
// GFM extended autolinks need no brackets: break the scheme and `www.` so they stay text.
const AUTOLINK = /\b(https?|ftp|mailto|file|javascript|data|vbscript)(:)/gi;
const WWW = /\bwww\./gi;

/** Inline text: control characters stripped (M1), redacted, one line, markup escaped. */
export function inline(s: string): string {
  return redact(stripControls(s))
    .replace(/\r\n?|\n/g, " ")
    .replace(MARKUP, "\\$&")
    .replace(AUTOLINK, "$1\\$2")
    .replace(WWW, "www\\.");
}

/** A table cell: `inline`, which also escapes `|` and newlines. */
export const cell = inline;

/** A fenced code block whose fence is longer than any backtick run in the content. */
export function fenced(s: string): string {
  const body = redact(stripControls(s));
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
}

const isFinding = (x: GateResult | Finding): x is Finding => "failureScenario" in x;

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function statusSection(d: ReportData): string {
  const lines = [
    `**${d.status}**${d.escalation ? ` (reason: ${inline(d.escalation.reason)})` : ""}`,
    "",
    `- Run: ${inline(d.runId)}`,
    `- Branch: ${inline(d.branch)}`,
    `- Worktree: ${inline(d.worktree || "(not created)")} (${d.worktreeKept ? "kept for inspection" : "removed"})`,
  ];
  if (d.eventLogIncomplete) {
    lines.push("- Warning: event log incomplete (a write to events.jsonl failed)");
  }
  lines.push("", "Task:", "", fenced(d.task));
  return lines.join("\n");
}

function contractSection(d: ReportData): string {
  if (!d.contract) return "No contract was compiled.";
  const map = d.manifest?.criteriaToTests ?? {};
  const out = [`Title: ${inline(d.contract.title)}`, ""];
  for (const c of d.contract.criteria) {
    // The kind is shown so a mislabel (a bug marked preserve, an existing behaviour marked change)
    // is visible to whoever reads the evidence. It is a schema enum, never free text.
    out.push(`- ${inline(c.id)} (${c.kind}): ${inline(c.statement)}`);
    const tests = map[c.id] ?? [];
    if (tests.length === 0) out.push("  - (no linked test)");
    for (const t of tests) out.push(`  - test: ${inline(t)}`);
  }
  if (d.manifest) {
    out.push("", `Frozen test files: ${d.manifest.files.map((f) => inline(f.path)).join(", ")}`);
  }
  return out.join("\n");
}

function gatesSection(d: ReportData): string {
  if (d.gates.length === 0) return "No gates ran.";
  const out = table(
    ["gate", "category", "status", "summary"],
    d.gates.map((g) => [cell(g.gate), cell(g.category), cell(g.status), cell(g.summary)]),
  );
  // I6: "pass" here means nothing was linted; say so instead of reading as "lint clean".
  const noLinter = d.gates.some(
    (g) => g.gate === "lint" && g.status === "pass" && g.summary === "no linter configured",
  );
  return noLinter
    ? `${out}\n\nNote: no linter is configured for this repository, so the lint gate checked nothing.`
    : out;
}

function findingLines(f: Finding, verdict?: Verdict): string[] {
  const out = [
    `- ${inline(f.file)}:${f.lineStart}-${f.lineEnd} [${inline(f.category)}] severity ${f.severity}, confidence ${f.confidence}, reviewer ${inline(f.reviewer)}, id ${inline(f.id)}`,
    "",
    fenced(`failure scenario: ${f.failureScenario}`),
  ];
  if (verdict) {
    out.push(
      "",
      `  verdict: ${inline(verdict.verdict)} by ${inline(verdict.verifierModel)}`,
      "",
      fenced(`reasoning: ${verdict.reasoning}`),
    );
  }
  return out;
}

function reviewSection(d: ReportData): string {
  const r = d.review;
  if (!r?.ran) {
    // M2: a run that stopped before any gate round (spec, test-writer, preflight) is not a
    // gate failure.
    return d.gates.length === 0
      ? "The review did not run: no gate round ran (the run stopped before the gates)."
      : "The review did not run: a gate failed in the last round.";
  }
  const byId = new Map(r.verdicts.map((v) => [v.findingId, v]));
  const upheld = r.kept.filter((f) => byId.get(f.id)?.verdict !== "refuted");
  const refuted = r.kept.filter((f) => byId.get(f.id)?.verdict === "refuted");
  const out: string[] = [`Kept findings (upheld or unverified): ${upheld.length}`];
  for (const f of upheld) out.push(...findingLines(f, byId.get(f.id)));
  out.push("", `Refuted findings: ${refuted.length}`);
  for (const f of refuted) out.push(...findingLines(f, byId.get(f.id)));
  const counts = new Map<string, number>();
  for (const x of r.dropped) counts.set(x.reason, (counts.get(x.reason) ?? 0) + 1);
  out.push("", `Dropped findings: ${r.dropped.length}`);
  for (const [reason, n] of [...counts].sort()) out.push(`- ${inline(reason)}: ${n}`);
  if (r.escalationReasons.length > 0) {
    out.push("", "Review incomplete:");
    for (const e of r.escalationReasons) out.push(`- ${inline(e)}`);
  }
  return out.join("\n");
}

function modelsSection(d: ReportData): string {
  const rows = ROLES.map((role) => {
    const ref = d.routing[role];
    return [cell(role), cell(`${ref.provider}:${ref.model}`), cell(modelFamily(ref))];
  });
  return [
    table(["role", "model", "family"], rows),
    "",
    `Independence: ${inline(d.routing.independence)}${
      d.routing.independence === "same-family"
        ? " (reduced: a reviewer or the verifier shares the implementer's model family)"
        : ""
    }`,
  ].join("\n");
}

/** M3: what the registry exception really allows depends on the OS sandbox. */
function networkSection(d: ReportData): string {
  const registry =
    (d.platform ?? process.platform) === "linux"
      ? "- verify-registry profile (dependency audit gate only): full network access (bwrap has no domain or port filtering). It is used only when a package manifest or lockfile changed."
      : "- verify-registry profile (dependency audit gate only): any host on port 443, plus DNS (sandbox-exec cannot filter by host name). It is used only when a package manifest or lockfile changed.";
  return `${registry}\n- Every other stage and gate: network denied.`;
}

const REMOVED_CAP = 50;

function removedSection(removed: string[]): string {
  const out = [
    "These gitignored untracked entries were deleted before the gates ran, so the gates saw exactly the tree that is committed:",
    "",
  ];
  for (const r of removed.slice(0, REMOVED_CAP)) out.push(`- ${inline(r)}`);
  if (removed.length > REMOVED_CAP) out.push(`- ... and ${removed.length - REMOVED_CAP} more`);
  return out.join("\n");
}

function roundsSection(d: ReportData): string {
  if (d.rounds.length === 0) return "No fix rounds ran.";
  return table(
    ["round", "score"],
    d.rounds.map((r) => [String(r.round), String(r.score)]),
  );
}

function costSection(d: ReportData): string {
  const rows = ROLES.map((role) => {
    const u = d.usage[role] ?? { inputTokens: 0, outputTokens: 0 };
    return [cell(role), String(u.inputTokens), String(u.outputTokens)];
  });
  return table(["role", "input tokens", "output tokens"], rows);
}

function unresolvedLines(x: GateResult | Finding): string[] {
  if (isFinding(x)) return findingLines(x);
  return [`- gate ${inline(x.gate)} ${inline(x.status)}: ${inline(x.summary)}`];
}

function escalationSection(e: EscalationReport): string {
  const out = [`Reason: ${inline(e.reason)}`, "", "Tried:"];
  if (e.tried.length === 0) out.push("- (nothing)");
  for (const t of e.tried) out.push(`- ${inline(t)}`);
  out.push("", "Unresolved:");
  if (e.unresolved.length === 0) out.push("- (none)");
  for (const u of e.unresolved) out.push(...unresolvedLines(u));
  if (e.details && e.details.length > 0) {
    out.push("", "Details:");
    for (const x of e.details) out.push(`- ${inline(x)}`);
  }
  out.push("", "Hypothesis:", "", fenced(e.hypothesis), "", "Question:", "", fenced(e.question));
  return out.join("\n");
}

function skillsSection(skills: SkillUse[]): string {
  // The name is regex-restricted by the skills package, so it is shown verbatim (redact() would
  // rewrite e.g. "sk-review"); markup characters are still escaped defensively.
  return skills
    .filter((s) => (s.source === "user" || s.source === "repo") && /^[0-9a-f]{64}$/.test(s.sha256))
    .map(
      (s) =>
        `- ${stripControls(s.name)
          .replace(/\r\n?|\n/g, " ")
          .replace(
            MARKUP,
            "\\$&",
          )} (${s.source}, sha256 ${s.sha256.slice(0, 12)}) — ${s.stages.map(inline).join(", ")}`,
    )
    .join("\n");
}

export function renderReport(d: ReportData): string {
  const sections: Array<[string, string]> = [
    ["Status", statusSection(d)],
    ["Contract", contractSection(d)],
    ["Gates", gatesSection(d)],
    ...(d.removedIgnored && d.removedIgnored.length > 0
      ? ([["Ignored files removed", removedSection(d.removedIgnored)]] as Array<[string, string]>)
      : []),
    ["Review", reviewSection(d)],
    ...(d.skillsUsed && d.skillsUsed.length > 0
      ? ([["Skills used", skillsSection(d.skillsUsed)]] as Array<[string, string]>)
      : []),
    ["Models & independence", modelsSection(d)],
    ["Network exceptions", networkSection(d)],
    ["Fix rounds", roundsSection(d)],
    ["Cost", costSection(d)],
    ["Known limitations", d.knownLimitations.map((l) => `- ${inline(l)}`).join("\n")],
  ];
  if (d.status === "escalated" && d.escalation) {
    sections.push(["Escalation", escalationSection(d.escalation)]);
  }
  const body = sections.map(([h, s]) => `## ${h}\n\n${s}`).join("\n\n");
  return `# rewire run ${inline(d.runId)}\n\n${body}\n`;
}
