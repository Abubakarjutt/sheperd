import type { ChatEvent } from "@rewire/session";
import { Box, useInput } from "ink";
import { cleanForMarkdown, lex, Markdown } from "./markdown.js";
import { COMPACTING_VERB, Spinner } from "./spinner.js";
import { kTokens } from "./status-line.js";
import { EntryLine, ToolLine, type TranscriptEntry } from "./transcript.js";
import { useColumns } from "./use-columns.js";

/** One piece of an in-flight turn, in arrival order. */
export type LiveItem =
  /** Streamed assistant text, RAW (as the deltas arrived): render only via cleanForMarkdown. */
  | {
      kind: "text";
      raw: string;
      /** Set when its model call ended (a `usage` event): the next delta starts a new item. */
      closed?: boolean;
      /** Earlier blocks of this text were already moved to the transcript (a gap goes above). */
      cont?: boolean;
    }
  | {
      kind: "tool";
      callId: string;
      summary: string;
      isError: boolean;
      preview?: string[];
      more?: number;
    }
  | { kind: "skill"; name: string }
  /** A dim line of the session's own (`context_cleared`). */
  | { kind: "line"; text: string };

/**
 * The part of an in-flight turn that is not finished yet. Finished items (a tool with its
 * result, closed text, complete top-level Markdown blocks) are taken out by {@link takeFinished}
 * and printed once through `<Static>`, so the live area stays short (I1).
 */
export type LiveState = {
  items: readonly LiveItem[];
  /** Sum of `outputTokens` over this turn's usage events (finished model calls). */
  tokens: number;
  /** Characters streamed by the model call in flight (not yet counted by a usage event). */
  pendingChars: number;
  /** Visible streamed text has already been moved to the transcript this turn. */
  shownText: boolean;
  verb: string;
  startedAt: number;
  /** Set while a compaction runs (its start time): the spinner says `Compacting context…`. */
  compacting?: number;
  /** The spinner's Esc hint (default `esc to interrupt`). */
  hint?: string;
};

/** Minimum interval between re-renders of the live area (global performance rule). */
export const LIVE_THROTTLE_MS = 50;

/** The dim line that follows a turn the user interrupted (Esc or Ctrl-C). */
export const INTERRUPTED = "  ⎿ Interrupted by user";

export const newLive = (verb: string, startedAt: number): LiveState => ({
  items: [],
  tokens: 0,
  pendingChars: 0,
  shownText: false,
  verb,
  startedAt,
});

/** Folds one chat event into the live state; returns a new state (the old one is untouched). */
export function applyEvent(s: LiveState, e: ChatEvent): LiveState {
  switch (e.type) {
    case "assistant_delta": {
      if (e.text === "") return s;
      const pendingChars = s.pendingChars + e.text.length;
      const last = s.items[s.items.length - 1];
      if (last?.kind === "text" && !last.closed) {
        const items = [...s.items.slice(0, -1), { ...last, raw: last.raw + e.text }];
        return { ...s, pendingChars, items };
      }
      return { ...s, pendingChars, items: [...s.items, { kind: "text", raw: e.text }] };
    }
    case "tool_call":
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "tool",
            callId: e.callId,
            summary: e.summary,
            isError: e.isError,
          },
        ],
      };
    case "tool_result": {
      // Tools run one after another, so the result belongs to the latest call with its id.
      let i = s.items.length - 1;
      while (i >= 0) {
        const it = s.items[i];
        if (it?.kind === "tool" && it.callId === e.callId) break;
        i--;
      }
      const it = s.items[i];
      if (it?.kind !== "tool") return s;
      const items = [...s.items];
      items[i] = { ...it, preview: e.preview, more: e.more, isError: it.isError || e.isError };
      return { ...s, items };
    }
    case "skill_loaded":
      return { ...s, items: [...s.items, { kind: "skill", name: e.name }] };
    case "context_cleared":
      return { ...s, items: [...s.items, { kind: "line", text: clearedLine(e) }] };
    case "compaction":
      if (e.phase === "start") return { ...s, compacting: Date.now() };
      if (s.compacting === undefined) return s;
      return withoutCompacting(s);
    case "usage": {
      // One usage event per model call: its text is complete, so a later call's text (even with
      // no tool in between) starts a new paragraph, and the estimate gives way to the count.
      const n = Number.isFinite(e.outputTokens) && e.outputTokens > 0 ? e.outputTokens : 0;
      const last = s.items[s.items.length - 1];
      const items =
        last?.kind === "text" && !last.closed
          ? [...s.items.slice(0, -1), { ...last, closed: true }]
          : s.items;
      return { ...s, items, tokens: s.tokens + n, pendingChars: 0 };
    }
    default:
      // assistant_text: the streamed deltas (or the turn's final text) already carry it.
      return s;
  }
}

