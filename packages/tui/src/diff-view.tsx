import { redact } from "@rewire/core";
import { Box, useInput } from "ink";
import { type ReactNode, useMemo, useState } from "react";
import { fit } from "./fit.js";
import { highlight } from "./highlight.js";
import { sanitize } from "./sanitize.js";
import { cutStyled, type Styled, StyledLine } from "./styled.js";
import { theme } from "./theme.js";

/** Untrusted view content is shown up to this many UTF-16 units. */
export const VIEW_MAX_TEXT = 200_000;
/**
 * Extra input cleaned past {@link VIEW_MAX_TEXT} before the final cut, so a secret straddling
 * the cap is redacted whole rather than cut to a prefix the patterns no longer match.
 */
const VIEW_SLACK = 4096;
const TAB = "    ";

/**
 * Untrusted text made safe for display, once over the whole text before it is split into lines:
 * cut to the cap plus some slack, sanitized, then redacted (in that order, so a key split by an
 * escape is still caught), and only then cut to the cap.
 */
export const cleanView = (s: string): string =>
  redact(sanitize(s.slice(0, VIEW_MAX_TEXT + VIEW_SLACK))).slice(0, VIEW_MAX_TEXT);

export type DiffLine =
  | { kind: "file" | "hunk" | "meta" | "binary"; text: string }
  | { kind: "add" | "del" | "ctx"; text: string; old?: number; new?: number };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/**
 * A hunk start or count above this is treated as a header without numbers: the gutter then
 * never needs more than 7 digits (this plus the lines a capped diff can hold).
 */
const MAX_LINE_NO = 999_999;
/** The gutter's widest number column. */
export const GUTTER_MAX_DIGITS = 7;

/**
 * Classifies the lines of an already-cleaned unified diff. Hunk bodies are counted from the
 * `@@` header, so a `--- x` or `+++ x` line inside a hunk is content; a hunk header without
 * counts (or a truncated diff) ends at the first line that is not `+`, `-`, ` ` or `\`.
 * `diff --git` shows only the new path; `--- a/` and `+++ b/` are dropped after it (a bare
 * diff's `+++` becomes the file header). Tabs become 4 spaces.
 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  let numbered = false;
  let oldN = 0;
  let newN = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let headed = false;
  const all = diff.split("\n");
  // A diff ending in "\n" (or cut short) leaves a final "": an artifact, not a context line.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  for (const raw of all) {
    const line = raw.includes("\t") ? raw.replace(/\t/g, TAB) : raw;
    if (inHunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === "+") {
        out.push(numbered ? { kind: "add", text: line, new: newN++ } : { kind: "add", text: line });
        newLeft--;
        continue;
      }
      if (c === "-") {
        out.push(numbered ? { kind: "del", text: line, old: oldN++ } : { kind: "del", text: line });
        oldLeft--;
        continue;
      }
      if (c === " " || line === "") {
        out.push(
          numbered
            ? { kind: "ctx", text: line, old: oldN++, new: newN++ }
            : { kind: "ctx", text: line },
        );
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === "\\") {
        out.push({ kind: "meta", text: line });
        continue;
      }
      inHunk = false; // not hunk content: a truncated or malformed hunk ends here
    }
    inHunk = false;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      out.push({ kind: "file", text: m?.[2] ?? line.slice("diff --git ".length) });
      headed = true;
    } else if (line.startsWith("@@")) {
      const m = HUNK.exec(line);
      const nums = m ? [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(Number) : [];
      numbered =
        nums.length === 4 && nums.every((n) => Number.isSafeInteger(n) && n <= MAX_LINE_NO);
      oldN = numbered ? (nums[0] ?? 0) : 0;
      newN = numbered ? (nums[2] ?? 0) : 0;
      oldLeft = numbered ? (nums[1] ?? 0) : Number.POSITIVE_INFINITY;
      newLeft = numbered ? (nums[3] ?? 0) : Number.POSITIVE_INFINITY;
      inHunk = true;
      headed = false;
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("binary file omitted: ")) {
      out.push({ kind: "binary", text: line });
      headed = false;
    } else if (line.startsWith("--- ")) {
      // the old path: the file header (or the following +++) names the file
    } else if (line.startsWith("+++ ")) {
      if (!headed) out.push({ kind: "file", text: line.slice(4).replace(/^b\//, "") });
      headed = true;
    } else if (line !== "") out.push({ kind: "meta", text: line });
  }
  return out;
}

/** Scroll position for `total` lines shown `page` at a time, driven by the keyboard. */
export type ScrollOptions = {
  /** Checked on every key: false ignores the key (e.g. the panel's prompt is no longer current). */
  isActive?: (() => boolean) | undefined;
  /** Esc. */
  onClose?: (() => void) | undefined;
};

/**
 * The first visible line. ↑/↓ move a line, PgUp/PgDn (or b/space) a page, g/G jump to the top
 * or bottom; the position never goes past either end, and is re-clamped when `page` changes.
 */
export function useScroll(total: number, page: number, opts: ScrollOptions = {}): number {
  const [top, setTop] = useState(0);
  const max = Math.max(0, total - page);
  const clamp = (n: number): number => Math.max(0, Math.min(max, n));
  useInput((input, key) => {
    if (opts.isActive && !opts.isActive()) return;
    if (key.escape) {
      opts.onClose?.();
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input === "g") setTop(0);
    else if (input === "G") setTop(max);
    else {
      const step = key.upArrow
        ? -1
        : key.downArrow
          ? 1
          : key.pageUp || input === "b"
            ? -page
            : key.pageDown || input === " "
              ? page
              : 0;
      if (step !== 0) setTop((t) => clamp(clamp(t) + step));
    }
  });
  return clamp(top);
}

