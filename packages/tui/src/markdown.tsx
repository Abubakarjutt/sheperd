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
/** Narrowest content a block quote keeps before it stops drawing its 2-column gutter. */
const QUOTE_MIN_BODY = 4;
/**
 * Lists and quotes nest at most this deep (counted together). Deeper content renders as plain
 * text: unbounded nesting builds Yoga trees deep enough to crash (and corrupt) yoga-wasm.
 */
export const MARKDOWN_MAX_DEPTH = 8;
const TAB = "    ";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** marked's lexer only (never its HTML renderer). A lexer failure shows the text as-is. */
function lex(text: string): Token[] {
  try {
    // silent: false makes marked throw instead of writing to the console mid-render.
    return Lexer.lex(text, { gfm: true, breaks: false, pedantic: false, silent: false });
  } catch {
    return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] }];
  }
}

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * Decodes character references with one known mapping: decimal and hex numeric references
 * plus `&amp; &lt; &gt; &quot; &apos; &nbsp;`. Invalid code points become U+FFFD. The result is
 * NOT terminal-safe (`&#x1b;` decodes to ESC): always pass it through {@link leaf}.
 */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g,
    (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return NAMED[name] ?? m;
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : "\ufffd";
    },
  );
}

/**
 * The render boundary for every string taken from a token: sanitize, redact, and expand tabs
 * (a terminal tab would overrun the computed width). Runs after lexing because marked's lexer
 * itself decodes numeric references, so text that was clean before lexing may not be after.
 */
const leaf = (s: string): string => redact(sanitize(s)).replaceAll("\t", TAB);

const tokensOf = (t: Token): Token[] | undefined =>
  "tokens" in t && Array.isArray(t.tokens) ? (t.tokens as Token[]) : undefined;

const textOf = (t: Token): string =>
  "text" in t && typeof t.text === "string" ? t.text : typeof t.raw === "string" ? t.raw : "";

/**
 * The clean visible text of a leaf token. A `text` token is taken from its source (`raw`) and
 * decoded here, not from marked's `text` (which decodes numeric references and re-escapes `&`
 * inconsistently). Code spans are literal. Everything goes through {@link leaf}.
 */
function leafText(t: Token): string {
  if (t.type === "text" && typeof t.raw === "string") return leaf(decodeEntities(t.raw));
  if (t.type === "html") return leaf(typeof t.raw === "string" ? t.raw : textOf(t));
  return leaf(textOf(t));
}

/** The visible text of inline tokens, without styling (for widths and comparisons). */
function inlinePlain(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    if (t.type === "br") out += " ";
    else if (t.type === "checkbox") out += (t as Tokens.Checkbox).checked ? "[x] " : "[ ] ";
    else {
      const inner = tokensOf(t);
      out += inner ? inlinePlain(inner) : leafText(t);
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
            {leafText(t)}
          </Text>
        );
      case "br":
        return "\n";
      case "checkbox":
        return (t as Tokens.Checkbox).checked ? "[x] " : "[ ] ";
      case "link":
      case "image": {
        const href = leaf(decodeEntities((t as Tokens.Link).href ?? ""));
        const inner = tokensOf(t);
        const label = inner ? inline(inner) : [leafText(t)];
        const shown = inner ? inlinePlain(inner) : leafText(t);
        const same =
          !href || [shown, `mailto:${shown}`, `http://${shown}`, `https://${shown}`].includes(href);
        return (
          <Text key={key}>
            <Text underline>{label}</Text>
            {same ? null : <Text dimColor>{` (${href})`}</Text>}
          </Text>
        );
      }
      default: {
        const inner = tokensOf(t);
        return inner ? <Text key={key}>{inline(inner)}</Text> : leafText(t);
      }
    }
  });
}

/** Block tokens flattened to plain lines (past the nesting cap). */
function flatten(tokens: Token[] | undefined, out: string[]): string[] {
  for (const t of tokens ?? []) {
    if (t.type === "space" || t.type === "def" || t.type === "hr") continue;
    if (t.type === "list") for (const item of (t as Tokens.List).items) flatten(item.tokens, out);
    else if (t.type === "blockquote") flatten(tokensOf(t), out);
    else if (t.type === "code") out.push(leaf(textOf(t)));
    else if (t.type === "table") {
      const tt = t as Tokens.Table;
      for (const r of [tt.header ?? [], ...(tt.rows ?? [])])
        out.push(r.map((c) => inlinePlain(c.tokens).trim()).join("  "));
    } else {
      const inner = tokensOf(t);
      out.push(inner ? inlinePlain(inner) : leafText(t));
    }
  }
  return out;
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

/**
 * Whether a code token is finished: an indented block, or a fence closed by a line of the same
 * fence character at least as long. A still-open fence (a streaming reply) renders plain, so a
 * growing block is not re-highlighted on every update.
 */
function fenceClosed(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open?.[1]) return true;
  const lines = raw.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return false;
  const last = (lines[lines.length - 1] ?? "").trim();
  const ch = open[1][0] ?? "`";
  return last.length >= open[1].length && [...last].every((c) => c === ch);
}