/** `⎿ cleared 3 earlier tool outputs to fit the context (75k limit)`. */
export function clearedLine(e: Extract<ChatEvent, { type: "context_cleared" }>): string {
  const n = `${e.cleared} earlier tool output${e.cleared === 1 ? "" : "s"}`;
  const why =
    e.reason === "limit"
      ? `to fit the context (${kTokens(e.limit)} limit)`
      : `to fit this model's prompt-reading time (${kTokens(e.limit)} tokens)`;
  return `⎿ cleared ${n} ${why}`;
}

function withoutCompacting(s: LiveState): LiveState {
  const { compacting: _c, ...rest } = s;
  return rest;
}

/** Output tokens to show: the reported count plus ~chars/4 for the call still streaming. */
export function liveTokens(s: LiveState): { tokens: number; estimated: boolean } {
  const guess = Math.ceil(s.pendingChars / 4);
  return { tokens: s.tokens + guess, estimated: guess > 0 };
}

/** Appended to a candidate prefix to check that it ends no escape sequence still open. */
const PROBE = "x";
/** How many blank-line boundaries (from the end) are tried before giving up for this render. */
const MAX_CANDIDATES = 8;

/**
 * Splits the complete top-level Markdown blocks off a growing text, keeping the last block (the
 * one still streaming) live. Returns the finished part already CLEANED, and the raw rest, or
 * undefined when nothing is safely complete. A split is made only at a blank line that:
 * - leaves non-blank text after it (a block can still grow until the next one starts);
 * - is a top-level block boundary of the whole cleaned text (not inside a fence or a list);
 * - cleans the same whole and in parts: the whole buffer is cleaned once more and must start
 *   with the cleaned prefix (a secret or escape sequence across the boundary is not split), and
 *   the prefix leaves nothing open (appending text cleans to the same prefix). The probe check is
 *   what refuses a split inside an unfinished PEM block, whose redaction runs to the end of the
 *   text, as well as after an unterminated escape sequence.
 */
export function splitBlocks(raw: string): { done: string; rest: string } | undefined {
  const runs = [...raw.matchAll(/\n(?:[ \t]*\n)+/g)];
  if (runs.length === 0) return undefined;
  const whole = cleanForMarkdown(raw);
  const ends = new Set<number>();
  let at = 0;
  for (const t of lex(whole)) {
    at += t.raw.length;
    ends.add(at);
  }
  if (at !== whole.length) return undefined; // the tokens do not tile the text: do not guess
  for (const m of runs.reverse().slice(0, MAX_CANDIDATES)) {
    const k = (m.index ?? 0) + m[0].length;
    const rest = raw.slice(k);
    if (rest.trim() === "") continue;
    const prefix = raw.slice(0, k);
    const done = cleanForMarkdown(prefix);
    if (!ends.has(done.length) || !whole.startsWith(done)) continue;
    if (cleanForMarkdown(prefix + PROBE) !== done + PROBE) continue;
    if (done.trim() === "") return undefined;
    return { done, rest };
  }
  return undefined;
}

function entryOf(
  it: LiveItem,
  text = it.kind === "text" ? cleanForMarkdown(it.raw) : "",
): TranscriptEntry[] {
  if (it.kind === "text") {
    if (text.trim() === "") return [];
    return [{ kind: "assistant", text, ...(it.cont ? { cont: true } : {}) }];
  }
  if (it.kind === "tool") {
    return [
      {
        kind: "tool",
        summary: it.summary,
        isError: it.isError,
        ...(it.preview ? { preview: it.preview } : {}),
        ...(it.more !== undefined ? { more: it.more } : {}),
      },
    ];
  }
  if (it.kind === "line") return [{ kind: "line", tone: "dim", text: it.text }];
  return [{ kind: "skill", name: it.name }];
}

