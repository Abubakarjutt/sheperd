import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { width as displayWidth } from "./fit.js";

/** A run of already-cleaned text with its style. `dim` renders as Ink's `dimColor`. */
export type Styled = {
  text: string;
  color?: string | undefined;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts styled runs to at most `cols` display columns on grapheme boundaries, ending with a dim
 * `…` when anything was cut. The runs must already be sanitized and redacted, on one line.
 */
export function cutStyled(segs: readonly Styled[], cols: number): Styled[] {
  const max = Math.floor(cols);
  if (!(max >= 1)) return [];
  const total = segs.reduce((n, s) => n + displayWidth(s.text), 0);
  if (total <= max) return [...segs];
  const budget = max - 1;
  const out: Styled[] = [];
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
  out.push({ text: "…", dim: true });
  return out;
}

/** One line of styled runs (already cut to fit), truncated rather than wrapped. */
export function StyledLine({ segs }: { segs: readonly Styled[] }): ReactNode {
  if (segs.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and static
          key={i}
          {...(s.color ? { color: s.color } : {})}
          bold={s.bold ?? false}
          dimColor={s.dim ?? false}
          italic={s.italic ?? false}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Narrower than this, a card has no border (its content is shown flush). */
const CARD_MIN = 6;

/** Content columns inside a {@link Card} that is `cols` wide. */
export const cardInner = (cols: number): number => (cols >= CARD_MIN ? cols - 4 : cols);

/**
 * A round-bordered card, matching the welcome header: two border columns and one column of
 * padding on each side ({@link cardInner} gives the content width for a terminal `cols` wide).
 * It stretches to its parent (the terminal) rather than taking `cols` as a fixed width, so a
 * stale `cols` between a resize and its event can never make it overflow.
 */
export function Card({
  color,
  cols,
  children,
}: {
  color: string;
  cols: number;
  children: ReactNode;
}): ReactNode {
  if (cols < CARD_MIN) return <Box flexDirection="column">{children}</Box>;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {children}
    </Box>
  );
}
