import { redact, sanitizeTerminal } from "@rewire/core";
import type { AgentTool } from "@rewire/loop";
import type { ChatMessage } from "@rewire/providers";

/** The most recent tool results of a turn that the context budget never clears. */
export const IN_TURN_KEEP = 2;
/** The prefill guard's floor: the most recent tool result always stays. */
export const PREFILL_KEEP = 1;
/** Once clearing starts, it goes down to this share of its trigger (the low-water mark). */
export const LOW_WATER_SHARE = 0.6;
/** A call whose prompt would take more than this share of the reply timeout to read is trimmed. */
export const PREFILL_GUARD_SHARE = 0.8;
/** Code points of the tool label in a stub. */
const LABEL_CAP = 120;

/**
 * What a cleared tool result becomes in the model-visible context: fixed text from the call's
 * safe label and the result's length, so the same result always clears to the same bytes.
 */
export function clearedStub(label: string, chars: number): string {
  return `[tool output cleared to fit the context: ${label} — ${chars} chars. Run it again (with offset/limit for read) if you still need it, or use recall after this turn.]`;
}

const str = (args: Record<string, unknown>, k: string): string | undefined =>
  typeof args[k] === "string" ? (args[k] as string) : undefined;
const int = (args: Record<string, unknown>, k: string): string =>
  typeof args[k] === "number" && Number.isFinite(args[k]) ? ` ${k}=${args[k]}` : "";
const quoted = (s: string | undefined): string => (s === undefined ? "" : `"${s}"`);

/** Chosen fields of the chat's own tools (never the whole argument object). */
const FIELDS: Readonly<Record<string, (a: Record<string, unknown>) => string>> = {
  read: (a) => `${str(a, "path") ?? ""}${int(a, "offset")}${int(a, "limit")}`,
  grep: (a) => {
    const where = str(a, "path") ?? str(a, "glob");
    return `${quoted(str(a, "pattern"))}${where !== undefined ? ` in ${where}` : ""}`;
  },
  find: (a) => str(a, "glob") ?? str(a, "pattern") ?? "",
  bash: (a) => str(a, "command") ?? "",
  recall: (a) => quoted(str(a, "query")),
  skill: (a) => str(a, "name") ?? "",
};

/**
 * The label of a call in its stub: the tool's own `summary` hook when it has one (web: the
 * cleaned query or host and path), else chosen fields of the chat tools, else the name alone.
 * Never the raw argument object. Sanitized, redacted, whitespace folded, then capped.
 */
export function clearedLabel(
  name: string,
  args: Record<string, unknown>,
  tool: AgentTool | undefined,
): string {
  let shown: string;
  if (tool?.summary) {
    try {
      shown = tool.summary(args);
    } catch {
      shown = "[summary unavailable]";
    }
  } else shown = FIELDS[name]?.(args) ?? "";
  const line = redact(sanitizeTerminal(`${name} ${shown}`))
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(line).slice(0, LABEL_CAP).join("");
}

export type ClearOptions = {
  /** Messages from this index on are the current turn's (its user message and after). */
  from: number;
  /**
   * This turn's cleared results, by message index (indices are stable within a turn: the loop
   * only appends) → stub. Grows; never shrinks within a turn. Keyed by position, not call id,
   * so empty or repeated ids cannot make two results share a stub.
   */
  cleared: Map<number, string>;
  /** Estimated input tokens of a request with these messages. */
  estimate: (messages: ChatMessage[]) => number;
  /** The stub label of a tool call (`clearedLabel`). */
  label: (call: { name: string; arguments: Record<string, unknown> }) => string;
  /** Clearing starts only when the estimate is over this. */
  max: number;
  /**
   * Once started, clearing goes on down to this (a low-water mark under `max`), so the turn can
   * add several results before the next clearing changes the prompt prefix again.
   */
  target: number;
  /** The most recent results of the turn that are never cleared. */
  keep: number;
  /**
   * Also clear a result whose call repeats one already cleared this turn (the model ran it
   * again because it needed it). Off for the limit, so a cleared read the model repeats is not
   * cleared again and the two cannot loop; on for the prefill guard's last resort.
   */
  clearReruns: boolean;
};

/**
 * The messages a model call sends: every result already in `cleared` replaced by its stub, then,
 * when the estimate is over `max`, the oldest remaining results of the current turn (all but
 * the newest `keep`) cleared one at a time until it is at or under `target`. A result no longer
 * than its stub is left as it is. `messages` is not modified, and the ids of every call and
 * result stay as they were.
 */
export function clearToFit(
  messages: readonly ChatMessage[],
  o: ClearOptions,
): { messages: ChatMessage[]; estimate: number; newly: number } {
  const out = messages.map((m, i) => {
    const stub = m.role === "tool" ? o.cleared.get(i) : undefined;
    return stub === undefined ? m : { ...m, content: stub };
  });
  let estimate = o.estimate(out);
  let newly = 0;
  if (estimate <= o.max) return { messages: out, estimate, newly };
  // The call each result answers: the matching id in the assistant message before it (the
  // nearest one, so a repeated id still finds its own call).
  const callOf = (i: number): { name: string; arguments: Record<string, unknown> } => {
    const id = messages[i]?.toolCallId;
    for (let j = i - 1; j >= 0; j--) {
      const c = messages[j]?.toolCalls?.find((t) => t.id === id);
      if (c) return c;
    }
    return { name: "tool", arguments: {} };
  };
  const results: number[] = [];
  for (let i = Math.max(0, o.from); i < messages.length; i++) {
    if (messages[i]?.role === "tool") results.push(i);
  }
  const clearedLabels = new Set([...o.cleared.keys()].map((i) => o.label(callOf(i))));
  for (const i of results.slice(0, Math.max(0, results.length - o.keep))) {
    if (estimate <= o.target) break;
    if (o.cleared.has(i)) continue;
    const m = messages[i] as ChatMessage;
    const label = o.label(callOf(i));
    if (!o.clearReruns && clearedLabels.has(label)) continue;
    const stub = clearedStub(label, m.content.length);
    if (stub.length >= m.content.length) continue;
    o.cleared.set(i, stub);
    clearedLabels.add(label);
    out[i] = { ...m, content: stub };
    newly++;
    estimate = o.estimate(out);
  }
  return { messages: out, estimate, newly };
}
