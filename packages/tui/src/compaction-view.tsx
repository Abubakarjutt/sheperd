import {
  type ChatEvent,
  COMPACTION_FLOOR,
  type CompactionDone,
  type CompactionView,
  type ContextStatus,
  type SessionRecord,
} from "@rewire/session";
import { Box, type DOMElement, measureElement, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useScroll } from "./diff-view.js";
import { fit } from "./fit.js";
import { cleanForMarkdown, Markdown } from "./markdown.js";
import { Safe } from "./safe.js";
import { kTokens, REASON_INITIAL } from "./status-line.js";
import { Card, cardInner } from "./styled.js";
import { theme } from "./theme.js";
import type { TranscriptEntry } from "./transcript.js";
import { useColumns, useRows } from "./use-columns.js";

/** Shown once per session when the compaction verifier is not of another model family. */
export const INDEPENDENCE_NOTICE =
  "⎿ note: compaction checks use the same model family as chat (no independent verifier configured)";

/** Shown after `/compact` was cancelled with Esc (or Ctrl-C). */
export const COMPACT_CANCELLED = "  ⎿ Compaction cancelled by user";

/** The suffix the session puts on a `stuck` reason; the TUI line says it its own way. */
const STUCK_SUFFIX = /\s*\(\/compact still works\)\s*$/;

/** The last compaction result of this session (for `/context`). */
export type LastCompaction =
  | ({ ok: true } & CompactionDone)
  | { ok: false; code: string; reason: string };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The transcript lines of a compaction event: `done` (plus a dim line when operations were
 * rejected), `failed` in dim yellow, `stuck` in yellow. `start` has none (the spinner shows it),
 * and neither has a `failed: aborted` (the cancellation is reported by whoever aborted it).
 */
export function compactionEntries(e: ChatEvent): TranscriptEntry[] {
  if (e.type !== "compaction") return [];
  if (e.phase === "done") {
    const c = e.counts;
    const out: TranscriptEntry[] = [
      {
        kind: "line",
        tone: "dim",
        text: `⎿ compacted ${plural(e.messages, "message")} → record (${plural(c.decisions, "decision")} · ${plural(c.constraints, "constraint")} · ${c.open} open) · ctx ${kTokens(e.before)} → ${kTokens(e.after)}`,
      },
    ];
    if (e.rejected > 0) {
      const first = e.reasons[0];
      const more = e.rejected > 1 ? "…" : "";
      const head = `⎿ ${plural(e.rejected, "proposed change")} rejected`;
      out.push({
        kind: "line",
        tone: "dim",
        text: first === undefined ? head : `${head}: ${first}${more}`,
      });
    }
    return out;
  }
  if (e.phase === "failed") {
    if (e.reason === "aborted") return [];
    return [
      {
        kind: "line",
        tone: "dimWarn",
        text: `⎿ compaction skipped: ${e.code} — kept full context (/context for details)`,
      },
    ];
  }
  if (e.phase === "stuck") {
    return [
      {
        kind: "line",
        tone: "warn",
        text: `⎿ automatic compaction paused: ${e.reason.replace(STUCK_SUFFIX, "")} — /compact to retry`,
      },
    ];
  }
  return [];
}

/** The result a compaction event leaves for `/context`, if it ends one. */
export function lastCompactionOf(e: ChatEvent): LastCompaction | undefined {
  if (e.type !== "compaction") return undefined;
  if (e.phase === "done") {
    const { type: _t, phase: _p, ...done } = e;
    return { ok: true, ...done };
  }
  if (e.phase === "failed" && e.reason !== "aborted") {
    return { ok: false, code: e.code, reason: e.reason };
  }
  return undefined;
}

/** What `/context` shows. */
export type ContextInfo = {
  status: ContextStatus;
  view: CompactionView;
  last?: LastCompaction | undefined;
};

const num = (n: number): string =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : String(n);

/** Active record items by kind, plus the pending citations and the archive. */
export function recordCounts(r: SessionRecord): string {
  const active = r.items.filter((i) => i.status === "active");
  const n = (...kinds: string[]): number => active.filter((i) => kinds.includes(i.kind)).length;
  return [
    plural(n("decision"), "decision"),
    plural(n("constraint", "preserve"), "constraint"),
    `${n("open_question")} open`,
    plural(n("preference"), "preference"),
    plural(n("note"), "note"),
    `${r.pending.length} pending`,
    `${r.archive.length} archived`,
    plural(r.compactions, "compaction"),
  ].join(" · ");
}

type Line = { text: string; tone?: "dim" | "warn" | "bold" };

