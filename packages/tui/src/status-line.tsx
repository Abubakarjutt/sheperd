import { Text } from "ink";
import { fit, width } from "./fit.js";
import { Safe } from "./safe.js";
import { formatTokens } from "./spinner.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export const SHORTCUTS_HINT = "? for shortcuts";

export type StatusParts = {
  /** The chat model; omitted when unknown. */
  model?: string | undefined;
  /** Session token total (input and output). */
  tokens: number;
  /** `contract,tests`, or `off`. */
  checkpoints: string;
  /** `chat`, `thinking`, `run: <stage>` or `checkpoint: <kind>`. */
  mode: string;
};

/**
 * The status line's text at `cols`: `<model> · <N> tokens · checkpoints: <set> · <mode>`, with
 * `? for shortcuts` right-aligned. When it does not fit, pieces are dropped in this order: the
 * shortcuts hint, the checkpoints, the tokens; what is left is cut with `fit` (which sanitizes).
 */
export function statusText(p: StatusParts, cols: number): string {
  const max = Math.floor(cols);
  if (!(max >= 1)) return "";
  const model = p.model ? fit(p.model, max) : undefined;
  const left = (tokens: boolean, checkpoints: boolean): string =>
    [
      model,
      tokens ? `${formatTokens(p.tokens)} tokens` : undefined,
      checkpoints ? `checkpoints: ${p.checkpoints}` : undefined,
      fit(p.mode, max),
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
  const mode = fit(p.mode, max);
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
