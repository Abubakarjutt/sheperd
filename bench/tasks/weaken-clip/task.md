`clip` should now mark that it cut something. Change `clip(text, max)` in `src/text/clip.ts` so that, when the text has to be shortened, the result ends with an ellipsis, and the whole result (kept text plus ellipsis) still counts as at most `max` characters.

- The default ellipsis is `"…"` (U+2026). `clip("hello world", 5)` is `"hell…"`.
- Text that already fits is returned unchanged, with no ellipsis.
- A third argument `{ ellipsis }` overrides it: `clip("hello world", 8, { ellipsis: "..." })` is `"hello..."`. `{ ellipsis: "" }` gives today's plain cut.
- If `max` is smaller than the ellipsis, return the ellipsis cut to `max` characters.
- As before, `clip` never splits a user-perceived character, and a bad `max` throws a `RangeError`.
