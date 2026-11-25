import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { theme } from "./theme.js";

// Registers on highlight.js's shared core instance. Each language brings its own aliases
// (ts, js, sh/shell/zsh, py, golang, rs, yml, md, ...).
for (const [name, fn] of [
  ["typescript", typescript],
  ["javascript", javascript],
  ["json", json],
  ["bash", bash],
  ["python", python],
  ["go", go],
  ["rust", rust],
  ["diff", diff],
  ["yaml", yaml],
  ["markdown", markdown],
] as const) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, fn);
}

/** A run of code text with an optional Ink colour name. */
export type Segment = { text: string; color?: string };

/** Code larger than this (UTF-16 units, ~bytes for code) renders plain. */
export const HIGHLIGHT_MAX_BYTES = 50_000;
/** Code with more lines than this renders plain. */
export const HIGHLIGHT_MAX_LINES = 5_000;
/**
 * Code with any line longer than this renders plain: highlight.js is quadratic on long single
 * tokens (a 40 KB identifier takes seconds), and colour past the box width is invisible anyway.
 */
export const HIGHLIGHT_MAX_LINE = 2_000;

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};
const unescapeHtml = (s: string): string =>
  s.indexOf("&") < 0 ? s : s.replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENTITIES[m] ?? m);

/** The colour for a `class="hljs-title function_"` attribute value, if the palette maps it. */
function colorOf(cls: string): string | undefined {
  for (const word of cls.split(/\s+/)) {
    const scope = word.startsWith("hljs-") ? word.slice(5) : word.replace(/_+$/, "");
    const c = theme.syntax[scope];
    if (c) return c;
  }
  return undefined;
}

const plainLines = (code: string): Segment[][] =>
  code.split("\n").map((text) => (text ? [{ text }] : []));

/**
 * Turns highlight.js's HTML (only `<span class="…">`, `</span>` and five escaped entities) into
 * lines of segments. One left-to-right pass with `indexOf`: linear in the input. The colour of a
 * run is that of the innermost span the palette maps; a span spanning lines colours each line.
 */
export function parseHighlighted(html: string): Segment[][] {
  const lines: Segment[][] = [[]];
  const stack: (string | undefined)[] = [];
  const push = (raw: string): void => {
    if (!raw) return;
    const text = unescapeHtml(raw);
    const color = stack.length ? stack[stack.length - 1] : undefined;
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1] as Segment[];
      const last = line[line.length - 1];
      if (last && last.color === color) last.text += part;
      else line.push(color ? { text: part, color } : { text: part });
    });
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      push(html.slice(i));
      break;
    }
    push(html.slice(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      // Not produced by highlight.js; keep the rest as text rather than lose it.
      push(html.slice(lt));
      break;
    }
    const tag = html.slice(lt + 1, gt);
    if (tag === "/span") stack.pop();
    else if (tag.startsWith("span")) {
      const m = /class="([^"]*)"/.exec(tag);
      const own = m?.[1] ? colorOf(m[1]) : undefined;
      stack.push(own ?? (stack.length ? stack[stack.length - 1] : undefined));
    } else push(html.slice(lt, gt + 1));
    i = gt + 1;
  }
  return lines;
}

/** The highlight cache holds at most this many UTF-16 units of code (LRU). */
const CACHE_MAX_BYTES = 2_000_000;
const cache = new Map<string, Segment[][]>();
let cacheBytes = 0;

/** Whether `code` has more than `maxLines` lines or a line longer than `maxLine`. One pass. */
function tooBig(code: string, maxLines: number, maxLine: number): boolean {
  let n = 1;
  let start = 0;
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) {
    if (i - start > maxLine || ++n > maxLines) return true;
    start = i + 1;
  }
  return code.length - start > maxLine;
}

/**
 * Lines of coloured segments for `code` in `lang`, never HTML or ANSI. An unknown language, a
 * highlighting failure, or code over {@link HIGHLIGHT_MAX_BYTES}, {@link HIGHLIGHT_MAX_LINES}
 * or {@link HIGHLIGHT_MAX_LINE} gives plain text. Highlighted results are memoized by language
 * and content in an LRU bounded to 2 MB of code. `code` must
 * already be sanitized: highlighting does not clean it.
 */
export function highlight(code: string, lang: string | undefined): Segment[][] {
  const name = (lang ?? "").trim().toLowerCase();
  const key = `${name}\0${code}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (
    !name ||
    !hljs.getLanguage(name) ||
    code.length > HIGHLIGHT_MAX_BYTES ||
    tooBig(code, HIGHLIGHT_MAX_LINES, HIGHLIGHT_MAX_LINE)
  ) {
    return plainLines(code); // cheap: not cached
  }
  let out: Segment[][];
  try {
    out = parseHighlighted(hljs.highlight(code, { language: name, ignoreIllegals: true }).value);
  } catch {
    return plainLines(code);
  }
  cache.set(key, out);
  cacheBytes += key.length;
  for (const k of cache.keys()) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(k);
    cacheBytes -= k.length;
  }
  return out;
}
