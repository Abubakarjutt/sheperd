import { redact } from "@rewire/core";
import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import { memo, type ReactNode, useMemo } from "react";
import { width as displayWidth, fit } from "./fit.js";
import { highlight, type Segment } from "./highlight.js";
import { sanitize } from "./sanitize.js";
import { theme } from "./theme.js";

/**
 * Cleans untrusted model text for {@link Markdown}: `redact(sanitizeTerminal(raw))`. Call it at
 * the call site, on the whole accumulated text (never per streamed delta), and pass the result
 * as `text`. `<Markdown>` itself does not clean its input.
 */
export const cleanForMarkdown = (raw: string): string => redact(sanitize(raw));

/** Below this many columns a table is shown as `key: value` lines. */
const TABLE_MIN_COLS = 20;
/** Narrowest a table column is truncated to before falling back to `key: value` lines. */
const TABLE_MIN_CELL = 3;
/** Narrowest content column a list item keeps before its children stop indenting. */
const LIST_MIN_BODY = 10;
const TAB = "    ";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** marked's lexer only (never its HTML renderer). A lexer failure shows the text as-is. */
function lex(text: string): Token[] {
  try {
    return Lexer.lex(text, { gfm: true, breaks: false, pedantic: false, silent: true });
  } catch {
    return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] }];
  }
}

const tokensOf = (t: Token): Token[] | undefined =>
  "tokens" in t && Array.isArray(t.tokens) ? (t.tokens as Token[]) : undefined;

const textOf = (t: Token): string =>
  "text" in t && typeof t.text === "string" ? t.text : typeof t.raw === "string" ? t.raw : "";

/** The visible text of inline tokens, without styling (for widths and comparisons). */
function inlinePlain(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    if (t.type === "br") out += " ";
    else if (t.type === "checkbox") out += (t as Tokens.Checkbox).checked ? "[x] " : "[ ] ";
    else {
      const inner = tokensOf(t);
      out += inner ? inlinePlain(inner) : textOf(t);
    }
  }
  return out;
}

/** Inline tokens as nested Ink `<Text>` runs. */
function inline(tokens: Token[] | undefined): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = i;
    switch (t.type) {
      case "strong":
        return (
          <Text key={key} bold>
            {inline(tokensOf(t))}
          </Text>
        );
      case "em":
        return (
          <Text key={key} italic>
            {inline(tokensOf(t))}
          </Text>
        );
      case "del":
        return (
          <Text key={key} strikethrough>
            {inline(tokensOf(t))}
          </Text>
        );
      case "codespan":
        return (
          <Text key={key} color={theme.accent}>
            {textOf(t)}
          </Text>
        );
      case "br":
        return "\n";
      case "checkbox":
        return (t as Tokens.Checkbox).checked ? "[x] " : "[ ] ";
      case "link":
      case "image": {
        const href = (t as Tokens.Link).href ?? "";
        const inner = tokensOf(t);
        const label = inner ? inline(inner) : [textOf(t)];
        const shown = inner ? inlinePlain(inner) : textOf(t);
        const same = !href || shown === href || `mailto:${shown}` === href;
        return (
          <Text key={key}>
            <Text underline>{label}</Text>
            {same ? null : <Text dimColor>{` (${href})`}</Text>}
          </Text>
        );
      }
      default: {
        const inner = tokensOf(t);
        return inner ? <Text key={key}>{inline(inner)}</Text> : textOf(t);
      }
    }
  });
}

/** Cuts segments to at most `cols` display columns, ending with `…` when anything was cut. */
function truncateSegments(segs: readonly Segment[], cols: number): Segment[] {
  const total = segs.reduce((n, s) => n + displayWidth(s.text), 0);
  if (total <= cols) return [...segs];
  if (cols < 1) return [];
  const budget = cols - 1;
  const out: Segment[] = [];
  let used = 0;
  outer: for (const s of segs) {
    let text = "";
    for (const { segment } of segmenter.segment(s.text)) {
      const w = displayWidth(segment);
      if (used + w > budget) {
        if (text) out.push({ ...s, text });
        break outer;
      }
      text += segment;
      used += w;
    }
    if (text) out.push({ ...s, text });
  }
  out.push({ text: "…", color: theme.dim });
  return out;
}

