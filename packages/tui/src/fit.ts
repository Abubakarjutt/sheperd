import { redact } from "@rewire/core";
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

/**
 * {@link fit} for untrusted text: sanitized, then redacted, then cut. Sanitizing first rejoins a
 * secret split by an escape sequence; redacting before the cut means a cut can never leave a
 * prefix of a secret that no longer matches its pattern.
 */
export function fitClean(text: string, cols: number): string {
  return fit(redact(sanitize(text)), cols);
}

/** {@link fitStart} with the same sanitize-redact-cut order as {@link fitClean}. */
export function fitStartClean(text: string, cols: number): string {
  return fitStart(redact(sanitize(text)), cols);
}

/**
 * Like {@link fit}, but cuts from the start: `…/projects/rewire`. For paths, whose tail (the repo
 * name) says the most. The cut starts at a `/` when one is in the kept tail.
 */
export function fitStart(text: string, cols: number): string {
  const max = Math.floor(cols);
  if (!(max >= 1)) return "";
  const flat = sanitize(text).replace(/[\n\t]+/g, " ");
  if (width(flat) <= max) return flat;
  const budget = max - 1; // room for the ellipsis
  const parts = [...segmenter.segment(flat)].map((s) => s.segment);
  let out = "";
  let used = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i] ?? "";
    const w = width(seg);
    if (used + w > budget) break;
    out = seg + out;
    used += w;
  }
  const slash = out.indexOf("/", 1);
  if (!out.startsWith("/") && slash > 0 && slash < out.length - 1) out = out.slice(slash);
  return `…${out}`;
}
