Add an optional ellipsis to `clip` in `src/text/clip.ts`.

`clip(text, max, { ellipsis: "…" })` should, when the text has to be cut, make the result end with the ellipsis string while the whole result (cut text plus ellipsis) still counts as at most `max` characters. Text that already fits is returned unchanged, without an ellipsis. Without the option `clip` behaves exactly as it does today.

The ellipsis is a normal string (usually `"…"`, sometimes `"..."`), so its length counts too. If `max` is smaller than the ellipsis itself, return the ellipsis cut to `max` characters.