/** The `/context` card's text lines before the record (limit, window, warnings, counts). */
export function contextLines(info: ContextInfo): Line[] {
  const { status, view, last } = info;
  const { limit, window: w, estimate } = status;
  const lines: Line[] = [];
  const pct = limit.limit > 0 ? Math.round((estimate / limit.limit) * 100) : 0;
  const hold = status.hold ? ` · automatic compaction ${status.hold}` : "";
  lines.push({
    text: `context ${num(estimate)} / ${num(limit.limit)} tokens (${pct}% of the limit)${hold}`,
    tone: "bold",
  });
  lines.push({
    text: `limit ${num(limit.limit)} (${limit.reason}, ${REASON_INITIAL[limit.reason] ?? "?"})`,
  });
  const chosen = limit.candidates.find((c) => c.reason === limit.reason) ?? limit.candidates[0];
  for (const c of limit.candidates) {
    const mark = c === chosen ? "  ← used" : "";
    lines.push({
      text: `  ${c.reason.padEnd(10)} ${num(c.value).padStart(9)}${mark}`,
      tone: "dim",
    });
  }
  lines.push({
    text: `window ${num(w.window)} (${w.source})${w.provisional ? " · provisional" : ""}`,
  });
  if (limit.reason === "override" && chosen !== undefined && chosen.value > w.window) {
    lines.push({
      text: `⚠ the configured limit (${num(chosen.value)}) is larger than the context window (${num(w.window)}): requests can overflow before compaction runs`,
      tone: "warn",
    });
  }
  if (chosen !== undefined && chosen.value < COMPACTION_FLOOR && limit.limit >= COMPACTION_FLOOR) {
    lines.push({
      text: `note: the limit was raised to the ${num(COMPACTION_FLOOR)}-token floor (computed ${num(chosen.value)})`,
      tone: "dim",
    });
  }
  if (view.independence === "same-family") {
    lines.push({ text: "verifier: same model family as chat (not independent)", tone: "dim" });
  }
  lines.push({ text: `record: ${recordCounts(view.record)}` });
  if (last === undefined)
    lines.push({ text: "last compaction: none in this session", tone: "dim" });
  else if (last.ok) {
    const rejected = last.rejected > 0 ? ` · ${last.rejected} rejected` : "";
    const over = last.overBudget ? " · over budget" : "";
    lines.push({
      text: `last compaction: ${plural(last.messages, "message")} → ctx ${kTokens(last.before)} → ${kTokens(last.after)}${rejected}${over}`,
    });
    for (const r of last.reasons) lines.push({ text: `  rejected: ${r}`, tone: "dim" });
  } else {
    lines.push({ text: `last compaction: skipped (${last.code}): ${last.reason}`, tone: "warn" });
  }
  return lines;
}

const toneColor = (t: Line["tone"]): string | undefined =>
  t === "dim" ? theme.dim : t === "warn" ? theme.busy : undefined;

/** The card's content: the lines, then the record as Markdown (cleaned for the terminal). */
export function ContextBody({ info, width }: { info: ContextInfo; width: number }): ReactNode {
  const rendered = cleanForMarkdown(info.view.rendered);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {contextLines(info).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed lines of one card
        <Safe key={i} color={toneColor(l.tone)} bold={l.tone === "bold"}>
          {l.text}
        </Safe>
      ))}
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Text bold>Session record</Text>
        {rendered.trim() === "" ? (
          <Text color={theme.dim}>(empty: nothing compacted yet)</Text>
        ) : (
          <Markdown text={rendered} width={width} />
        )}
      </Box>
    </Box>
  );
}

/** Rows around the panel's scroll area: the card border, its title, its footer and the input. */
const PANEL_OUTSIDE_ROWS = 13;

/**
 * `/context` as a card above the input. Content taller than the screen scrolls (the shared
 * {@link useScroll} keys: ↑↓, PgUp/PgDn, g/G); Esc closes it. It is display-only.
 */
export function ContextPanel({
  info,
  onClose,
  isActive,
}: {
  info: ContextInfo;
  onClose: () => void;
  isActive: boolean;
}): ReactNode {
  const cols = useColumns();
  const rows = useRows();
  const inner = cardInner(cols);
  const page = Math.max(3, rows - PANEL_OUTSIDE_ROWS);
  const ref = useRef<DOMElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const h = measureElement(ref.current).height;
    if (h !== height) setHeight(h);
  });
  const top = useScroll(height, page, { isActive: () => isActive, onClose });
  const scrolls = height > page;
  const end = Math.min(height, top + page);
  const footer = scrolls
    ? `lines ${top + 1}–${end} of ${height} · ↑↓ scroll · esc close`
    : "esc close";
  return (
    <Card color={theme.accent} cols={cols}>
      <Text bold color={theme.accent}>
        {fit("Context", inner)}
      </Text>
      <Box {...(scrolls ? { height: page } : {})} overflow="hidden" flexDirection="column">
        <Box ref={ref} flexDirection="column" marginTop={-top} flexShrink={0}>
          <ContextBody info={info} width={inner} />
        </Box>
      </Box>
      <Text color={theme.dim} wrap="truncate">
        {fit(footer, inner)}
      </Text>
    </Card>
  );
}
