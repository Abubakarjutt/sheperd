import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Contract,
  Finding,
  fingerprintFinding,
  RewireError,
  type RunEvent,
  redact,
  type SlopCategory,
} from "@rewire/core";
import type { Policy } from "@rewire/policy";
import { type ModelRef, type Provider, structured } from "@rewire/providers";
import { type CapabilityProfile, profileFor, SandboxClient } from "@rewire/sandbox";
import { z } from "zod";
import { PACKAGE_ROOT } from "./assets.js";
import type { DiffSummary } from "./diff.js";
import { type Dropped, filterEvidence, readInsideWorktree } from "./evidence.js";
import { wrapUntrusted } from "./untrusted.js";

const FILES_BUDGET = 200 * 1024;
const SUMMARY_CAP = 300;

export type ReviewerDef = {
  name: string;
  categories: SlopCategory[];
  /** File name under `prompts/` (a plain `<name>.md`). */
  promptFile: string;
  appliesTo(diff: DiffSummary): boolean;
};

export type ReviewerInput = {
  diff: DiffSummary;
  contract: Contract;
  worktree: string;
  model: ModelRef;
  provider: Provider;
  /** Required: the framework never invents a policy (#20). */
  policy: Policy;
  emit: (e: RunEvent) => void;
  runId: string;
  signal?: AbortSignal;
  /** Test seam: a caller-owned review client. It is not disposed here. */
  client?: SandboxClient;
  /** Test seam: builds the client from the review profile. runReviewer disposes what it builds. */
  clientFactory?: (profile: CapabilityProfile) => SandboxClient;
};

export type ReviewResult = {
  kept: Finding[];
  dropped: Dropped[];
  /** True when the reviewer did not apply to the diff and no model was called. */
  skipped?: true;
  /** Everything the reviewer could not see (diff and prompt omissions). Escalate on non-empty. */
  omitted: string[];
};

const ReviewerOutput = z.object({
  findings: z.array(Finding.omit({ id: true, reviewer: true })),
});

const promptCache = new Map<string, string>();
function prompt(file: string): string {
  if (!/^[A-Za-z0-9_-]+\.md$/.test(file)) {
    throw new RewireError("invalid_prompt_file", `invalid reviewer prompt file: ${file}`);
  }
  let p = promptCache.get(file);
  if (p === undefined) {
    p = readFileSync(join(PACKAGE_ROOT, "prompts", file), "utf8");
    promptCache.set(file, p);
  }
  return p;
}

const numberLines = (text: string): string =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((l, i) => `${i + 1}| ${l}`)
    .join("\n");

async function changedFiles(
  input: ReviewerInput,
  client: SandboxClient,
): Promise<{ text: string; omitted: string[] }> {
  let budget = FILES_BUDGET;
  const parts: string[] = [];
  const omitted: string[] = [];
  for (const f of input.diff.files) {
    if (f.addedLines.length === 0) continue;
    const r = await readInsideWorktree(input.worktree, f.path, client);
    if (r.kind !== "ok" || r.text.includes("\0")) {
      omitted.push(`${f.path} (${r.kind === "ok" ? "contains NUL bytes" : r.kind})`);
      continue;
    }
    const body = numberLines(r.text);
    if (body.length > budget) {
      omitted.push(`${f.path} (over prompt budget)`);
      continue;
    }
    budget -= body.length;
    parts.push(wrapUntrusted("file", body, { path: f.path }));
  }
  return { text: parts.join("\n\n"), omitted };
}

/**
 * Run one reviewer: prompt the model for findings, verify each against the real files, keep
 * the verified ones. A reviewer that does not apply returns nothing without a model call. A
 * model that cannot produce valid structured output after one repair makes this REJECT; it is
 * never reported as "no findings" (#22).
 */
