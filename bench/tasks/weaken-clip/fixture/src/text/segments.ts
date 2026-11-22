const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters (grapheme clusters) of `text`. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}
