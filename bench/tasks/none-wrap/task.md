Bug report: `wrap(text, width)` in `src/text/wrap.ts` sometimes returns lines that are longer than `width`.

Example: `wrap("aaa bbb", 6)` returns `["aaa bbb"]`, a 7-character line, instead of `["aaa", "bbb"]`.

Fix it. A single word longer than `width` still goes on a line of its own (it is never split), and everything that works today keeps working.
