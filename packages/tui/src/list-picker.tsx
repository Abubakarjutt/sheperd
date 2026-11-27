import { Box, Text, useInput } from "ink";
import { menuWindow, POPUP_ROWS } from "./command-menu.js";
import { fit, width } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

const MARK = "❯ ";
const NO_MARK = "  ";

/** One row: a bold label, then a dim detail. A disabled row is dim and Enter ignores it. */
export type ListPickerItem = { label: string; detail?: string; disabled?: boolean };

export type ListPickerProps = {
  /** Bold line above the rows. */
  title?: string;
  items: readonly ListPickerItem[];
  /** The selected row (controlled: the owner keeps it, e.g. across steps). */
  selected: number;
  onMove: (index: number) => void;
  /** Enter on an enabled row. */
  onSelect: (index: number) => void;
  /** Esc. */
  onCancel: () => void;
  /** Dim line under the rows (key hints). */
  footer?: string;
  /** Keys are taken only while true (default true). */
  isActive?: boolean;
  /** Rows shown at once (default {@link POPUP_ROWS}); the list scrolls within them. */
  rows?: number;
};

/** `index` moved by `delta`, wrapping at both ends (as the `/` menu does). */
export function moveSelection(count: number, index: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * A scrolling list that owns the keys while active: ↑/↓ and k/j move (wrapping), Enter selects,
 * Esc cancels. Every label, detail, title and footer is untrusted text: cut with `fit` (which
 * sanitizes) and rendered through `<Safe>` (which redacts).
 */
export function ListPicker({
  title,
  items,
  selected,
  onMove,
  onSelect,
  onCancel,
  footer,
  isActive = true,
  rows = POPUP_ROWS,
}: ListPickerProps) {
  const cols = useColumns();
  const count = items.length;
  const sel = count === 0 ? 0 : Math.max(0, Math.min(selected, count - 1));
  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (count === 0) return;
      if (key.upArrow || input === "k") return onMove(moveSelection(count, sel, -1));
      if (key.downArrow || input === "j") return onMove(moveSelection(count, sel, 1));
      if (key.return && !items[sel]?.disabled) onSelect(sel);
    },
    { isActive },
  );
  const avail = Math.max(1, cols - 2); // paddingX
  const start = menuWindow(count, sel, rows);
  const shown = items.slice(start, start + rows);
  const labelW = Math.min(
    Math.max(1, ...shown.map((it) => width(fit(it.label, avail)))),
    Math.max(1, avail - MARK.length),
  );
  const hint = [footer, count > rows ? `${sel + 1}/${count}` : undefined]
    .filter((x): x is string => x !== undefined && x !== "")
    .join(" · ");
  return (
    <Box flexDirection="column" paddingX={1}>
      {title !== undefined ? (
        <Safe bold wrap="truncate">
          {fit(title, avail)}
        </Safe>
      ) : null}
      {shown.map((it, i) => {
        const index = start + i;
        const on = index === sel;
        const label = fit(it.label, labelW);
        const pad = " ".repeat(Math.max(0, labelW - width(label)));
        const detailW = avail - MARK.length - labelW - 2;
        const color = it.disabled ? theme.dim : on ? theme.accent : undefined;
        return (
          <Text key={index} wrap="truncate">
            <Text color={on ? theme.accent : undefined}>{on ? MARK : NO_MARK}</Text>
            <Safe bold={!it.disabled} color={color} inverse={on}>
              {`${label}${pad}`}
            </Safe>
            {it.detail !== undefined && detailW >= 1 ? (
              <Safe color={theme.dim}>{`  ${fit(it.detail, detailW)}`}</Safe>
            ) : null}
          </Text>
        );
      })}
      {hint !== "" ? (
        <Safe wrap="truncate" color={theme.dim}>
          {fit(hint, avail)}
        </Safe>
      ) : null}
    </Box>
  );
}
