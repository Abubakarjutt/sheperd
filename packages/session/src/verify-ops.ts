import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetRoot, fenceUntrusted, redact, sanitizeTerminal } from "@rewire/core";
import { cloudClaudeId, type ModelRef, type Provider } from "@rewire/providers";
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
 * batching every risky op of one compaction that fits the prompt budget.
 *
 * - An explicit `reject`, a missing decision, or an op over the prompt budget
 *   (`verification_budget`) rejects that op only.
 * - When the check cannot be made (a timeout, a provider error, a reply cut off at the output
 *   limit, invalid or ambiguous output after one retry, an abort) it throws
 *   `VerifierUnavailable`, and `compact()` fails as a whole: the record and the window stay as
 *   they were, so the next compaction can still cite the same messages.
 */

const PACKAGE_ROOT = assetRoot("session", import.meta.url);

/** Characters of a cited message shown to the verifier. */
export const VERIFY_MESSAGE_CHARS = 2000;
/** The whole verifier prompt (the retry included) stays within this many characters. */
export const VERIFY_PROMPT_CHARS = 60_000;
/** Output budget of one verifier call; it grows with the batch, up to `VERIFY_MAX_TOKENS_CAP`. */
export const VERIFY_MAX_TOKENS = 2000;
const VERIFY_MAX_TOKENS_CAP = 8000;
const TOKENS_PER_DECISION = 100;
/** How long the check may take, both attempts together. */
export const VERIFY_TIMEOUT_MS = 180_000;
/** Characters of a verifier's reason kept in the op log. */
const REASON_MAX = 300;
/** Room kept for the instructions, the fences and the retry's validation error. */
const PROMPT_OVERHEAD = 3000;

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

/** The check could not be made; the compaction must fail, not apply a partial result. */
export class VerifierUnavailable extends Error {}