const finished = (it: LiveItem): boolean =>
  it.kind === "skill" ||
  it.kind === "line" ||
  (it.kind === "tool" && it.preview !== undefined) ||
  (it.kind === "text" && it.closed === true);

/**
 * Takes the finished part of the live state out, as transcript entries in arrival order: every
 * item before the last; the last when it is finished (a tool with its result, a skill, closed
 * text); else, for open text, its complete top-level blocks ({@link splitBlocks}). With `all`,
 * everything (the turn ended). Assistant text is stored cleaned, never raw.
 */
export function takeFinished(
  s: LiveState,
  all = false,
): { state: LiveState; entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = [];
  const items = s.items;
  const last = items[items.length - 1];
  for (const it of items.slice(0, -1)) entries.push(...entryOf(it));
  let keep: LiveItem[] = [];
  if (last) {
    if (all || finished(last)) entries.push(...entryOf(last));
    else if (last.kind === "text") {
      const split = splitBlocks(last.raw);
      if (split) {
        entries.push(...entryOf(last, split.done));
        keep = [{ ...last, raw: split.rest, cont: true }];
      } else keep = [last];
    } else keep = [last];
  }
  const shownText = s.shownText || entries.some((e) => e.kind === "assistant");
  if (entries.length === 0 && keep.length === items.length) return { state: s, entries };
  return { state: { ...s, items: keep, shownText }, entries };
}

/** All of a live state as transcript entries (the turn ended). */
export const liveEntries = (s: LiveState | undefined): TranscriptEntry[] =>
  s ? takeFinished(s, true).entries : [];

/** Rows the live area keeps free for the spinner, the status line and a spare line. */
export const LIVE_RESERVED_ROWS = 3;

function LiveItemView({ item, cols }: { item: LiveItem; cols: number }) {
  if (item.kind === "text") {
    const md = <Markdown text={cleanForMarkdown(item.raw)} width={cols} />;
    return item.cont ? <Box marginTop={1}>{md}</Box> : md;
  }
  if (item.kind === "tool") {
    return (
      <ToolLine
        summary={item.summary}
        isError={item.isError}
        {...(item.preview ? { preview: item.preview } : {})}
        {...(item.more !== undefined ? { more: item.more } : {})}
      />
    );
  }
  if (item.kind === "line")
    return <EntryLine entry={{ kind: "line", tone: "dim", text: item.text }} />;
  return <EntryLine entry={{ kind: "skill", name: item.name }} />;
}

export type LiveTurnProps = {
  state: LiveState;
  /** Called on Esc while `interruptible`. */
  onInterrupt: () => void;
  /** False while another Esc consumer (a panel, a menu) or a gated run owns the keys. */
  interruptible: boolean;
  /**
   * Most rows the items may take (the terminal rows minus what is under them). Taller content
   * shows its tail: a frame taller than the terminal would be re-printed into scrollback.
   */
  maxRows: number;
};

/**
 * The dynamic area of an in-flight chat turn: the unfinished items (usually the tool running or
 * the Markdown block still streaming), then the spinner. The streamed text is cleaned whole on
 * every render (a secret or escape sequence split across deltas is still caught), never per delta.
 */
export function LiveTurn({ state, onInterrupt, interruptible, maxRows }: LiveTurnProps) {
  const cols = useColumns();
  useInput(
    (_input, key) => {
      if (key.escape) onInterrupt();
    },
    { isActive: interruptible },
  );
  const rows = Math.max(1, Math.floor(Number.isFinite(maxRows) ? maxRows : 1));
  return (
    <Box flexDirection="column">
      {state.items.length > 0 ? (
        <Box
          flexDirection="column"
          maxHeight={rows}
          overflow="hidden"
          justifyContent="flex-end"
          flexShrink={0}
        >
          {state.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only within one turn
            <Box key={i} flexDirection="column" flexShrink={0}>
              <LiveItemView item={it} cols={cols} />
            </Box>
          ))}
        </Box>
      ) : null}
      {state.compacting !== undefined ? (
        <Spinner
          verb={COMPACTING_VERB}
          startedAt={state.compacting}
          tokens={0}
          {...(state.hint !== undefined ? { hint: state.hint } : {})}
        />
      ) : (
        <Spinner
          verb={state.verb}
          startedAt={state.startedAt}
          {...liveTokens(state)}
          {...(state.hint !== undefined ? { hint: state.hint } : {})}
        />
      )}
    </Box>
  );
}