/** Segments as Ink `<Text>` runs; the palette's dim colour renders as `dimColor`. */
function runs(segs: readonly Segment[]): ReactNode[] {
  return segs.map((s, i) =>
    s.color === theme.dim ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
      <Text key={i} dimColor>
        {s.text}
      </Text>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and static
      <Text key={i} color={s.color}>
        {s.text}
      </Text>
    ),
  );
}

/** A fenced code block: dim round box, dim language label, highlighted lines cut to fit. */
const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  width,
}: {
  code: string;
  lang: string;
  width: number;
}): ReactNode {
  const lines = useMemo(
    () => highlight(code.replaceAll("\t", TAB), lang || undefined),
    [code, lang],
  );
  // Box: 2 border columns + 2 padding columns. Below 6 columns there is no box.
  const boxed = width >= 6;
  const inner = boxed ? width - 4 : width;
  const cut = useMemo(() => lines.map((l) => truncateSegments(l, inner)), [lines, inner]);
  const label = lang ? fit(lang, inner) : "";
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      {...(boxed ? { borderStyle: "round", borderDimColor: true, paddingX: 1 } : {})}
    >
      {label ? <Text dimColor>{label}</Text> : null}
      {cut.map((segs, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and static
        <Text key={i} wrap="truncate">
          {segs.length ? runs(segs) : " "}
        </Text>
      ))}
    </Box>
  );
});

type Align = "left" | "right" | "center" | null;