/** `count` lines, `page` of them from `top`, then a dim position footer. */
function ScrollFrame({
  count,
  top,
  page,
  width,
  line,
}: {
  count: number;
  top: number;
  page: number;
  width: number;
  line: (i: number) => readonly Styled[];
}): ReactNode {
  const end = Math.min(count, top + page);
  const rows: ReactNode[] = [];
  for (let i = top; i < end; i++) {
    rows.push(<StyledLine key={i} segs={cutStyled(line(i), width)} />);
  }
  const footer = `lines ${count === 0 ? 0 : top + 1}–${end} of ${count} · ↑↓ scroll · esc close`;
  return (
    <Box flexDirection="column">
      {rows}
      <StyledLine segs={[{ text: fit(footer, width), dim: true }]} />
    </Box>
  );
}

export type ViewProps = {
  /** Display columns for each line. */
  width: number;
  /** Content lines shown at once (the footer is one more). */
  rows: number;
} & ScrollOptions;

const digits = (n: number): number => String(Math.max(0, n)).length;

/**
 * A unified diff, coloured and scrollable: file headers bold (path only), `@@` cyan, `+` green,
 * `-` red, context default, `binary file omitted` dim italic, and a dim gutter of old and new
 * line numbers from the hunk headers. `diff` is the raw, untrusted diff: it is cleaned here.
 */
export function DiffView({ diff, width, rows, isActive, onClose }: ViewProps & { diff: string }) {
  const lines = useMemo(() => parseDiff(cleanView(diff)), [diff]);
  const gw = useMemo(() => {
    let n = 0;
    for (const l of lines) {
      if ("old" in l && l.old !== undefined) n = Math.max(n, l.old);
      if ("new" in l && l.new !== undefined) n = Math.max(n, l.new);
    }
    return n > 0 ? Math.min(GUTTER_MAX_DIGITS, digits(n)) : 0;
  }, [lines]);
  const page = Math.max(1, Math.floor(rows));
  const top = useScroll(lines.length, page, { isActive, onClose });
  // No gutter when it would leave too little of the line.
  const gutter = gw > 0 && width - (2 * gw + 2) >= 8;
  const render = (i: number): Styled[] => {
    const l = lines[i];
    if (!l) return [];
    switch (l.kind) {
      case "file":
        return [{ text: l.text, bold: true }];
      case "hunk":
        return [{ text: l.text, color: "cyan" }];
      case "meta":
        return [{ text: l.text, dim: true }];
      case "binary":
        return [{ text: l.text, dim: true, italic: true }];
      default: {
        const color = l.kind === "add" ? "green" : l.kind === "del" ? "red" : undefined;
        const body: Styled = { text: l.text, color };
        if (!gutter) return [body];
        const o = l.old === undefined ? "" : String(l.old);
        const n = l.new === undefined ? "" : String(l.new);
        return [{ text: `${o.padStart(gw)} ${n.padStart(gw)} `, dim: true }, body];
      }
    }
  };
  return <ScrollFrame count={lines.length} top={top} page={page} width={width} line={render} />;
}

export type ViewFile = { path: string; content: string };

/** The extension highlight.js knows as a language name or alias (`ts`, `tsx`, `py`, `rs`, ...). */
const langOf = (path: string): string | undefined => /\.([A-Za-z0-9]+)$/.exec(path)?.[1];

/**
 * Test files in one scroll frame: a bold path header per file, then its contents highlighted by
 * the file's extension. Paths and contents are raw and untrusted: each is cleaned here, whole,
 * before it is split into lines or highlighted.
 */
export function TestsView({
  files,
  width,
  rows,
  isActive,
  onClose,
}: ViewProps & { files: readonly ViewFile[] }) {
  const lines = useMemo(() => {
    const out: Styled[][] = [];
    let budget = VIEW_MAX_TEXT;
    for (const f of files) {
      if (budget <= 0) break;
      const path = cleanView(f.path).replace(/[\n\t]+/g, " ");
      const raw = f.content.slice(0, budget);
      budget -= raw.length;
      const code = cleanView(raw).replace(/\t/g, TAB);
      out.push([{ text: path, bold: true }]);
      for (const segs of highlight(code, langOf(path))) {
        out.push(segs.map((s) => (s.color === theme.dim ? { text: s.text, dim: true } : s)));
      }
    }
    return out;
  }, [files]);
  const page = Math.max(1, Math.floor(rows));
  const top = useScroll(lines.length, page, { isActive, onClose });
  return (
    <ScrollFrame
      count={lines.length}
      top={top}
      page={page}
      width={width}
      line={(i) => lines[i] ?? []}
    />
  );
}

/**
 * Already-cleaned styled lines in the shared scroll frame (the contract card's `v`, every
 * criterion). Each line must be on one line and cleaned by the caller.
 */
export function ListView({
  lines,
  width,
  rows,
  isActive,
  onClose,
}: ViewProps & { lines: readonly (readonly Styled[])[] }) {
  const page = Math.max(1, Math.floor(rows));
  const top = useScroll(lines.length, page, { isActive, onClose });
  return (
    <ScrollFrame
      count={lines.length}
      top={top}
      page={page}
      width={width}
      line={(i) => lines[i] ?? []}
    />
  );
}
