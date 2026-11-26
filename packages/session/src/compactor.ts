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
  PENDING_COMPACTIONS,
  PENDING_MAX,
  type PendingCitation,
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
 * - an item is touched by at most one operation per compaction, and a risky operation
 *   (`isRiskyOp`) is applied only if the verifier accepted it against exactly the item state it
 *   is applied to;
 * - `observed` is recomputed by code, never written by the model;
 * - any failure (invalid output after one retry, a provider error, a broken invariant, an
 *   unavailable verifier, an abort) returns `ok: false` and leaves the caller's record untouched,
 *   so the window does not move and the next compaction can still cite the same messages. An
 *   explicit reject by the verifier drops only that operation. `compact` never throws.
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
/** A message cited by a risky op, as the verifier sees it. */
export type CitedMessage = {
  role: ChatMessage["role"];
  /** Cleaned (sanitized, redacted, flattened) content. */
  content: string;
  /** Whether the message is in the window being compacted now. */
  inWindow: boolean;
  /**
   * Where the user may still be speaking through it: the current `window`, a `recent` user
   * message kept verbatim, a `pending` citation from an earlier rejected op, or `older` context
   * (which cannot show a new change of mind).
   */
  scope: "window" | "recent" | "pending" | "older";
};
/**
 * The cross-check hook (`createRiskyVerifier`). Without it every risky op (`isRiskyOp`) is
 * rejected. `evidence` maps each cited message id to its role, cleaned content and window
 * membership; `target` on each op is the item state the verifier judges. Returns one decision
 * per op, in order; a missing decision rejects that op. Throwing means the check could not be
 * made (timeout, provider error, invalid output, abort): the whole compaction then fails.
 */
