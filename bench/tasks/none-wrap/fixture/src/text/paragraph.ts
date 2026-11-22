import { wrap } from "./wrap.js";

/** Wraps each blank-line-separated paragraph and joins them back with a blank line. */
export function wrapParagraphs(text: string, width: number): string {
  return text
    .split(/\n{2,}/)
    .map((p) => wrap(p, width).join("\n"))
    .join("\n\n");
}
