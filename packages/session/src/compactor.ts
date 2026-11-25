import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetRoot, fenceUntrusted, redact, sanitizeTerminal } from "@rewire/core";
import { DEFAULT_RECENT_USER_TOKENS } from "@rewire/pipeline";
import {
  type ChatMessage,
  extractFirstJsonObject,
  type Provider,
  TokenEstimator,
} from "@rewire/providers";
import { z } from "zod";
import {
  ACTIVE_ITEMS_MAX,
  EVIDENCE_MAX,
  flatten,
  ITEM_KINDS,
  MessageId,
  type ObservedRun,
  observe,
  QUOTE_MAX,
  type RecordItem,
  SessionRecord,
  TEXT_MAX,
} from "./record.js";
import type { StoredMessage } from "./store.js";

/**
 * The compactor: the model proposes operations on the session record, code checks and applies
 * them. This is the authority boundary of compaction:
 *
 * - a `user` item is created, changed, resolved or superseded only by an operation whose
 *   evidence quotes, verbatim, a stored user-role message;
 * - operations cannot delete: an item leaves the active record only through `resolve` or
 *   `supersede`, and goes to the archive;
 * - `observed` is recomputed by code, never written by the model;
 * - any failure (invalid output after one retry, a provider error, a broken invariant) returns
 *   `ok: false` and leaves the caller's record untouched. `compact` never throws.
 */

const PACKAGE_ROOT = assetRoot("session", import.meta.url);

/** Output budget of one compaction call. */
export const COMPACT_MAX_TOKENS = 4000;
/** Characters of a tool result shown to the compactor. */
export const TOOL_RESULT_PROMPT_CHARS = 1000;
/** Characters of an assistant message shown to the compactor (user messages are not cut). */
export const ASSISTANT_PROMPT_CHARS = 2000;
/** Characters of the focus text. */
export const FOCUS_MAX = 1000;
/**
 * A quote shorter than this (after cleaning) must be the whole message: a quote like "the"
 * would let any text claim the authority of any user message.
 */
export const QUOTE_MIN = 12;
/** Raw (pre-cleaning) string cap in the reply schema; the real limits apply after cleaning. */
const RAW_MAX = 10_000;
const RAW_OPS_MAX = 200;

// ---------------------------------------------------------------------------------------------
// The operations schema
// ---------------------------------------------------------------------------------------------

/**
 * Evidence as the model writes it. Ids and lengths are checked per operation after cleaning, so
 * one bad citation rejects that operation, not the whole reply.
 */
const RawEvidence = z.object({
  messageId: z.string().max(64),
  quote: z.string().max(RAW_MAX),
});
const EvidenceList = z.array(RawEvidence).max(20).optional();

const AddPayload = z.object({
  kind: z.enum(ITEM_KINDS),
  text: z.string().max(RAW_MAX),
  reason: z.string().max(RAW_MAX).optional(),
  source: z.enum(["user", "inferred"]),
  evidence: EvidenceList,
});

const ItemId = z.string().min(1).max(64);

export const CompactionOp = z.discriminatedUnion("op", [
  AddPayload.extend({ op: z.literal("add") }),
  z.object({
    op: z.literal("update"),
    itemId: ItemId,
    text: z.string().max(RAW_MAX).optional(),
    reason: z.string().max(RAW_MAX).optional(),
    evidence: EvidenceList,
  }),
  z.object({ op: z.literal("resolve"), itemId: ItemId, evidence: EvidenceList }),
  z.object({ op: z.literal("supersede"), itemId: ItemId, by: AddPayload, evidence: EvidenceList }),
]);
export type CompactionOp = z.infer<typeof CompactionOp>;

/** The compactor's whole reply: operations only. There is no delete. */
export const CompactionOps = z.object({ ops: z.array(CompactionOp).max(RAW_OPS_MAX) });
export type CompactionOps = z.infer<typeof CompactionOps>;

/** One operation's outcome, logged whether it was accepted or not. */
export type AppliedOp = {
  /** Position in the model's reply. */
  index: number;
  op: CompactionOp["op"];
  /** The targeted item (update, resolve, supersede) or the item created (add). */
  itemId?: string;
  /** The item created by a supersede. */
  newItemId?: string;
  accepted: boolean;
  /** Why it was rejected. */
  reason?: string;
};