export type RiskyVerifierOptions = {
  provider: Provider;
  model: string;
  /** The verifier's provider name, for `independent`. */
  providerName?: string;
  /** The chat author's model; `independent` is false when the verifier is the same model. */
  author?: ModelRef;
  /** Deadline for the whole check (both attempts); `VERIFY_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
};

/**
 * The hook, plus `independent`: false when the verifier is the author's very model (same model id
 * and, when given, provider; or the same Claude model on two Claude platforms). This is model-level only: a different model of the same family
 * counts as independent. Family independence comes from routing (`independence`), which the
 * caller should use for any notice.
 */
export type RiskyVerifier = VerifyRisky & { readonly independent: boolean };

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

const WHERE: Record<CitedMessage["scope"], string> = {
  window: "in the current window",
  recent: "a recent message kept verbatim",
  pending: "unresolved from an earlier update",
  older: "outside the current window",
};

function messageLine(id: string, m: CitedMessage | undefined): string {
  if (m === undefined) return `[${cleanText(id)}] (not available)`;
  const where = WHERE[m.scope ?? (m.inWindow ? "window" : "older")];
  // Cleaned content is flattened to one line, so it can never start a `[mN …]` line.
  return `[${cleanText(id)} ${m.role}, ${where}] ${cut(cleanText(m.content), VERIFY_MESSAGE_CHARS)}`;
}

/**
 * Fit ops into the prompt budget, in order: an op fits when its block and the cited messages not
 * yet listed fit in what is left. Ops that do not fit are skipped; later, smaller ones may fit.
 */
function fitBudget(
  ops: readonly RiskyOp[],
  evidence: Record<string, CitedMessage>,
): { sent: number[]; ids: string[] } {
  const budget = VERIFY_PROMPT_CHARS - PROMPT_OVERHEAD;
  const sent: number[] = [];
  const ids: string[] = [];
  const listed = new Set<string>();
  let used = 0;
  ops.forEach((r, k) => {
    const fresh = citedIds(r).filter((id) => !listed.has(id));
    const size =
      opBlock(r, sent.length).length +
      1 +
      fresh.reduce((n, id) => n + messageLine(id, evidence[id]).length + 1, 0);
    if (used + size > budget) return;
    used += size;
    sent.push(k);
    for (const id of fresh) {
      listed.add(id);
      ids.push(id);
    }
  });
  return { sent, ids };
}

function buildPrompt(
  ops: readonly RiskyOp[],
  ids: readonly string[],
  evidence: Record<string, CitedMessage>,
): string {
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

/** `850 ms`, `2 s`, `1.5 s`. */
const duration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`;

/**
 * Run one call against the overall deadline and the caller's signal. Either one aborts the call
 * at once and rejects, even when the provider ignores its signal; timers and listeners are
 * always cleared.
 */
async function guarded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, rej) => {
    const left = deadline - Date.now();
    const expire = () => {
      ctl.abort();
      rej(new VerifierUnavailable(`timed out after ${duration(timeoutMs)}`));
    };
    if (left <= 0) expire();
    else timer = setTimeout(expire, left);
    onAbort = () => {
      ctl.abort();
      rej(new VerifierUnavailable("aborted"));
    };
    if (outer?.aborted) onAbort();
    else outer?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(ctl.signal), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) outer?.removeEventListener("abort", onAbort);
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

/** Claude's own API and the clouds that serve the same Claude models under their own ids. */
const CLAUDE_PLATFORMS: ReadonlySet<string> = new Set([
  "anthropic",
  "bedrock",
  "vertex",
  "foundry",
]);

/**
 * Whether the verifier (`model` on `providerName`) is the author's very model: the same id (and
 * provider, when given), or the same Claude model on two Claude platforms
 * (`vertex:claude-opus-5-5` and `anthropic:claude-opus-5-5`).
 */
function sameModel(author: ModelRef, model: string, providerName: string | undefined): boolean {
  if (author.model === model && (providerName === undefined || author.provider === providerName)) {
    return true;
  }
  return (
    providerName !== undefined &&
    CLAUDE_PLATFORMS.has(author.provider) &&
    CLAUDE_PLATFORMS.has(providerName) &&
    cloudClaudeId(author.model) === cloudClaudeId(model)
  );
}

export function createRiskyVerifier(o: RiskyVerifierOptions): RiskyVerifier {
  const timeoutMs = o.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const independent = !(o.author !== undefined && sameModel(o.author, o.model, o.providerName));
  const verify: VerifyRisky = async (ops, evidence, signal) => {
    if (signal?.aborted) throw new VerifierUnavailable("aborted");
    const { sent, ids } = fitBudget(ops, evidence);
    const out: VerifyDecision[] = ops.map(() => ({
      accept: false,
      reason: "verification_budget: the op did not fit the verifier prompt",
    }));
    if (sent.length === 0) return out;
    const batch = sent.map((k) => ops[k] as RiskyOp);
    const deadline = Date.now() + timeoutMs;
    const system = verifyPrompt();
    const prompt = buildPrompt(batch, ids, evidence);
    const maxTokens = Math.min(
      VERIFY_MAX_TOKENS_CAP,
      Math.max(VERIFY_MAX_TOKENS, TOKENS_PER_DECISION * batch.length),
    );
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const content =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply was rejected:\n${fenceUntrusted("untrusted_validation_error", redact(sanitizeTerminal(problem)).slice(0, 500))}\n\nReply again with exactly one JSON object {"decisions": [...]} and nothing else.`;
      let resp: Awaited<ReturnType<Provider["chat"]>>;
      try {
        resp = await guarded(
          (s) =>
            o.provider.chat({
              model: o.model,
              system,
              messages: [{ role: "user", content }],
              maxTokens,
              signal: s,
            }),
          deadline,
          timeoutMs,
          signal,
        );
      } catch (e) {
        if (e instanceof VerifierUnavailable) throw e;
        throw new VerifierUnavailable(errorText(e));
      }
      // A retry with the same batch and budget would be cut off again.
      if (resp.stopReason === "length") {
        throw new VerifierUnavailable("the reply was cut off at the output limit");
      }
      if (resp.stopReason === "error") {
        problem = "the provider reported an error for the reply";
        continue;
      }
      const parsed = parseJsonReply(resp.message.text, VerifyReply, { strict: true });
      if (parsed.ok) {
        toDecisions(batch.length, parsed.value).forEach((d, j) => {
          out[sent[j] as number] = d;
        });
        return out;
      }
      problem = parsed.problem;
    }
    throw new VerifierUnavailable(
      `invalid output after one retry: ${cleanText(problem).slice(0, 200)}`,
    );
  };
  return Object.assign(verify, { independent });
}