export type VerifyRisky = (
  ops: RiskyOp[],
  evidence: Record<string, CitedMessage>,
  signal?: AbortSignal,
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
      truncated?: Truncation & { content: string };
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
  earlier: readonly StoredMessage[],
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
  if (earlier.length > 0) {
    parts.push(
      "Unresolved user messages you may still cite (from before this window: a change an earlier update could not apply, or a recent message kept verbatim):",
      fenceUntrusted("untrusted_earlier_user_messages", earlier.map(messageLine).join("\n")),
    );
  }
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

export type ParsedReply<T> = { ok: true; value: T } | { ok: false; problem: string };

/** How many `{` positions are tried as the start of the reply object. */
const PARSE_CANDIDATES = 20;

/**
 * Parse a model's JSON reply against `schema`. Strips fences and prose: tries the first balanced
 * JSON object, then the next ones (a reply such as `Here {is} my answer: {"ops": []}`), and
 * reports the first candidate's problem. Shared by the compactor and the risky-op verifier.
 *
 * With `strict`, the whole reply (trimmed, optionally inside one ```json fence) must be exactly
 * one JSON object that matches `schema`: no prose, no second object, no echo. The verifier uses
 * it, because there the parse is the decision, and an echoed forged object must never win; the
 * compactor's ops are re-checked by code.
 */
export function parseJsonReply<T>(
  text: string,
  schema: z.ZodType<T>,
  opts: { strict?: boolean } = {},
): ParsedReply<T> {
  if (opts.strict) return parseStrict(text, schema);
  let first: ParsedReply<T> | undefined;
  let from = text.indexOf("{");
  for (let n = 0; n < PARSE_CANDIDATES && from >= 0; n++) {
    const r = parseCandidate(text.slice(from), schema);
    if (r.ok) return r;
    first ??= r;
    from = text.indexOf("{", from + 1);
  }
  return first ?? { ok: false, problem: "no JSON object found in the reply" };
}

const FENCED = /^```(?:json)?[ \t]*\n([\s\S]*)\n[ \t]*```$/;

function parseStrict<T>(text: string, schema: z.ZodType<T>): ParsedReply<T> {
  let body = text.trim();
  const fenced = FENCED.exec(body);
  if (fenced) body = (fenced[1] ?? "").trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (e) {
    return {
      ok: false,
      problem: `the reply must be exactly one JSON object and nothing else (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: schemaProblem(parsed.error) };
  return { ok: true, value: parsed.data };
}

const schemaProblem = (error: z.ZodError): string =>
  `the reply does not match the schema:\n${error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")}`;

function parseCandidate<T>(text: string, schema: z.ZodType<T>): ParsedReply<T> {
  const json = extractFirstJsonObject(text);
  if (json === undefined) return { ok: false, problem: "no complete JSON object in the reply" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, problem: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: schemaProblem(parsed.error) };
  return { ok: true, value: parsed.data };
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
  /** Ids in the current window. */
  window: Set<string>;
  /**
   * Ids user authority may cite: the window, the recent user messages kept verbatim, and the
   * record's pending citations.
   */
  userCitable: Set<string>;
  /** The newest message id in the window: the compaction point. */
  asOf: string;
};

class Reject extends Error {}
/** A failed authority check: not from the user, not citable, or the quote not found. */
class AuthorityReject extends Reject {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};
const rejectAuthority = (reason: string): never => {
  throw new AuthorityReject(reason);
};

/** Check and clean a list of citations; throws `Reject` on the first bad one. */
function checkEvidence(raw: readonly Evidence[] | undefined, ctx: ApplyContext): Evidence[] {
  const list = raw ?? [];
  if (list.length > EVIDENCE_MAX) rejectAuthority(`more than ${EVIDENCE_MAX} citations`);
  return list.map((e) => {
    const id = e.messageId;
    if (!MessageId.safeParse(id).success) rejectAuthority(`evidence cites an invalid message id`);
    if (!ctx.citable.has(id)) rejectAuthority(`evidence cites ${id}, which is not in the window`);
    const m = ctx.byId.get(id);
    if (m === undefined)
      return rejectAuthority(`evidence cites ${id}, which is not a stored message`);
    const quote = cleanText(e.quote);
    if (quote === "") rejectAuthority(`evidence for ${id} has an empty quote`);
    if (quote.length > QUOTE_MAX)
      rejectAuthority(`a quote from ${id} is over ${QUOTE_MAX} characters`);
    const content = cleanText(m.content);
    if (!content.includes(quote)) rejectAuthority(`the quote is not found in ${id}`);
    if (quote.length < Math.min(QUOTE_MIN, content.length)) {
      rejectAuthority(`the quote from ${id} is too short to identify what was said`);
    }
    return { messageId: id, quote };
  });
}

/** The number in a message id (`m12` is 12); ids are checked by `MessageId` before use. */
const messageNumber = (id: string): number => Number(id.slice(1));

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
    if (evidence.length === 0) rejectAuthority("a user item needs evidence from a user message");
    if (!allFromUser(evidence, ctx)) rejectAuthority("a user item may cite only user messages");
    const old = evidence.find((e) => !ctx.userCitable.has(e.messageId));
    if (old) {
      rejectAuthority(
        `a new user item may cite only messages in the window, recent or pending, not ${old.messageId}`,
      );
    }
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
 * `user` item, and any op on an open question (update, resolve or supersede).
 */
export const isRiskyOp = (op: CompactionOp, target?: RecordItem): boolean =>
  target?.source === "user" ||
  (op.op === "add" && op.source === "user") ||
  (op.op === "supersede" && op.by.source === "user") ||
  (op.op !== "add" && target?.kind === "open_question");

/** A verifier decision, with the target state the verifier was shown. */
type Verdict = VerifyDecision & { shown?: RecordItem };

/**
 * The fields of an item the verifier judged; any difference at apply time is `state_changed`.
 * A defensive backstop: `duplicate_target` already makes every target its input state.
 */
export const sameJudgedState = (a: RecordItem | undefined, b: RecordItem | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.text === b.text &&
      a.kind === b.kind &&
      a.source === b.source &&
      a.status === b.status &&
      a.reason === b.reason;

type ApplyOutcome = {
  record: SessionRecord;
  applied: AppliedOp[];
  risky: RiskyOp[];
  /** Ids of user items resolved or superseded by an accepted operation. */
  released: Set<string>;
  /** User messages cited by ops rejected for a reason other than a failed authority check. */
  pending: Set<string>;
};

/**
 * Apply `ops` in order to a copy of `record`. Each operation is checked; a failing one is
 * rejected and logged, and the rest still apply. With `decisions`, a risky operation is accepted
 * only when its decision accepts it and its target is still the state the verifier was shown;
 * without (the dry run), every one that passes the checks is.
 *
 * An item is touched at most once per batch: a later op on an item an earlier op targeted (or
 * created) is `duplicate_target`, whatever happened to the earlier op. So every op's target is
 * the item as it was in `record`, in both passes.
 */
function applyOps(
  record: SessionRecord,
  ops: readonly CompactionOp[],
  ctx: ApplyContext,
  decisions?: Map<number, Verdict>,
): ApplyOutcome {
  const out: SessionRecord = structuredClone(record);
  const applied: AppliedOp[] = [];
  const risky: RiskyOp[] = [];
  const released = new Set<string>();
  const nextId = nextIdFactory(out);
  const original = new Set(record.items.map((i) => i.id));
  const targeted = new Set<string>();
  const pending = new Set<string>();

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
      if (op.op !== "add") {
        if (targeted.has(op.itemId)) {
          reject(`duplicate_target: item ${op.itemId} is already changed in this batch`);
        }
        if (!original.has(op.itemId) && out.items.some((i) => i.id === op.itemId)) {
          reject(`duplicate_target: item ${op.itemId} is created in this batch`);
        }
      }
      const target = op.op === "add" ? undefined : activeTarget(op.itemId);
      const opEvidence = op.op === "add" ? [] : checkEvidence(op.evidence, ctx);
      // A supersede may carry the user's words on the op or on its replacement.
      const authority =
        op.op === "supersede" ? [...opEvidence, ...checkEvidence(op.by.evidence, ctx)] : opEvidence;
      if (target?.source === "user") {
        // Same rule as creating one: cited, every citation from a user message in the window.
        if (authority.length === 0 || !allFromUser(authority, ctx)) {
          rejectAuthority(`changing user item ${target.id} needs evidence from user messages only`);
        }
        const old = authority.find((e) => !ctx.userCitable.has(e.messageId));
        if (old) {
          rejectAuthority(
            `changing user item ${target.id} may cite only messages in the window, recent or pending, not ${old.messageId}`,
          );
        }
        // An older instruction never overturns a newer one: at least one citation must be newer
        // than everything the item already rests on.
        const newest = Math.max(
          -1,
          ...(target.evidence ?? []).map((e) => messageNumber(e.messageId)),
        );
        if (!authority.some((e) => messageNumber(e.messageId) > newest)) {
          rejectAuthority(
            `stale_evidence: changing user item ${target.id} needs a user message newer than m${newest}`,
          );
        }
        // A user item ends only by resolve, or by another user item: never a downgrade.
        if (op.op === "supersede" && op.by.source !== "user") {
          reject(`user item ${target.id} may be superseded only by a user item`);
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
          // A user replacement with its evidence on the op only: that evidence already passed
          // the user-only and in-window checks above, so it serves as the replacement's.
          const by =
            t.source === "user" && op.by.source === "user" && (op.by.evidence ?? []).length === 0
              ? { ...op.by, evidence: op.evidence }
              : op.by;
          const item = newItem(by, ctx, nextId(), opEvidence);
          log.newItemId = item.id;
          commit = () => {
            archive(t, "superseded", item.id);
            out.items.push(item);
          };
          break;
        }
      }
      // The op passed every code check: it claims its item, whatever the verifier says.
      // (An op failing code checks claims nothing, so it can never block a later one.)
      if (op.op !== "add") targeted.add(op.itemId);
      if (isRiskyOp(op, target)) {
        const d = decisions?.get(index);
        // Valid only in the second pass (e.g. a slot freed by a rejection): never sent.
        if (decisions !== undefined && d === undefined) {
          reject("not verified (became valid after a rejection)");
        }
        if (d !== undefined && !d.accept) {
          reject(`not confirmed by the verifier${d.reason ? `: ${cleanText(d.reason)}` : ""}`);
        }
        if (d !== undefined && !sameJudgedState(d.shown, target)) {
          reject(`state_changed: item ${target?.id ?? "?"} is not the state the verifier judged`);
        }
        risky.push({ index, op, ...(target ? { target: structuredClone(target) } : {}) });
      }
      commit();
      log.accepted = true;
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      if (!(e instanceof AuthorityReject)) collectPending(op, ctx, pending);
      log.reason = e.message;
      if (op.op === "add") delete log.itemId;
      delete log.newItemId;
    }
    applied.push(log);
  });
  return { record: out, applied, risky, released, pending };
}

/**
 * The user messages a rejected op cited that may carry a correction: user-role, already
 * citable for user authority, and the quote really in the message. Nothing becomes citable that
 * was not citable already.
 */
function collectPending(op: CompactionOp, ctx: ApplyContext, into: Set<string>): void {
  const cited = [...(op.evidence ?? []), ...(op.op === "supersede" ? (op.by.evidence ?? []) : [])];
  for (const e of cited) {
    const m = ctx.byId.get(e.messageId);
    if (m?.role !== "user" || !ctx.userCitable.has(m.id)) continue;
    const quote = cleanText(e.quote);
    if (quote !== "" && cleanText(m.content).includes(quote)) into.add(m.id);
  }
}

/** Age the record's pending citations by one compaction, then add the new ones (fresh). */
function nextPending(
  before: readonly PendingCitation[],
  fresh: ReadonlySet<string>,
  order: ReadonlyMap<string, number>,
): PendingCitation[] {
  const added = [...fresh]
    .sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0))
    .map((messageId) => ({ messageId, compactionsLeft: PENDING_COMPACTIONS }));
  const aged = before
    .filter((p) => !fresh.has(p.messageId) && p.compactionsLeft > 1)
    .map((p) => ({ messageId: p.messageId, compactionsLeft: p.compactionsLeft - 1 }));
  return [...added, ...aged].slice(0, PENDING_MAX);
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

/** Where a retained message was cut: its first `head` and last `tail` characters are kept. */
export type Truncation = { id: string; head: number; tail: number };

/**
 * `content` cut to its first `head` and last `tail` characters with an omission marker between;
 * undefined unless `head + tail` is less than its length (a cut of exactly that message).
 */
export function cutMessage(content: string, head: number, tail: number): string | undefined {
  if (!(Number.isInteger(head) && Number.isInteger(tail) && head >= 0 && tail >= 0))
    return undefined;
  if (head + tail >= content.length) return undefined;
  const marker = `\n[… ${content.length - head - tail} characters omitted by compaction …]\n`;
  return `${content.slice(0, head)}${marker}${tail > 0 ? content.slice(-tail) : ""}`;
}

function truncateToBudget(
  content: string,
  budget: number,
  est: TokenEstimator,
): { content: string; head: number; tail: number } {
  const size = (s: string) => est.estimate("", [{ role: "user", content: s }]);
  let keep = Math.min(content.length - 1, Math.max(0, Math.floor((budget * 4) / est.ratio) - 100));
  for (;;) {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    const s = cutMessage(content, head, tail) as string;
    if (size(s) <= budget || keep === 0) return { content: s, head, tail };
    keep = Math.max(0, keep - Math.max(16, Math.ceil(keep / 10)));
  }
}

/**
 * The recent user messages kept verbatim: newest first while their tokens fit `budget`; the
 * newest alone over budget is cut (`truncated`). `retainedFrom` is the oldest one kept, null
 * when there is no user message.
 */
export function retain(
  messages: readonly StoredMessage[],
  budget: number,
  est: TokenEstimator,
): { retainedFrom: string | null; truncated?: Truncation & { content: string } } {
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
        truncated: { id: m.id, ...truncateToBudget(m.content, budget, est) },
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

const ABORTED = { ok: false, code: "compaction_invalid", reason: "aborted" } as const;

type Prepared = {
  window: StoredMessage[];
  last: StoredMessage;
  kept: ReturnType<typeof retain>;
  windowIds: Set<string>;
  recent: Set<string>;
  pendingIds: Set<string>;
  userCitable: Set<string>;
  system: string;
  prompt: string;
};

type PrepareInput = Pick<
  CompactInput,
  "record" | "messages" | "since" | "focus" | "recentUserTokens" | "estimator"
>;

/** The window, the retained messages and the first prompt; a failure when there is nothing to ask. */
function prepare(
  input: PrepareInput,
): Prepared | { ok: false; code: "compaction_invalid"; reason: string } {
  const { record, messages } = input;
  const start = input.since === undefined ? 0 : messages.findIndex((m) => m.id === input.since);
  if (start < 0) {
    return { ok: false, code: "compaction_invalid", reason: `unknown message ${input.since}` };
  }
  const window = messages.slice(start);
  const last = window.at(-1);
  if (last === undefined) {
    return { ok: false, code: "compaction_invalid", reason: "no new messages to compact" };
  }

  // Retention depends only on the messages, so it is known before the model is asked.
  const est = input.estimator ?? new TokenEstimator();
  const kept = retain(messages, input.recentUserTokens ?? DEFAULT_RECENT_USER_TOKENS, est);
  const windowIds = new Set(window.map((m) => m.id));
  const keptFrom =
    kept.retainedFrom === null ? -1 : messages.findIndex((m) => m.id === kept.retainedFrom);
  const recent = new Set(
    keptFrom < 0
      ? []
      : messages
          .slice(keptFrom)
          .filter((m) => m.role === "user")
          .map((m) => m.id),
  );
  const pendingIds = new Set((record.pending ?? []).map((p) => p.messageId));
  const userCitable = new Set([...windowIds, ...recent, ...pendingIds]);
  const earlier = messages.filter(
    (m) => m.role === "user" && !windowIds.has(m.id) && (recent.has(m.id) || pendingIds.has(m.id)),
  );
  const system = compactPrompt();
  const prompt = buildPrompt(record, window, earlier, input.focus);
  return { window, last, kept, windowIds, recent, pendingIds, userCitable, system, prompt };
}

/**
 * Estimated input tokens of the first request `compact(input)` would send (its system prompt and
 * its one user message), or undefined when it would fail before asking the model (an unknown
 * `since`, an empty window). Lets the caller split a window that is too big for the model.
 */
export function compactionPromptTokens(input: PrepareInput): number | undefined {
  const p = prepare(input);
  if (!("prompt" in p)) return undefined;
  const est = input.estimator ?? new TokenEstimator();
  return est.estimate(p.system, [{ role: "user", content: p.prompt }]);
}

async function compactInner(input: CompactInput): Promise<CompactResult> {
  const { record, messages, provider, model } = input;
  if (input.signal?.aborted) return ABORTED;
  const prepared = prepare(input);
  if (!("prompt" in prepared)) return prepared;
  const { last, kept, windowIds, recent, pendingIds, userCitable, system, prompt } = prepared;
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
      if (input.signal?.aborted) return ABORTED;
      return { ok: false, code: "compaction_invalid", reason: errorText(e) };
    }
    if (input.signal?.aborted) return ABORTED;
    const parsed = parseJsonReply(reply, CompactionOps);
    if (parsed.ok) ops = parsed.value.ops;
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
  const citable = new Set(userCitable);
  for (const i of [...record.items, ...record.archive]) {
    for (const e of i.evidence ?? []) citable.add(e.messageId);
  }
  const ctx: ApplyContext = { byId, citable, window: windowIds, userCitable, asOf: last.id };

  let outcome = applyOps(record, ops, ctx);
  if (outcome.risky.length > 0 && input.verifyRisky === undefined) {
    // Fail safe: without a verifier, nothing that touches user authority is applied.
    const none = new Map<number, Verdict>(
      outcome.risky.map((r) => [r.index, { accept: false, reason: "no verifier is configured" }]),
    );
    outcome = applyOps(record, ops, ctx, none);
  } else if (input.verifyRisky !== undefined && outcome.risky.length > 0) {
    const evidence: Record<string, CitedMessage> = {};
    for (const r of outcome.risky) {
      const cited = [
        ...(r.op.op === "supersede" ? (r.op.by.evidence ?? []) : []),
        ...(r.op.evidence ?? []),
      ];
      for (const e of cited) {
        const m = byId.get(e.messageId);
        if (m) {
          const scope = windowIds.has(m.id)
            ? "window"
            : m.role === "user" && recent.has(m.id)
              ? "recent"
              : m.role === "user" && pendingIds.has(m.id)
                ? "pending"
                : "older";
          evidence[m.id] = {
            role: m.role,
            content: cleanText(m.content),
            inWindow: scope === "window",
            scope,
          };
        }
      }
    }
    const decisions = new Map<number, Verdict>();
    // The verifier gets deep copies; `shown` keeps our own copy of exactly what it was given.
    const sent = structuredClone(outcome.risky);
    let got: VerifyDecision[];
    try {
      got = await input.verifyRisky(sent, evidence, input.signal);
    } catch (e) {
      // Not a reject: the check could not be made. Keep everything for the next compaction.
      if (input.signal?.aborted) return ABORTED;
      return {
        ok: false,
        code: "compaction_rejected",
        reason: `verifier unavailable: ${errorText(e)}`,
      };
    }
    if (input.signal?.aborted) return ABORTED;
    outcome.risky.forEach((r, k) => {
      const d = got[k] ?? { accept: false, reason: "the verifier gave no decision" };
      decisions.set(r.index, { ...d, ...(r.target ? { shown: r.target } : {}) });
    });
    outcome = applyOps(record, ops, ctx, decisions);
  }

  const next = outcome.record;
  next.observed = observe(messages, { runs: input.runs ?? record.observed.runs });
  next.compactions = record.compactions + 1;
  next.pending = nextPending(
    record.pending ?? [],
    outcome.pending,
    new Map(messages.map((m, k) => [m.id, k])),
  );
  const broken = checkInvariants(record, next, outcome.released);
  if (broken !== undefined) {
    return { ok: false, code: "compaction_rejected", reason: broken, ops: outcome.applied };
  }

  return { ok: true, record: next, ops: outcome.applied, ...kept };
}
