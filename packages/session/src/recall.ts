import { defangUntrustedClosers, fenceUntrusted, redact, sanitizeTerminal } from "@rewire/core";
import type { AgentTool, ToolResult } from "@rewire/loop";
import { flatten, type RecordItem } from "./record.js";
import type { StoredMessage } from "./store.js";

/**
 * The chat agent's `recall` tool: a read-only search of the whole stored conversation and the
 * record's archive, so details a compaction dropped from the model-visible context stay
 * reachable. Plain case-insensitive substring matching: the query is never a pattern. Never
 * available in pipeline stages (it is built only by `ChatSession`).
 */

export const RECALL_MAX_MATCHES = 10;
/** Characters of each snippet, around the match. */
export const RECALL_SNIPPET_CHARS = 400;
/** The whole tool result, fence included, in UTF-8 bytes. */
export const RECALL_OUTPUT_BYTES = 4096;
export const RECALL_QUERY_MAX = 200;
const LABEL = "untrusted_recall";

export type RecallSource = {
  /** Every stored message of the session, with ids. */
  messages: readonly StoredMessage[];
  /** Resolved and superseded record items. */
  archive: readonly RecordItem[];
};

/** Sanitize, then redact the whole text, then collapse whitespace: what is searched and shown. */
const clean = (s: string): string => flatten(redact(sanitizeTerminal(s)));

type Entry = { tag: string; text: string };

/** Searchable entries, newest first: messages (earlier recall results left out), then the archive. */
function entries(src: RecallSource): Entry[] {
  const recallCalls = new Set<string>();
  for (const m of src.messages) {
    for (const c of m.toolCalls ?? []) if (c.name === "recall") recallCalls.add(c.id);
  }
  const out: Entry[] = [];
  for (let k = src.messages.length - 1; k >= 0; k--) {
    const m = src.messages[k] as StoredMessage;
    if (m.role === "tool" && m.toolCallId !== undefined && recallCalls.has(m.toolCallId)) continue;
    const calls = (m.toolCalls ?? [])
      .map((c) => `${c.name} ${JSON.stringify(c.arguments ?? {})}`)
      .join("; ");
    const text = clean(calls === "" ? m.content : `${m.content} (tool calls: ${calls})`);
    out.push({ tag: `${m.id} ${m.role}`, text });
  }
  for (let k = src.archive.length - 1; k >= 0; k--) {
    const i = src.archive[k] as RecordItem;
    out.push({
      tag: `${i.id} archived ${i.kind} ${i.status}`,
      text: clean(i.reason ? `${i.text} — ${i.reason}` : i.text),
    });
  }
  return out;
}

/** About `RECALL_SNIPPET_CHARS` characters of `text` around index `at`, never splitting a surrogate pair. */
function snippet(text: string, at: number, len: number): string {
  if (text.length <= RECALL_SNIPPET_CHARS) return text;
  let start = Math.max(0, at - Math.floor((RECALL_SNIPPET_CHARS - len) / 2));
  let end = Math.min(text.length, start + RECALL_SNIPPET_CHARS);
  start = Math.max(0, end - RECALL_SNIPPET_CHARS);
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const error = (content: string): ToolResult => ({ content, isError: true });

/** One `recall` call: up to `limit` (at most 10) matches, cleaned, capped at 4 KB and fenced. */
export function recall(src: RecallSource, args: { query?: unknown; limit?: unknown }): ToolResult {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    return error("recall needs a non-empty query");
  }
  const query = clean(args.query);
  if (query === "" || query.length > RECALL_QUERY_MAX) {
    return error(`the query must be 1 to ${RECALL_QUERY_MAX} characters of plain text`);
  }
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit >= 1
      ? Math.min(RECALL_MAX_MATCHES, Math.floor(args.limit))
      : RECALL_MAX_MATCHES;
  const needle = query.toLowerCase();
  const found: string[] = [];
  for (const e of entries(src)) {
    if (found.length >= limit) break;
    const at = e.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    found.push(defangUntrustedClosers(`[${e.tag}] ${snippet(e.text, at, needle.length)}`));
  }
  const header = defangUntrustedClosers(
    found.length === 0
      ? `No matches for "${query}" in this session's history or archive.`
      : `${found.length} match${found.length === 1 ? "" : "es"} for "${query}" (newest first):`,
  );
  // The fence's size does not depend on its content (fixed-length random id).
  const room = RECALL_OUTPUT_BYTES - bytes(fenceUntrusted(LABEL, ""));
  const omitted = (n: number): string => `[… ${n} more match(es) omitted: output cap]`;
  const lines = [header];
  let used = bytes(header);
  for (let k = 0; k < found.length; k++) {
    const line = found[k] as string;
    const tail = k + 1 < found.length ? bytes(`\n${omitted(found.length - k - 1)}`) : 0;
    if (used + bytes(`\n${line}`) + tail > room) {
      lines.push(omitted(found.length - k));
      break;
    }
    lines.push(line);
    used += bytes(`\n${line}`);
  }
  // Every piece is already cleaned; clean the whole once more before it reaches the model.
  return {
    content: fenceUntrusted(LABEL, redact(sanitizeTerminal(lines.join("\n")))),
    isError: false,
  };
}

/** The `recall` tool over `source()` (read at each call, so it sees the latest history). */
export function recallTool(source: () => RecallSource): AgentTool {
  return {
    spec: {
      name: "recall",
      description:
        "Search this conversation's full history (including turns compacted out of your context) and the session record's archive. Plain case-insensitive text match, not a pattern. Returns up to 10 matches as [id role] snippet.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "the text to look for" },
          limit: { type: "number", description: "at most this many matches (1 to 10)" },
        },
        required: ["query"],
      },
    },
    async execute(args) {
      return recall(source(), args);
    },
  };
}
