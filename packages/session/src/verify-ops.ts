import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetRoot, fenceUntrusted, redact, sanitizeTerminal } from "@rewire/core";
import type { Provider } from "@rewire/providers";
import { z } from "zod";
import {
  type CitedMessage,
  cleanText,
  parseJsonReply,
  type RiskyOp,
  type VerifyDecision,
  type VerifyRisky,
} from "./compactor.js";

/**
 * The independent check of risky compaction operations (`isRiskyOp`): one non-streaming call to
 * the run's verifier model (cross-family from the chat author when the routing allows it),
 * batching every risky op of one compaction. It fails safe: a missing decision rejects that op;
 * invalid output after one retry, a provider error or a timeout rejects them all. It never
 * throws.
 */

const PACKAGE_ROOT = assetRoot("session", import.meta.url);

/** Characters of a cited message shown to the verifier. */
export const VERIFY_MESSAGE_CHARS = 2000;
/** Output budget of one verifier call. */
export const VERIFY_MAX_TOKENS = 2000;
/** How long one verifier call may take. */
export const VERIFY_TIMEOUT_MS = 180_000;
/** Characters of a verifier's reason kept in the op log. */
const REASON_MAX = 300;

const VerifyReply = z.object({
  decisions: z
    .array(
      z.object({
        index: z.number().int().min(0),
        verdict: z.enum(["accept", "reject"]),
        reason: z.string().max(10_000).optional(),
      }),
    )
    .max(1000),
});

export type RiskyVerifierOptions = {
  provider: Provider;
  model: string;
  /** Per-call timeout; `VERIFY_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
};

let promptCache: string | undefined;
function verifyPrompt(): string {
  promptCache ??= readFileSync(join(PACKAGE_ROOT, "prompts", "verify-ops.md"), "utf8");
  return promptCache;
}

const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)} [… ${s.length - max} more characters]`;

/** Every string in a model-written value, cleaned (sanitize, redact, flatten). */
function cleanDeep(v: unknown): unknown {
  if (typeof v === "string") return cleanText(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  }
  return v;
}

const claimsUser = (r: RiskyOp): boolean =>
  r.target?.source === "user" ||
  (r.op.op === "add" && r.op.source === "user") ||
  (r.op.op === "supersede" && r.op.by.source === "user");

function citedIds(r: RiskyOp): string[] {
  const ev = [
    ...(r.op.evidence ?? []),
    ...(r.op.op === "supersede" ? (r.op.by.evidence ?? []) : []),
  ];
  return [...new Set(ev.map((e) => e.messageId))];
}

function opBlock(r: RiskyOp, k: number): string {
  const t = r.target;
  const target = t
    ? JSON.stringify(
        cleanDeep({ id: t.id, kind: t.kind, source: t.source, text: t.text, reason: t.reason }),
      )
    : "none (the operation creates a new item)";
  const ids = citedIds(r).map(cleanText);
  return [
    `[op ${k}] ${r.op.op}; claims user authority: ${claimsUser(r) ? "yes" : "no"}`,
    `    operation: ${JSON.stringify(cleanDeep(r.op))}`,
    `    current item: ${target}`,
    `    cites: ${ids.length > 0 ? ids.join(" ") : "(nothing)"}`,
  ].join("\n");
}

function messageLine(id: string, m: CitedMessage | undefined): string {
  if (m === undefined) return `[${cleanText(id)}] (not available)`;
  const where = m.inWindow ? "in the current window" : "outside the current window";
  // Cleaned content is flattened to one line, so it can never start a `[mN …]` line.
  return `[${cleanText(id)} ${m.role}, ${where}] ${cut(cleanText(m.content), VERIFY_MESSAGE_CHARS)}`;
}

function buildPrompt(ops: readonly RiskyOp[], evidence: Record<string, CitedMessage>): string {
  const ids = [...new Set(ops.flatMap(citedIds))];
  return [
    `There are ${ops.length} operations to check, indexed 0 to ${ops.length - 1}.`,
    "The operations, each with the item it changes (if any) and the messages it cites:",
    fenceUntrusted("untrusted_compaction_ops", ops.map(opBlock).join("\n")),
    "The cited messages, each as [id role, window] content:",
    fenceUntrusted(
      "untrusted_messages",
      ids.length > 0 ? ids.map((id) => messageLine(id, evidence[id])).join("\n") : "(none)",
    ),
    'Reply with the JSON object {"decisions": [...]} only, one decision for every index.',
  ].join("\n\n");
}

const errorText = (e: unknown): string =>
  cleanText(e instanceof Error ? e.message : String(e)).slice(0, 300);

class Timeout extends Error {}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ctl.abort();
      rej(new Timeout(`the verifier timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Map the reply onto the batch: a missing index, or one both accepted and rejected, rejects. */
function toDecisions(n: number, reply: z.infer<typeof VerifyReply>): VerifyDecision[] {
  return Array.from({ length: n }, (_, k) => {
    const mine = reply.decisions.filter((d) => d.index === k);
    if (mine.length === 0) return { accept: false, reason: "the verifier gave no decision" };
    const no = mine.find((d) => d.verdict === "reject");
    const d = no ?? mine[0];
    const reason = cleanText(d?.reason ?? "").slice(0, REASON_MAX);
    return { accept: no === undefined, ...(reason ? { reason } : {}) };
  });
}

export function createRiskyVerifier(o: RiskyVerifierOptions): VerifyRisky {
  const timeoutMs = o.timeoutMs ?? VERIFY_TIMEOUT_MS;
  return async (ops, evidence) => {
    if (ops.length === 0) return [];
    const all = (reason: string): VerifyDecision[] => ops.map(() => ({ accept: false, reason }));
    try {
      const system = verifyPrompt();
      const prompt = buildPrompt(ops, evidence);
      let problem = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const content =
          attempt === 0
            ? prompt
            : `${prompt}\n\nYour previous reply was rejected:\n${fenceUntrusted("untrusted_validation_error", redact(sanitizeTerminal(problem)))}\n\nReply again with the JSON object {"decisions": [...]} only.`;
        const resp = await withTimeout(
          (signal) =>
            o.provider.chat({
              model: o.model,
              system,
              messages: [{ role: "user", content }],
              maxTokens: VERIFY_MAX_TOKENS,
              signal,
            }),
          timeoutMs,
        );
        if (resp.stopReason === "length") {
          problem = "the reply was cut off at the output limit; keep each reason short";
          continue;
        }
        if (resp.stopReason === "error") {
          problem = "the provider reported an error for the reply";
          continue;
        }
        const parsed = parseJsonReply(resp.message.text, VerifyReply);
        if (parsed.ok) return toDecisions(ops.length, parsed.value);
        problem = parsed.problem;
      }
      return all(
        `the verifier gave invalid output after one retry: ${cleanText(problem).slice(0, 200)}`,
      );
    } catch (e) {
      return all(`the verifier failed (${errorText(e)})`);
    }
  };
}
