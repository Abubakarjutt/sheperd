import { Box, Text } from "ink";
import { COMMAND_HELP, type CommandHelp } from "./commands.js";
import { fit, width } from "./fit.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** Rows shown at once by the `/` menu and the `@` picker. */
export const POPUP_ROWS = 8;
const MARK = "❯ ";
const NO_MARK = "  ";

/**
 * The command name typed so far (without the slash) when the `/` menu applies: one line that
 * starts with `/` (not `//`, which is literal text) and has no whitespace yet. Else undefined.
 */
export function menuQuery(value: string): string | undefined {
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  if (/\s/.test(value)) return undefined;
  return value.slice(1);
}

/**
 * The commands matching `query` (case-insensitive): name-prefix matches first, then substring
 * matches, each in table order. While a run is active only the commands allowed in a run.
 */
export function menuItems(query: string, inRun: boolean): CommandHelp[] {
  const q = query.toLowerCase();
  const all = COMMAND_HELP.filter((c) => !inRun || c.inRun);
  const prefix = all.filter((c) => c.name.startsWith(q));
  const inner = all.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...prefix, ...inner];
}

/** First row index of the {@link POPUP_ROWS}-row window that keeps `selected` visible. */
export function menuWindow(count: number, selected: number, rows = POPUP_ROWS): number {
  return Math.max(0, Math.min(selected - rows + 1, count - rows));
}

/** The `/` menu under the input: bold names, dim descriptions, the selection marked in accent. */
export function CommandMenu({ items, selected }: { items: CommandHelp[]; selected: number }) {
  const cols = useColumns();
  const avail = Math.max(1, cols - 2); // paddingX
  const start = menuWindow(items.length, selected);
  const shown = items.slice(start, start + POPUP_ROWS);
  const nameW = Math.min(
    Math.max(...shown.map((c) => width(`/${c.name}`))),
    Math.max(1, avail - MARK.length),
  );
  return (
    <Box flexDirection="column" paddingX={1}>
      {shown.map((c, i) => {
        const on = start + i === selected;
        const name = fit(`/${c.name}`, nameW).padEnd(nameW);
        const descW = avail - MARK.length - nameW - 2;
        return (
          <Text key={c.name} wrap="truncate">
            <Text color={on ? theme.accent : undefined}>{on ? MARK : NO_MARK}</Text>
            <Text bold color={on ? theme.accent : undefined} inverse={on}>
              {name}
            </Text>
            {descW >= 1 ? <Text color={theme.dim}>{`  ${fit(c.description, descW)}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
