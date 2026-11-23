import { graphemes } from "./segments.js";

/**
 * Cuts `text` to at most `max` user-perceived characters. Never splits a character: emoji,
 * ZWJ sequences, flags and letters with combining accents are kept whole or dropped whole.
 */
export function clip(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) throw new RangeError(`max must be a non-negative integer`);
  const chars = graphemes(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}