/** An operation the verifier is asked about: it creates or changes `user` authority. */
export type RiskyOp = { index: number; op: CompactionOp; target?: RecordItem };
export type VerifyDecision = { accept: boolean; reason?: string };
/**
 * The cross-check hook (Task 5). Without it every risky op (`isRiskyOp`) is rejected. `evidence` maps each cited message id to its role and cleaned
 * content. Returns one decision per op, in order; a missing decision rejects that op.
 */
export type VerifyRisky = (
  ops: RiskyOp[],
  evidence: Record<string, { role: ChatMessage["role"]; content: string }>,
) => Promise<VerifyDecision[]>;

export type CompactInput = {
  record: SessionRecord;
  /** Every stored message of the session, with its id (`historyWithIds()`). */
  messages: readonly StoredMessage[];
  /** The id of the first message not yet compacted; the whole history when absent. */
  since?: string;
  /** The user's `/compact <focus>`: guidance only, never evidence. */
  focus?: string;
  provider: Provider;
  model: string;
  /** Tokens of recent user messages kept verbatim (`recent_user_tokens`). */
  recentUserTokens?: number;
  estimator?: TokenEstimator;
  /** Run outcomes for `observed`; the record's previous runs when absent. */
  runs?: readonly ObservedRun[];
  verifyRisky?: VerifyRisky;
  signal?: AbortSignal;
};

export type CompactResult =
  | {
      ok: true;
      record: SessionRecord;
      ops: AppliedOp[];
      /**
       * The oldest message kept verbatim: it and everything after it stay as raw messages. Null
       * when there is no user message to keep.
       */
      retainedFrom: string | null;
      /** Set when the newest user message alone was over budget: its cut content. */
      truncated?: { id: string; content: string };
    }
  | {
      ok: false;
      code: "compaction_invalid" | "compaction_rejected";
      reason: string;
      ops?: AppliedOp[];
    };

// ---------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------

/** Sanitize, then redact (so a secret split by an escape code is rejoined first), then flatten. */
export const cleanText = (s: string): string => flatten(redact(sanitizeTerminal(s)));

// ---------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------

let promptCache: string | undefined;
function compactPrompt(): string {
  promptCache ??= readFileSync(join(PACKAGE_ROOT, "prompts", "compact.md"), "utf8");
  return promptCache;
}

