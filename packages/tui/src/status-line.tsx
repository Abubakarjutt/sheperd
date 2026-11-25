import { Text } from "ink";
import { fit, fitClean, width } from "./fit.js";
import { Safe } from "./safe.js";
import { formatTokens } from "./spinner.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export const SHORTCUTS_HINT = "? for shortcuts";

export type StatusParts = {
  /** The chat model; omitted when unknown. */
  model?: string | undefined;
  /**
   * Context size: the last model call's input plus output tokens (as Claude Code and Codex
   * show it). Omitted until the session's first call.
   */
  context?: number | undefined;
  /** `contract,tests`, or `off`. */
  checkpoints: string;
  /** `chat`, `thinking`, `run: <stage>` or `checkpoint: <kind>`. */
  mode: string;
};

/**
 * The status line's text at `cols`: `<model> · ctx <N> · checkpoints: <set> · <mode>`, with
 * `? for shortcuts` right-aligned. When it does not fit, pieces are dropped in this order: the
 * shortcuts hint, the checkpoints, the context size; what is left is cut with `fit` (which
 * sanitizes). Values go through fitClean: sanitized, then redacted, then cut.
 */
export function statusText(p: StatusParts, cols: number): string {
  const max = Math.floor(cols);
  if (!(max >= 1)) return "";
  const model = p.model ? fitClean(p.model, max) : undefined;
  const mode = fitClean(p.mode, max);
  const left = (context: boolean, checkpoints: boolean): string =>
    [
      model,
      context && p.context !== undefined ? `ctx ${formatTokens(p.context)}` : undefined,
      checkpoints ? `checkpoints: ${p.checkpoints}` : undefined,
      mode,
    ]
      .filter((x): x is string => x !== undefined && x !== "")
      .join(" · ");
  const full = left(true, true);
  const gap = max - width(full) - width(SHORTCUTS_HINT);
  if (gap >= 2) return `${full}${" ".repeat(gap)}${SHORTCUTS_HINT}`;
  for (const candidate of [full, left(true, false), left(false, false)]) {
    if (width(candidate) <= max) return candidate;
  }
  // Still too wide: shorten the model so the mode stays visible.
  const room = max - width(mode) - 3;
  if (model && room >= 2) return `${fit(model, room)} · ${mode}`;
  return fit(left(false, false), max);
}

/** One dim line under the input, fitted to the terminal width. */
export function StatusLine(p: StatusParts) {
  const cols = useColumns();
  return (
    <Text wrap="truncate">
      <Safe color={theme.dim}>{statusText(p, cols)}</Safe>
    </Text>
  );
}
