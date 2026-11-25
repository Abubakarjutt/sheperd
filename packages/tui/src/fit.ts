import stringWidth from "string-width";
import { sanitize } from "./sanitize.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Display width of already-sanitized text (wide CJK and emoji count as 2 columns). */
export const width = (s: string): number => stringWidth(s);

/**
 * One display line of untrusted text, at most `cols` columns wide. Sanitizes first (so a cut can
 * never split an escape sequence), folds newlines and tabs into spaces, then truncates by display
 * width on grapheme boundaries, ending with an ellipsis. Any `cols` is safe: below 1 gives "".
 */
export function fit(text: string, cols: number): string {
  const max = Math.floor(cols);
  if (!(max >= 1)) return "";
  const flat = sanitize(text).replace(/[\n\t]+/g, " ");
  if (width(flat) <= max) return flat;
  const budget = max - 1; // room for the ellipsis
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(flat)) {
    const w = width(segment);
    if (used + w > budget) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}
