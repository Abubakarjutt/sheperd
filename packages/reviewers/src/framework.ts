import { readFileSync } from "node:fs";
import {
  type Contract,
  Finding,
  fingerprintFinding,
  RewireError,
  type RunEvent,
  type SlopCategory,
} from "@rewire/core";
import type { Policy } from "@rewire/policy";
import { type ModelRef, type Provider, structured } from "@rewire/providers";
import { type CapabilityProfile, profileFor, SandboxClient } from "@rewire/sandbox";
import { z } from "zod";
import type { DiffSummary } from "./diff.js";
import { type Dropped, filterEvidence, readInsideWorktree } from "./evidence.js";
import { wrapUntrusted } from "./untrusted.js";

const SECRET = /(sk-|ghp_|AKIA)[A-Za-z0-9_-]+/g;
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

export type ReviewResult = { kept: Finding[]; dropped: Dropped[] };

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
    // Same relative path from src and dist.
    p = readFileSync(new URL(`../prompts/${file}`, import.meta.url), "utf8");
    promptCache.set(file, p);
  }
  return p;
}

const redact = (s: string): string => s.replace(SECRET, "[redacted]");

const numberLines = (text: string): string =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((l, i) => `${i + 1}| ${l}`)
    .join("\n");

async function changedFiles(input: ReviewerInput, client: SandboxClient): Promise<string> {
  let budget = FILES_BUDGET;
  const parts: string[] = [];
  for (const f of input.diff.files) {
    if (f.addedLines.length === 0) continue;
    const r = await readInsideWorktree(input.worktree, f.path, client);
    if (r.kind !== "ok" || r.text.includes("\0")) continue;
    const body = numberLines(r.text);
    if (body.length > budget) break;
    budget -= body.length;
    parts.push(wrapUntrusted("file", body, { path: f.path }));
  }
  return parts.join("\n\n");
}

/**
 * Run one reviewer: prompt the model for findings, verify each against the real files, keep
 * the verified ones. A reviewer that does not apply returns nothing without a model call. A
 * model that cannot produce valid structured output after one repair makes this REJECT; it is
 * never reported as "no findings" (#22).
 */
export async function runReviewer(def: ReviewerDef, input: ReviewerInput): Promise<ReviewResult> {
  if (!def.appliesTo(input.diff)) return { kept: [], dropped: [] };
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
    const res = await review(def, input, safeEmit, ev);
    ok = true;
    return res;
  } finally {
    safeEmit({ ...ev(), type: "stage_end", ok });
  }
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
    const user = [
      "# Contract (the task under review)",
      wrapUntrusted("contract", JSON.stringify(input.contract, null, 2)),
      "# Diff",
      input.diff.truncated ? "(the diff was truncated; review what is shown)" : "",
      wrapUntrusted("diff", input.diff.patch),
      "# Changed files (each line is prefixed `<n>| `; the prefix is not part of the file and must not appear in evidence)",
      files,
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
    const { kept, dropped } = await filterEvidence(
      candidates,
      input.worktree,
      input.diff,
      input.policy.reviewerMinConfidence,
      { categories: def.categories, client },
    );
    for (const finding of kept) safeEmit({ ...ev(), type: "finding", finding });
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
    return { kept, dropped };
  } finally {
    owned?.dispose();
  }
}