const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)} [… ${s.length - max} more characters]`;

/** Every line after the first is indented, so content can never start a `[mN role]` line. */
const indent = (s: string): string => s.replace(/\n/g, "\n    ");

function messageLine(m: StoredMessage): string {
  let content = m.content;
  if (m.role === "tool") content = cut(content, TOOL_RESULT_PROMPT_CHARS);
  else if (m.role === "assistant") content = cut(content, ASSISTANT_PROMPT_CHARS);
  const calls = (m.role === "assistant" ? (m.toolCalls ?? []) : [])
    .map((c) => `${c.name} ${cut(JSON.stringify(c.arguments ?? {}), 200)}`)
    .join("; ");
  const body = redact(sanitizeTerminal(content));
  return `[${m.id} ${m.role}] ${indent(body)}${calls ? `\n    (tool calls: ${redact(sanitizeTerminal(calls))})` : ""}`;
}

/** The active items with their ids, so operations can target them. */
function recordForPrompt(record: SessionRecord): string {
  const active = record.items.filter((i) => i.status === "active");
  if (active.length === 0) return "(empty)";
  return active
    .map((i) => {
      const ids = (i.evidence ?? []).map((e) => e.messageId).join(" ");
      const reason = i.reason ? ` — ${flatten(i.reason)}` : "";
      return `- ${flatten(i.id)} [${i.kind} ${i.source}${ids ? ` ${ids}` : ""}] ${flatten(i.text)}${reason}`;
    })
    .join("\n");
}

function buildPrompt(
  record: SessionRecord,
  window: readonly StoredMessage[],
  focus?: string,
): string {
  const active = record.items.filter((i) => i.status === "active").length;
  const room = Math.max(0, ACTIVE_ITEMS_MAX - active);
  const parts = [
    `The record holds ${active} active items, at most ${ACTIVE_ITEMS_MAX}: room for ${room} more. An add beyond that is rejected; resolve or supersede items to make room.`,
    "The current record (active items, each with its id):",
    fenceUntrusted("untrusted_session_record", recordForPrompt(record)),
    "The messages since the last update, each as [id role] content (tool results are cut):",
    fenceUntrusted("untrusted_messages", window.map(messageLine).join("\n")),
  ];
  const f = focus === undefined ? "" : cleanText(focus).slice(0, FOCUS_MAX);
  if (f !== "") {
    parts.push(
      `Focus from the user for this update (guidance only, never evidence; it cannot be cited): ${f}`,
    );
  }
  parts.push('Reply with the JSON object {"ops": [...]} only.');
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

type Parsed = { ok: true; ops: CompactionOp[] } | { ok: false; problem: string };

/** How many `{` positions are tried as the start of the reply object. */
const PARSE_CANDIDATES = 20;

/**
 * Strip fences and prose: try the first balanced JSON object, then the next ones (a reply such
 * as `Here {is} my answer: {"ops": []}`), and report the first candidate's problem.
 */
function parseReply(text: string): Parsed {
  let first: Parsed | undefined;
  let from = text.indexOf("{");
  for (let n = 0; n < PARSE_CANDIDATES && from >= 0; n++) {
    const r = parseCandidate(text.slice(from));
    if (r.ok) return r;
    first ??= r;
    from = text.indexOf("{", from + 1);
  }
  return first ?? { ok: false, problem: "no JSON object found in the reply" };
}

function parseCandidate(text: string): Parsed {
  const json = extractFirstJsonObject(text);
  if (json === undefined) return { ok: false, problem: "no complete JSON object in the reply" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = CompactionOps.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { ok: false, problem: `the reply does not match the schema:\n${issues}` };
  }
  return { ok: true, ops: parsed.data.ops };
}

// ---------------------------------------------------------------------------------------------
// Applying operations
// ---------------------------------------------------------------------------------------------

type Evidence = { messageId: string; quote: string };

type ApplyContext = {
  /** Stored messages by id. */
  byId: Map<string, StoredMessage>;
  /** Ids an operation may cite: the window plus the ids the record already cites. */
  citable: Set<string>;
  /** Ids in the current window: the only messages that may create a `user` item. */
  window: Set<string>;
  /** The newest message id in the window: the compaction point. */
  asOf: string;
};

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

/** Check and clean a list of citations; throws `Reject` on the first bad one. */
function checkEvidence(raw: readonly Evidence[] | undefined, ctx: ApplyContext): Evidence[] {
  const list = raw ?? [];
  if (list.length > EVIDENCE_MAX) reject(`more than ${EVIDENCE_MAX} citations`);
  return list.map((e) => {
    const id = e.messageId;
    if (!MessageId.safeParse(id).success) reject(`evidence cites an invalid message id`);
    if (!ctx.citable.has(id)) reject(`evidence cites ${id}, which is not in the window`);
    const m = ctx.byId.get(id);
    if (m === undefined) return reject(`evidence cites ${id}, which is not a stored message`);
    const quote = cleanText(e.quote);
    if (quote === "") reject(`evidence for ${id} has an empty quote`);
    if (quote.length > QUOTE_MAX) reject(`a quote from ${id} is over ${QUOTE_MAX} characters`);
    const content = cleanText(m.content);
    if (!content.includes(quote)) reject(`the quote is not found in ${id}`);
    if (quote.length < Math.min(QUOTE_MIN, content.length)) {
      reject(`the quote from ${id} is too short to identify what was said`);
    }
    return { messageId: id, quote };
  });
}

const allFromUser = (ev: readonly Evidence[], ctx: ApplyContext): boolean =>
  ev.every((e) => ctx.byId.get(e.messageId)?.role === "user");

function cleanField(raw: string, what: string, allowEmpty: boolean): string {
  const s = cleanText(raw);
  if (!allowEmpty && s === "") reject(`${what} is empty`);
  if (s.length > TEXT_MAX) reject(`${what} is over ${TEXT_MAX} characters after cleaning`);
  return s;
}

function nextIdFactory(record: SessionRecord): () => string {
  let n = 0;
  for (const i of [...record.items, ...record.archive]) {
    const m = /^i(\d+)$/.exec(i.id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return () => `i${n++}`;
}

/** Build a new item from an add payload; enforces the `user` authority rule. */
function newItem(
  p: z.infer<typeof AddPayload>,
  ctx: ApplyContext,
  id: string,
  fallbackEvidence: Evidence[] = [],
): RecordItem {
  const text = cleanField(p.text, "text", false);
  const reason = p.reason === undefined ? undefined : cleanField(p.reason, "reason", true);
  const evidence = checkEvidence(p.evidence, ctx);
  if (p.source === "user") {
    if (evidence.length === 0) reject("a user item needs evidence from a user message");
    if (!allFromUser(evidence, ctx)) reject("a user item may cite only user messages");
    const old = evidence.find((e) => !ctx.window.has(e.messageId));
    if (old) reject(`a new user item may cite only messages in the window, not ${old.messageId}`);
  }
  const ev = evidence.length > 0 ? evidence : fallbackEvidence;
  return {
    id,
    kind: p.kind,
    text,
    ...(reason ? { reason } : {}),
    source: p.source,
    ...(ev.length > 0 ? { evidence: ev } : {}),
    status: "active",
    createdAt: ctx.asOf,
    updatedAt: ctx.asOf,
  };
}

/**
 * Ops the verifier must confirm: any op on a `user` item, any add or supersede that creates a
 * `user` item, and resolving an open question.
 */
export const isRiskyOp = (op: CompactionOp, target?: RecordItem): boolean =>
  target?.source === "user" ||
  (op.op === "add" && op.source === "user") ||
  (op.op === "supersede" && op.by.source === "user") ||
  (op.op === "resolve" && target?.kind === "open_question");

type ApplyOutcome = {
  record: SessionRecord;
  applied: AppliedOp[];
  risky: RiskyOp[];
  /** Ids of user items resolved or superseded by an accepted operation. */
  released: Set<string>;
};

/**
 * Apply `ops` in order to a copy of `record`. Each operation is checked; a failing one is
 * rejected and logged, and the rest still apply. With `decisions`, a risky operation is accepted
 * only when its decision accepts it; without (the dry run), every one that passes the checks is.
 */
function applyOps(
  record: SessionRecord,
  ops: readonly CompactionOp[],
  ctx: ApplyContext,
  decisions?: Map<number, VerifyDecision>,
): ApplyOutcome {
  const out: SessionRecord = structuredClone(record);
  const applied: AppliedOp[] = [];
  const risky: RiskyOp[] = [];
  const released = new Set<string>();
  const nextId = nextIdFactory(out);

  const activeTarget = (itemId: string): RecordItem => {
    const t = out.items.find((i) => i.id === itemId);
    if (t === undefined) return reject(`item ${itemId} is not in the record`);
    if (t.status !== "active") reject(`item ${itemId} is not active`);
    return t;
  };
  const archive = (t: RecordItem, status: "resolved" | "superseded", by?: string) => {
    out.items = out.items.filter((i) => i !== t);
    t.status = status;
    t.updatedAt = ctx.asOf;
    if (by !== undefined) t.supersededBy = by;
    out.archive.push(t);
    if (t.source === "user") released.add(t.id);
  };

  ops.forEach((op, index) => {
    const log: AppliedOp = { index, op: op.op, accepted: false };
    if (op.op !== "add") log.itemId = op.itemId;
    try {
      const target = op.op === "add" ? undefined : activeTarget(op.itemId);
      const opEvidence = op.op === "add" ? [] : checkEvidence(op.evidence, ctx);
      // A supersede may carry the user's words on the op or on its replacement.
      const authority =
        op.op === "supersede" ? [...opEvidence, ...checkEvidence(op.by.evidence, ctx)] : opEvidence;
      if (target?.source === "user") {
        // Same rule as creating one: cited, and every citation from a user message.
        if (authority.length === 0 || !allFromUser(authority, ctx)) {
          reject(`changing user item ${target.id} needs evidence from user messages only`);
        }
      }
      if ((op.op === "resolve" || op.op === "supersede") && authority.length === 0) {
        reject(`${op.op} needs evidence`);
      }
      // Build everything first so a rejected op leaves no trace.
      let commit: () => void;
      switch (op.op) {
        case "add": {
          const active = out.items.filter((i) => i.status === "active").length;
          if (active >= ACTIVE_ITEMS_MAX) {
            reject(`item_cap: the record already holds ${ACTIVE_ITEMS_MAX} active items`);
          }
          const item = newItem(op, ctx, nextId());
          log.itemId = item.id;
          commit = () => out.items.push(item);
          break;
        }
        case "update": {
          const t = target as RecordItem;
          if (op.text === undefined && op.reason === undefined)
            reject("the update changes nothing");
          const text = op.text === undefined ? undefined : cleanField(op.text, "text", false);
          const reason =
            op.reason === undefined ? undefined : cleanField(op.reason, "reason", true);
          commit = () => {
            if (text !== undefined) t.text = text;
            if (reason !== undefined) {
              if (reason === "") delete t.reason;
              else t.reason = reason;
            }
            if (opEvidence.length > 0) {
              t.evidence = [...(t.evidence ?? []), ...opEvidence].slice(-EVIDENCE_MAX);
            }
            t.updatedAt = ctx.asOf;
          };
          break;
        }
        case "resolve": {
          const t = target as RecordItem;
          commit = () => archive(t, "resolved");
          break;
        }
        case "supersede": {
          const t = target as RecordItem;
          const item = newItem(op.by, ctx, nextId(), opEvidence);
          log.newItemId = item.id;
          commit = () => {
            archive(t, "superseded", item.id);
            out.items.push(item);
          };
          break;
        }
      }
      if (isRiskyOp(op, target)) {
        const d = decisions?.get(index);
        if (decisions !== undefined && d?.accept !== true) {
          reject(`not confirmed by the verifier${d?.reason ? `: ${cleanText(d.reason)}` : ""}`);
        }
        risky.push({ index, op, ...(target ? { target: structuredClone(target) } : {}) });
      }
      commit();
      log.accepted = true;
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      log.reason = e.message;
      if (op.op === "add") delete log.itemId;
      delete log.newItemId;
    }
    applied.push(log);
  });
  return { record: out, applied, risky, released };
}

/**
 * The whole-result invariants. Returns why `after` is unacceptable, or undefined. `released` is
 * the set of user item ids an accepted operation resolved or superseded.
 */
export function checkInvariants(
  before: SessionRecord,
  after: SessionRecord,
  released: ReadonlySet<string>,
): string | undefined {
  const activeAfter = new Set(after.items.filter((i) => i.status === "active").map((i) => i.id));
  const archived = new Set(after.archive.map((i) => i.id));
  for (const i of before.items) {
    if (i.source !== "user" || i.status !== "active") continue;
    if (activeAfter.has(i.id)) continue;
    if (released.has(i.id) && archived.has(i.id)) continue;
    return `user item ${i.id} would be lost`;
  }
  const active = after.items.filter((i) => i.status === "active").length;
  if (active > ACTIVE_ITEMS_MAX) {
    return `the record would have ${active} active items (at most ${ACTIVE_ITEMS_MAX})`;
  }
  const parsed = SessionRecord.safeParse(after);
  if (!parsed.success) {
    return `the record does not validate: ${parsed.error.issues[0]?.message ?? "invalid"}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Retained messages
// ---------------------------------------------------------------------------------------------

function truncateToBudget(content: string, budget: number, est: TokenEstimator): string {
  const size = (s: string) => est.estimate("", [{ role: "user", content: s }]);
  let keep = Math.max(0, Math.floor((budget * 4) / est.ratio) - 100);
  for (;;) {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const marker = `\n[… ${content.length - keep} characters omitted by compaction …]\n`;
    const s = `${content.slice(0, head)}${marker}${tail > 0 ? content.slice(-tail) : ""}`;
    if (size(s) <= budget || keep === 0) return s;
    keep = Math.max(0, keep - Math.max(16, Math.ceil(keep / 10)));
  }
}

function retain(
  messages: readonly StoredMessage[],
  budget: number,
  est: TokenEstimator,
): { retainedFrom: string | null; truncated?: { id: string; content: string } } {
  let used = 0;
  let from: string | null = null;
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k] as StoredMessage;
    if (m.role !== "user") continue;
    const t = est.estimate("", [{ role: "user", content: m.content }]);
    if (used + t <= budget) {
      used += t;
      from = m.id;
      continue;
    }
    if (from === null) {
      return {
        retainedFrom: m.id,
        truncated: { id: m.id, content: truncateToBudget(m.content, budget, est) },
      };
    }
    break;
  }
  return { retainedFrom: from };
}

