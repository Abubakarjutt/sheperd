import type { ChatEvent } from "@rewire/session";
import { Box, useInput } from "ink";
import { cleanForMarkdown, Markdown } from "./markdown.js";
import { Spinner } from "./spinner.js";
import { EntryLine, ToolLine, type TranscriptEntry } from "./transcript.js";
import { useColumns } from "./use-columns.js";

/** One piece of an in-flight turn, in arrival order. */
export type LiveItem =
  /** Streamed assistant text, RAW (as the deltas arrived): render only via cleanForMarkdown. */
  | { kind: "text"; raw: string }
  | {
      kind: "tool";
      callId: string;
      summary: string;
      isError: boolean;
      preview?: string[];
      more?: number;
    }
  | { kind: "skill"; name: string };

export type LiveState = {
  items: readonly LiveItem[];
  /** Sum of `outputTokens` over this turn's usage events. */
  tokens: number;
  verb: string;
  startedAt: number;
};

/** Minimum interval between re-renders of the live area (global performance rule). */
export const LIVE_THROTTLE_MS = 50;

/** The dim line that follows a turn the user interrupted (Esc or Ctrl-C). */
export const INTERRUPTED = "  ⎿ Interrupted by user";

export const newLive = (verb: string, startedAt: number): LiveState => ({
  items: [],
  tokens: 0,
  verb,
  startedAt,
});

/** Folds one chat event into the live state; returns a new state (the old one is untouched). */
export function applyEvent(s: LiveState, e: ChatEvent): LiveState {
  switch (e.type) {
    case "assistant_delta": {
      if (e.text === "") return s;
      const last = s.items[s.items.length - 1];
      if (last?.kind === "text") {
        return { ...s, items: [...s.items.slice(0, -1), { kind: "text", raw: last.raw + e.text }] };
      }
      return { ...s, items: [...s.items, { kind: "text", raw: e.text }] };
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
    case "usage": {
      const n = Number.isFinite(e.outputTokens) && e.outputTokens > 0 ? e.outputTokens : 0;
      return { ...s, tokens: s.tokens + n };
    }
    default:
      // assistant_text: the streamed deltas (or the turn's final text) already carry it.
      return s;
  }
}

/** The finished transcript entries for a live turn, in arrival order (blank text dropped). */
export function liveEntries(s: LiveState | undefined): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const it of s?.items ?? []) {
    if (it.kind === "text") {
      if (it.raw.trim() !== "") out.push({ kind: "assistant", text: it.raw });
    } else if (it.kind === "tool") {
      out.push({
        kind: "tool",
        summary: it.summary,
        isError: it.isError,
        ...(it.preview ? { preview: it.preview } : {}),
        ...(it.more !== undefined ? { more: it.more } : {}),
      });
    } else out.push({ kind: "skill", name: it.name });
  }
  return out;
}

/** True when the turn streamed any visible text. */
export const streamedText = (s: LiveState | undefined): boolean =>
  (s?.items ?? []).some((it) => it.kind === "text" && it.raw.trim() !== "");

function LiveItemView({ item, cols }: { item: LiveItem; cols: number }) {
  if (item.kind === "text") return <Markdown text={cleanForMarkdown(item.raw)} width={cols} />;
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
  return <EntryLine entry={{ kind: "skill", name: item.name }} />;
}

export type LiveTurnProps = {
  state: LiveState;
  /** Called on Esc while `interruptible`. */
  onInterrupt: () => void;
  /** False while another Esc consumer (a panel, a menu) or a gated run owns the keys. */
  interruptible: boolean;
};

/**
 * The dynamic area of an in-flight chat turn: tool lines and streamed text in arrival order, then
 * the spinner. The streamed text is cleaned whole on every render (a secret or escape sequence
 * split across deltas is still caught), never per delta.
 */
export function LiveTurn({ state, onInterrupt, interruptible }: LiveTurnProps) {
  const cols = useColumns();
  useInput(
    (_input, key) => {
      if (key.escape) onInterrupt();
    },
    { isActive: interruptible },
  );
  return (
    <Box flexDirection="column">
      {state.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only within one turn
        <LiveItemView key={i} item={it} cols={cols} />
      ))}
      <Spinner verb={state.verb} startedAt={state.startedAt} tokens={state.tokens} />
    </Box>
  );
}
