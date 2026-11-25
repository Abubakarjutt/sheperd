import { Box, Text } from "ink";
import { POPUP_ROWS } from "./command-menu.js";
import { fit, fitStart, width } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

const MARK = "❯ ";
const NO_MARK = "  ";

/** The `@` token being typed: where its `@` is in the value, and the text after it. */
export type AtToken = { start: number; query: string };

/**
 * The `@` token under the cursor (the cursor is always at the end of the value): the last
 * whitespace-free run, when it starts with `@` and sits at the start or after whitespace. So
 * `a@b` (an email address) is not one. A leading `"` after the `@` is not part of the query.
 */
export function atToken(value: string): AtToken | undefined {
  const m = /(^|\s)@(\S*)$/.exec(value);
  if (!m) return undefined;
  const start = m.index + (m[1] as string).length;
  return { start, query: (m[2] as string).replace(/^"/, "") };
}

/** Whether `query`'s characters appear in `text` in order (both already lower-cased). */
function subsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j++) if (text[j] === query[i]) i++;
  return i === query.length;
}

/** The directory part (with its trailing `/`) and the basename of a repo path. */
export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/") + 1;
  return [path.slice(0, cut), path.slice(cut)];
}

/**
 * Up to `limit` files matching `query` as a case-insensitive subsequence, best first: basename
 * starts with the query, then the path does, then the rest; within each, the shortest path,
 * then alphabetical.
 */
export function rankFiles(files: readonly string[], query: string, limit = POPUP_ROWS): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ path: string; tier: number }> = [];
  for (const path of files) {
    const p = path.toLowerCase();
    if (!subsequence(q, p)) continue;
    const tier = splitPath(p)[1].startsWith(q) ? 0 : p.startsWith(q) ? 1 : 2;
    scored.push({ path, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return scored.slice(0, limit).map((s) => s.path);
}

/**
 * `value` with the `@` token replaced by `@<path> `. A path holding whitespace, `"` or `\\` is
 * quoted, with `"` and `\\` backslash-escaped, so the reference is unambiguous.
 */
export function insertPath(value: string, token: AtToken, path: string): string {
  const ref = /[\s"\\]/.test(path) ? `"${path.replace(/[\\"]/g, "\\$&")}"` : path;
  return `${value.slice(0, token.start)}@${ref} `;
}

/** The `@` picker under the input: a dim directory, then the bold basename. */
export function FilePicker({ paths, selected }: { paths: string[]; selected: number }) {
  const cols = useColumns();
  const avail = Math.max(1, cols - 2 - MARK.length); // paddingX and the marker
  return (
    <Box flexDirection="column" paddingX={1}>
      {paths.map((path, i) => {
        const on = i === selected;
        const [dir, base] = splitPath(path);
        const b = fit(base, avail);
        const d = fitStart(dir, avail - width(b));
        return (
          <Text key={path} wrap="truncate">
            <Text color={on ? theme.accent : undefined}>{on ? MARK : NO_MARK}</Text>
            <Safe color={theme.dim}>{d}</Safe>
            <Safe bold color={on ? theme.accent : undefined} inverse={on}>
              {b}
            </Safe>
          </Text>
        );
      })}
    </Box>
  );
}