// ---------------------------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------------------------

const errorText = (e: unknown): string =>
  cleanText(e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * One compaction: ask the model for operations (one retry on invalid output), check and apply
 * them, check the whole result, recompute `observed` and pick the retained messages. Never
 * throws; on failure the caller keeps its previous record (which is never mutated).
 */
export async function compact(input: CompactInput): Promise<CompactResult> {
  try {
    return await compactInner(input);
  } catch (e) {
    return { ok: false, code: "compaction_invalid", reason: errorText(e) };
  }
}

async function compactInner(input: CompactInput): Promise<CompactResult> {
  const { record, messages, provider, model } = input;
  const start = input.since === undefined ? 0 : messages.findIndex((m) => m.id === input.since);
  if (start < 0) {
    return { ok: false, code: "compaction_invalid", reason: `unknown message ${input.since}` };
  }
  const window = messages.slice(start);
  const last = window.at(-1);
  if (last === undefined) {
    return { ok: false, code: "compaction_invalid", reason: "no new messages to compact" };
  }

  const system = compactPrompt();
  const prompt = buildPrompt(record, window, input.focus);
  let ops: CompactionOp[] | undefined;
  let problem = "";
  for (let attempt = 0; attempt < 2 && ops === undefined; attempt++) {
    const content =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply was rejected:\n${fenceUntrusted("untrusted_validation_error", redact(sanitizeTerminal(problem)))}\n\nReply again with the JSON object {"ops": [...]} only.`;
    let reply: string;
    try {
      const resp = await provider.chat({
        model,
        system,
        messages: [{ role: "user", content }],
        maxTokens: COMPACT_MAX_TOKENS,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      reply = resp.message.text;
      if (resp.stopReason === "length") {
        problem = "the reply was cut off at the output limit; reply with fewer operations";
        continue;
      }
      if (resp.stopReason === "error") {
        problem = "the provider reported an error for the reply";
        continue;
      }
    } catch (e) {
      return { ok: false, code: "compaction_invalid", reason: errorText(e) };
    }
    const parsed = parseReply(reply);
    if (parsed.ok) ops = parsed.ops;
    else problem = parsed.problem;
  }
  if (ops === undefined) {
    return {
      ok: false,
      code: "compaction_invalid",
      reason: `invalid output after one retry: ${cleanText(problem).slice(0, 500)}`,
    };
  }

  const byId = new Map(messages.map((m) => [m.id, m]));
  const citable = new Set(window.map((m) => m.id));
  for (const i of [...record.items, ...record.archive]) {
    for (const e of i.evidence ?? []) citable.add(e.messageId);
  }
  const ctx: ApplyContext = {
    byId,
    citable,
    window: new Set(window.map((m) => m.id)),
    asOf: last.id,
  };

  let outcome = applyOps(record, ops, ctx);
  if (outcome.risky.length > 0 && input.verifyRisky === undefined) {
    // Fail safe: without a verifier, nothing that touches user authority is applied.
    const none = new Map<number, VerifyDecision>(
      outcome.risky.map((r) => [r.index, { accept: false, reason: "no verifier is configured" }]),
    );
    outcome = applyOps(record, ops, ctx, none);
  } else if (input.verifyRisky !== undefined && outcome.risky.length > 0) {
    const evidence: Record<string, { role: ChatMessage["role"]; content: string }> = {};
    for (const r of outcome.risky) {
      const cited = [
        ...(r.op.op === "supersede" ? (r.op.by.evidence ?? []) : []),
        ...(r.op.evidence ?? []),
      ];
      for (const e of cited) {
        const m = byId.get(e.messageId);
        if (m) evidence[m.id] = { role: m.role, content: cleanText(m.content) };
      }
    }
    const decisions = new Map<number, VerifyDecision>();
    try {
      const got = await input.verifyRisky(outcome.risky, evidence);
      outcome.risky.forEach((r, k) => {
        const d = got[k];
        if (d !== undefined) decisions.set(r.index, d);
      });
    } catch (e) {
      for (const r of outcome.risky) {
        decisions.set(r.index, { accept: false, reason: `the check failed (${errorText(e)})` });
      }
    }
    outcome = applyOps(record, ops, ctx, decisions);
  }

  const next = outcome.record;
  next.observed = observe(messages, { runs: input.runs ?? record.observed.runs });
  next.compactions = record.compactions + 1;
  const broken = checkInvariants(record, next, outcome.released);
  if (broken !== undefined) {
    return { ok: false, code: "compaction_rejected", reason: broken, ops: outcome.applied };
  }

  const est = input.estimator ?? new TokenEstimator();
  const kept = retain(messages, input.recentUserTokens ?? DEFAULT_RECENT_USER_TOKENS, est);
  return { ok: true, record: next, ops: outcome.applied, ...kept };
}