function pad(s: string, cols: number, align: Align): string {
  const gap = Math.max(0, cols - displayWidth(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + s + " ".repeat(gap - l);
  }
  return s + " ".repeat(gap);
}

/** Column widths that fit `width` with two-space gutters, or undefined when they cannot. */
function columnWidths(cells: string[][], n: number, width: number): number[] | undefined {
  const widths = Array.from({ length: n }, (_, c) =>
    Math.min(width, Math.max(1, ...cells.map((r) => displayWidth(r[c] ?? "")))),
  );
  const gutters = 2 * (n - 1);
  let excess = widths.reduce((a, b) => a + b, 0) + gutters - width;
  while (excess > 0) {
    let widest = -1;
    for (let c = 0; c < n; c++)
      if (
        (widths[c] ?? 0) > TABLE_MIN_CELL &&
        (widest < 0 || (widths[c] ?? 0) > (widths[widest] ?? 0))
      )
        widest = c;
    if (widest < 0) return undefined;
    const w = widths[widest] ?? 0;
    // Shrink the widest column toward the next widest (at least 1) in one step.
    const next = Math.max(
      TABLE_MIN_CELL,
      ...widths.filter((_, c) => c !== widest && (widths[c] ?? 0) < w),
    );
    const step = Math.max(1, Math.min(excess, w - next));
    widths[widest] = w - step;
    excess -= step;
  }
  return widths;
}

function Table({ token, width }: { token: Tokens.Table; width: number }): ReactNode {
  const header = (token.header ?? []).map((c) => inlinePlain(c.tokens).trim());
  const rows = (token.rows ?? []).map((r) => r.map((c) => inlinePlain(c.tokens).trim()));
  const n = Math.max(header.length, ...rows.map((r) => r.length), 0);
  if (n === 0) return null;
  const aligns: Align[] = Array.from({ length: n }, (_, c) => token.align?.[c] ?? null);
  const widths = width >= TABLE_MIN_COLS ? columnWidths([header, ...rows], n, width) : undefined;
  if (!widths) {
    return (
      <Box flexDirection="column" width={width}>
        {rows.map((r, ri) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and static
          <Box key={ri} flexDirection="column" marginTop={ri > 0 ? 1 : 0}>
            {Array.from({ length: n }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional and static
              <Text key={c} wrap="truncate">
                {fit(`${header[c] ?? ""}: ${r[c] ?? ""}`, width)}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  }
  const line = (cells: string[]): string =>
    widths.map((w, c) => pad(fit(cells[c] ?? "", w), w, aligns[c] ?? null)).join("  ");
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (n - 1);
  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate">
        {line(header)}
      </Text>
      <Text dimColor>{"─".repeat(Math.min(total, width))}</Text>
      {rows.map((r, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and static
        <Text key={ri} wrap="truncate">
          {line(r)}
        </Text>
      ))}
    </Box>
  );
}

function ListBlock({ token, width }: { token: Tokens.List; width: number }): ReactNode {
  const start = typeof token.start === "number" ? token.start : 1;
  // A task item's checkbox joins its marker: `• [x] done`.
  const markers = token.items.map((item, i) => {
    const bullet = token.ordered ? `${start + i}. ` : "• ";
    return item.task ? `${bullet}${item.checked ? "[x]" : "[ ]"} ` : bullet;
  });
  const markerW = Math.max(...markers.map(displayWidth), 0);
  return (
    <Box flexDirection="column" width={width}>
      {token.items.map((item, i) => {
        const marker = markers[i] ?? "• ";
        const body = width - markerW;
        const children = blocks(
          (item.tokens ?? []).filter((c) => c.type !== "checkbox"),
          Math.max(1, body >= LIST_MIN_BODY ? body : width),
          false,
        );
        if (body < LIST_MIN_BODY)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and static
            <Box key={i} flexDirection="column" width={width}>
              <Text>{marker}</Text>
              {children}
            </Box>
          );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and static
          <Box key={i} flexDirection="row" width={width}>
            <Box width={markerW} flexShrink={0}>
              <Text>{marker}</Text>
            </Box>
            <Box flexDirection="column" width={body}>
              {children}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function block(t: Token, width: number): ReactNode {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const depth = (t as Tokens.Heading).depth;
      return (
        <Text bold color={depth <= 2 ? theme.accent : undefined}>
          {inline(tokensOf(t))}
        </Text>
      );
    }
    case "paragraph":
    case "text": {
      const inner = tokensOf(t);
      return <Text wrap="wrap">{inner ? inline(inner) : textOf(t)}</Text>;
    }
    case "code":
      return (
        <CodeBlock
          code={textOf(t)}
          lang={((t as Tokens.Code).lang ?? "").split(/\s/)[0] ?? ""}
          width={width}
        />
      );
    case "blockquote":
      return (
        <Box
          flexDirection="column"
          width={width}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderDimColor
          paddingLeft={1}
        >
          {blocks(tokensOf(t) ?? [], Math.max(1, width - 2), true)}
        </Box>
      );
    case "list":
      return <ListBlock token={t as Tokens.List} width={width} />;
    case "table":
      return <Table token={t as Tokens.Table} width={width} />;
    case "hr":
      return <Text dimColor>{"─".repeat(width)}</Text>;
    default:
      // html and anything unknown: the (already sanitized) source text, as plain text.
      return <Text wrap="wrap">{textOf(t).replace(/\n+$/, "")}</Text>;
  }
}

/** One block, re-rendered only when its source or the width changes (streaming appends). */
const Block = memo(
  function Block({ token, width }: { token: Token; width: number }): ReactNode {
    return block(token, width);
  },
  (a, b) => a.width === b.width && a.token.raw === b.token.raw && a.token.type === b.token.type,
);

const visible = (t: Token): boolean => t.type !== "space" && t.type !== "def";

/** Block tokens in a column; `spaced` puts a blank line between blocks (top level, quotes). */
function blocks(tokens: Token[], width: number, spaced: boolean): ReactNode {
  return (
    <Box flexDirection="column" width={width} rowGap={spaced ? 1 : 0}>
      {tokens.filter(visible).map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; Block memoizes on source
        <Block key={i} token={t} width={width} />
      ))}
    </Box>
  );
}

/**
 * Renders Markdown as Ink components, never wider than `width`. `text` must already be
 * sanitized and redacted: use {@link cleanForMarkdown} at the call site. Parsing is memoized on
 * `text`, highlighting per code block. Output is Ink `<Text>` styling only, never raw ANSI.
 */
export function Markdown({ text, width }: { text: string; width: number }): ReactNode {
  const tokens = useMemo(() => lex(text), [text]);
  const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
  return blocks(tokens, w, true);
}