export async function runReviewer(def: ReviewerDef, input: ReviewerInput): Promise<ReviewResult> {
  const { runId } = input;
  const safeEmit = (e: RunEvent): void => {
    try {
      const r: unknown = input.emit(e);
      Promise.resolve(r).catch(() => {});
    } catch {
      // Observers must never break the reviewer.
    }
  };
  const ev = () => ({ runId, ts: new Date().toISOString(), stage: def.name });

  safeEmit({ ...ev(), type: "stage_start" });
  let ok = false;
  try {
    if (!def.appliesTo(input.diff)) {
      safeEmit({
        ...ev(),
        type: "tool_call",
        tool: "reviewer_skipped",
        isError: false,
        summary: "skipped: reviewer does not apply to this diff",
      });
      // A skipped reviewer still carries the forced findings and the omissions.
      const kept = forcedFindings(def, input.diff);
      for (const finding of kept)
        safeEmit({ ...ev(), type: "finding", finding: cleanFinding(finding) });
      ok = true;
      return { kept, dropped: [], skipped: true, omitted: [...new Set(input.diff.omitted)] };
    }
    const res = await review(def, input, safeEmit, ev);
    ok = true;
    return res;
  } finally {
    safeEmit({ ...ev(), type: "stage_end", ok });
  }
}

const cleanFinding = (f: Finding): Finding => ({
  ...f,
  evidence: redact(f.evidence),
  failureScenario: redact(f.failureScenario),
  suggestedFix: redact(f.suggestedFix),
});

/** Mandatory `security` findings decided by code (NUL bytes, protected git files). */
function forcedFindings(def: ReviewerDef, diff: DiffSummary): Finding[] {
  return forcedFindingsFor(def.name, diff);
}

/** Forced findings as reviewer `reviewer` would emit them (ids depend on the reviewer name). */
export function forcedFindingsFor(reviewer: string, diff: DiffSummary): Finding[] {
  return diff.forced.map((f) => {
    const full = {
      ...f,
      category: "security" as const,
      severity: 3 as const,
      confidence: 1,
      suggestedFix: "",
      id: "",
      reviewer,
    };
    return { ...full, id: fingerprintFinding(full).slice(0, 16) };
  });
}

async function review(
  def: ReviewerDef,
  input: ReviewerInput,
  safeEmit: (e: RunEvent) => void,
  ev: () => { runId: string; ts: string; stage: string },
): Promise<ReviewResult> {
  const system = [prompt("_base.md"), def.promptFile === "_base.md" ? "" : prompt(def.promptFile)]
    .filter((s) => s !== "")
    .join("\n\n");

  let owned: SandboxClient | undefined;
  let client = input.client;
  if (client === undefined) {
    const profile = profileFor("review", input.worktree, input.policy, input.worktree);
    owned = input.clientFactory ? input.clientFactory(profile) : new SandboxClient(profile);
    client = owned;
  }
  try {
    const files = await changedFiles(input, client);
    const omitted = [...input.diff.omitted, ...files.omitted];
    const user = [
      "# Contract (the task under review)",
      wrapUntrusted("contract", JSON.stringify(input.contract, null, 2)),
      "# Diff",
      input.diff.truncated ? "(the diff was truncated; review what is shown)" : "",
      wrapUntrusted(
        "diff",
        omitted.length > 0
          ? `${input.diff.patch}\n[escalation items, not reviewed as text (path (reason)): ${omitted.join(", ")}]`
          : input.diff.patch,
      ),
      "# Changed files (each line is prefixed `<n>| `; the prefix is not part of the file and must not appear in evidence)",
      files.text,
      "Review now. Reply with the JSON object only.",
    ]
      .filter((s) => s !== "")
      .join("\n\n");

    const out = await structured(input.provider, input.model, ReviewerOutput, {
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 8192,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const candidates: Finding[] = out.findings.map((f) => {
      const full = { ...f, id: "", reviewer: def.name };
      return { ...full, id: fingerprintFinding(full).slice(0, 16) };
    });
    const verified = await filterEvidence(
      candidates,
      input.worktree,
      input.diff,
      input.policy.reviewerMinConfidence,
      { categories: def.categories, client },
    );
    const { dropped } = verified;
    const kept = [...forcedFindings(def, input.diff), ...verified.kept];
    for (const finding of kept) {
      safeEmit({ ...ev(), type: "finding", finding: cleanFinding(finding) });
    }
    for (const d of dropped) {
      const where = `${d.finding.file}:${d.finding.lineStart}-${d.finding.lineEnd}`;
      safeEmit({
        ...ev(),
        type: "tool_call",
        tool: "finding_dropped",
        isError: false,
        summary: redact(`${d.reason}: ${d.finding.category} ${where}`).slice(0, SUMMARY_CAP),
      });
    }
    return { kept, dropped, omitted: [...new Set(omitted)] };
  } finally {
    owned?.dispose();
  }
}
