import { Text } from "ink";
import { useEffect, useState } from "react";
import { fit } from "./fit.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** The spinner's glyph cycle. */
export const SPINNER_GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
/** One verb is picked per chat turn. */
export const SPINNER_VERBS = [
  "Thinking",
  "Pondering",
  "Working",
  "Reading",
  "Reasoning",
  "Composing",
] as const;
/** Glyph frame interval (the global performance rule: 100 ms or slower). */
export const SPINNER_TICK_MS = 120;

/** A random verb from {@link SPINNER_VERBS}. */
export const pickVerb = (): string =>
  SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] ?? "Thinking";

/** `999`, then `1.0k`, `1.2k`, `45.7k`. */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return v > 999 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export type SpinnerProps = {
  verb: string;
  /** `Date.now()` when the turn started. */
  startedAt: number;
  /** Output tokens so far this turn; the count is omitted while 0. */
  tokens: number;
  /** True while part of `tokens` is estimated from streamed text: shown as `~N`. */
  estimated?: boolean;
};

/**
 * `✻ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)`, cut to the terminal width. Its only
 * timer is the glyph interval, cleared on unmount; elapsed time is re-read on each tick.
 */
export function Spinner({ verb, startedAt, tokens, estimated = false }: SpinnerProps) {
  const cols = useColumns();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_GLYPHS.length), SPINNER_TICK_MS);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const count = tokens > 0 ? ` · ↓ ${estimated ? "~" : ""}${formatTokens(tokens)} tokens` : "";
  const glyph = SPINNER_GLYPHS[frame] ?? SPINNER_GLYPHS[0];
  const line = fit(`${glyph} ${verb}… (${secs}s${count} · esc to interrupt)`, cols);
  // The glyph is one code unit; `fit` keeps the line's start, so the split is exact.
  return (
    <Text wrap="truncate">
      <Text color={theme.busy}>{line.slice(0, 1)}</Text>
      {line.slice(1)}
    </Text>
  );
}