/** A fenced code block: dim round box, dim language label, highlighted lines cut to fit. */
const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  plain,
  width,
}: {
  code: string;
  lang: string;
  plain: boolean;
  width: number;
}): ReactNode {
  const lines = useMemo(
    () => highlight(leaf(code), plain ? undefined : lang || undefined),
    [code, lang, plain],
  );
  // Box: 2 border columns + 2 padding columns. Below 6 columns there is no box.
  const boxed = width >= 6;
  const inner = boxed ? width - 4 : width;
  const cut = useMemo(() => lines.map((l) => truncateSegments(l, inner)), [lines, inner]);
  const label = lang ? fit(leaf(lang), inner) : "";
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

function ListBlock({
  token,
  width,
  depth,
}: {
  token: Tokens.List;
  width: number;
  depth: number;
}): ReactNode {
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
          depth + 1,
        );
        if (body < LIST_MIN_BODY)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and static
            <Box key={i} flexDirection="column" width={width}>
              <Text wrap="truncate">{marker}</Text>
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

function block(t: Token, width: number, depth: number): ReactNode {
  switch (t.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const level = (t as Tokens.Heading).depth;
      return (
        <Text bold color={level <= 2 ? theme.accent : undefined}>
          {inline(tokensOf(t))}
        </Text>
      );
    }
    case "paragraph":
    case "text": {
      const inner = tokensOf(t);
      return <Text wrap="wrap">{inner ? inline(inner) : leafText(t)}</Text>;
    }
    case "code":
      return (
        <CodeBlock
          code={textOf(t)}
          lang={((t as Tokens.Code).lang ?? "").split(/\s/)[0] ?? ""}
          plain={!fenceClosed(typeof t.raw === "string" ? t.raw : "")}
          width={width}
        />
      );
    case "blockquote":
    case "list": {
      if (depth >= MARKDOWN_MAX_DEPTH)
        return <Text wrap="wrap">{flatten([t], []).join("\n")}</Text>;
      if (t.type === "list")
        return <ListBlock token={t as Tokens.List} width={width} depth={depth} />;
      // No room for the 2-column gutter: render the quote's content flush.
      if (width - 2 < QUOTE_MIN_BODY) return blocks(tokensOf(t) ?? [], width, true, depth + 1);
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
          {blocks(tokensOf(t) ?? [], width - 2, true, depth + 1)}
        </Box>
      );
    }
    case "table":
      return <Table token={t as Tokens.Table} width={width} />;
    case "hr":
      return <Text dimColor>{"─".repeat(width)}</Text>;
    default:
      // html and anything unknown: the source text, cleaned, as plain text.
      return <Text wrap="wrap">{leafText(t).replace(/\n+$/, "")}</Text>;
  }
}

/** One block, re-rendered only when its source, width or depth changes (streaming appends). */
const Block = memo(
  function Block({
    token,
    width,
    depth,
  }: {
    token: Token;
    width: number;
    depth: number;
  }): ReactNode {
    return block(token, width, depth);
  },
  (a, b) =>
    a.width === b.width &&
    a.depth === b.depth &&
    a.token.raw === b.token.raw &&
    a.token.type === b.token.type,
);

const visible = (t: Token): boolean => t.type !== "space" && t.type !== "def";

/**
 * Block tokens in a column; `spaced` puts a blank line between blocks (top level, quotes).
 * `depth` counts the enclosing lists and quotes (see {@link MARKDOWN_MAX_DEPTH}).
 */
function blocks(tokens: Token[], width: number, spaced: boolean, depth: number): ReactNode {
  return (
    <Box flexDirection="column" width={width} rowGap={spaced ? 1 : 0}>
      {tokens.filter(visible).map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; Block memoizes on source
        <Block key={i} token={t} width={width} depth={depth} />
      ))}
    </Box>
  );
}

/**
 * Renders Markdown as Ink components, never wider than `width`. `text` should already be
 * sanitized and redacted: use {@link cleanForMarkdown} at the call site. Every string taken
 * from a token is cleaned again after lexing (marked decodes numeric references). Parsing is memoized on
 * `text`, highlighting per code block. Output is Ink `<Text>` styling only, never raw ANSI.
 */
export function Markdown({ text, width }: { text: string; width: number }): ReactNode {
  const tokens = useMemo(() => lex(text), [text]);
  const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
  return blocks(tokens, w, true, 0);
}
