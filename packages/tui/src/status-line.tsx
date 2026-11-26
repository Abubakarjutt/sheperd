import type { LimitReason } from "@rewire/session";
import { Text } from "ink";
import { fit, fitClean, width } from "./fit.js";
import { Safe } from "./safe.js";
import { formatTokens } from "./spinner.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export const SHORTCUTS_HINT = "? for shortcuts";

/** The compaction view of the context size (`ChatSession.contextStatus()`). */
export type CtxStatus = {
  /** Estimated input tokens of the next request. */
  estimate: number;
  /** The compaction limit. */
  limit: number;
  /** Which candidate set the limit (shown as its initial). */
  reason: LimitReason;
  /** Automatic compaction is held back, or off for this window. */
  hold?: "held" | "stuck" | undefined;
};

export type StatusParts = {
  /** The chat model; omitted when unknown. */
  model?: string | undefined;
  /**
   * Context size: the last model call's input plus output tokens (as Claude Code and Codex
   * show it). Omitted until the session's first call. Used only when `ctx` is absent.
   */
  context?: number | undefined;
  /** With compaction: the estimate against the limit (replaces `context`). */
  ctx?: CtxStatus | undefined;
  /** `contract,tests`, or `off`. */
  checkpoints: string;
  /** `chat`, `thinking`, `run: <stage>` or `checkpoint: <kind>`. */
  mode: string;
};

/** The limit's reason, as one letter in the status line. */
export const REASON_INITIAL: Readonly<Record<LimitReason, string>> = {
  formula: "f",
  latency: "l",
  calibrated: "c",
  window: "w",
  override: "o",
};

/** Share of the limit from which the context size turns yellow, and red. */
export const CTX_WARN = 0.7;
export const CTX_ALERT = 0.9;

/** `normal` below 70% of the limit, `warn` from 70%, `alert` from 90%. */
export function ctxLevel(estimate: number, limit: number): "normal" | "warn" | "alert" {
  if (!(Number.isFinite(estimate) && Number.isFinite(limit) && limit > 0)) return "normal";
  const r = estimate / limit;
  return r >= CTX_ALERT ? "alert" : r >= CTX_WARN ? "warn" : "normal";
}

/** `850`, then whole thousands: `9k`, `61k`, `131k`. */
export function kTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return v < 1000 ? String(v) : `${Math.round(v / 1000)}k`;
}

/** The status line's text, and where the coloured context size is in it (`[start, end)`). */
export type StatusLayout = { text: string; ctx?: { start: number; end: number; level: string } };

/**
 * The status line at `cols`: `<model> · ctx <N>/<limit> (<r>) · checkpoints: <set> · <mode>`,
 * with `? for shortcuts` right-aligned. When it does not fit, pieces are dropped in this order:
 * the shortcuts hint, the checkpoints, the reason initial, the `/limit`, the context size; what
 * is left is cut with `fit` (which sanitizes). A `· held` or `· stuck` stays with the context
 * size. Values go through fitClean: sanitized, then redacted, then cut.
 */
export function statusLayout(p: StatusParts, cols: number): StatusLayout {
  const max = Math.floor(cols);
  if (!(max >= 1)) return { text: "" };
  const model = p.model ? fitClean(p.model, max) : undefined;
  const mode = fitClean(p.mode, max);
  /** The context piece at a detail level (0 = full), split into its coloured part and the rest. */
  const ctxPiece = (detail: number): { size: string; tail: string } | undefined => {
    const c = p.ctx;
    if (c === undefined) {
      return p.context !== undefined && detail === 0
        ? { size: `ctx ${formatTokens(p.context)}`, tail: "" }
        : undefined;
    }
    if (detail > 2) return undefined;
    const reason = REASON_INITIAL[c.reason] ?? "";
    const size =
      detail === 0
        ? `ctx ${kTokens(c.estimate)}/${kTokens(c.limit)}${reason ? ` (${reason})` : ""}`
        : detail === 1
          ? `ctx ${kTokens(c.estimate)}/${kTokens(c.limit)}`
          : `ctx ${kTokens(c.estimate)}`;
    return { size, tail: c.hold ? ` · ${c.hold}` : "" };
  };
  const level = p.ctx ? ctxLevel(p.ctx.estimate, p.ctx.limit) : "normal";
  const layout = (detail: number, checkpoints: boolean): StatusLayout => {
    const piece = ctxPiece(detail);
    const head = model ? `${model} · ` : "";
    if (!piece) {
      const text = [model, checkpoints ? `checkpoints: ${p.checkpoints}` : undefined, mode]
        .filter((x): x is string => x !== undefined && x !== "")
        .join(" · ");
      return { text };
    }
    const rest = [checkpoints ? `checkpoints: ${p.checkpoints}` : undefined, mode]
      .filter((x): x is string => x !== undefined && x !== "")
      .join(" · ");
    const text = `${head}${piece.size}${piece.tail}${rest ? ` · ${rest}` : ""}`;
    return { text, ctx: { start: head.length, end: head.length + piece.size.length, level } };
  };
  const full = layout(0, true);
  const gap = max - width(full.text) - width(SHORTCUTS_HINT);
  if (gap >= 2) return { ...full, text: `${full.text}${" ".repeat(gap)}${SHORTCUTS_HINT}` };
  for (const candidate of [full, layout(0, false), layout(1, false), layout(2, false)]) {
    if (width(candidate.text) <= max) return candidate;
  }
  const bare = layout(3, false);
  if (width(bare.text) <= max) return bare;
  // Still too wide: shorten the model so the mode stays visible.
  const room = max - width(mode) - 3;
  if (model && room >= 2) return { text: `${fit(model, room)} · ${mode}` };
  return { text: fit(bare.text, max) };
}

/** {@link statusLayout}'s text. */
export function statusText(p: StatusParts, cols: number): string {
  return statusLayout(p, cols).text;
}

const LEVEL_COLOR: Readonly<Record<string, string>> = {
  normal: theme.dim,
  warn: theme.busy,
  alert: theme.error,
};

/**
 * One line under the input, fitted to the terminal width: dim, except the context size, which
 * is yellow from 70% of the compaction limit and red from 90%.
 */
export function StatusLine(p: StatusParts) {
  const cols = useColumns();
  const { text, ctx } = statusLayout(p, cols);
  if (!ctx) {
    return (
      <Text wrap="truncate">
        <Safe color={theme.dim}>{text}</Safe>
      </Text>
    );
  }
  return (
    <Text wrap="truncate">
      <Safe color={theme.dim}>{text.slice(0, ctx.start)}</Safe>
      <Safe color={LEVEL_COLOR[ctx.level] ?? theme.dim}>{text.slice(ctx.start, ctx.end)}</Safe>
      <Safe color={theme.dim}>{text.slice(ctx.end)}</Safe>
    </Text>
  );
}
