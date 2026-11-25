// Force Ink's colour output on (before ink/chalk load) so the SGR assertions are not vacuous.
// Restored in afterAll; vitest isolates each test file in its own module graph.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  return previous;
});

import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_LINES,
  highlight,
} from "../src/highlight.js";
import { cleanForMarkdown, decodeEntities, Markdown } from "../src/markdown.js";

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

const ESC = "\x1b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");

function frame(text: string, width = 60): string {
  const v = render(<Markdown text={text} width={width} />);
  const f = v.lastFrame() ?? "";
  v.unmount();
  return f;
}

/** Every rendered line fits in `cols` display columns. */
function expectFits(f: string, cols: number): void {
  for (const line of plain(f).split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(cols);
}

/**
 * SGR parameters Ink (chalk) emits for the props we use: reset, bold/dim (1, 2, 22), italic
 * (3, 23), underline (4, 24), inverse (7, 27), strikethrough (9, 29) and foreground colours
 * (30-37, 39, 90-97). Notably absent: conceal (8), blink (5), backgrounds (40-49, 100-107).
 */
const ALLOWED_SGR = new Set([
  0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 39, 90, 91, 92, 93, 94,
  95, 96, 97,
]);

/** Every ESC starts an SGR made only of Ink's parameters; no other ESC and no C1 CSI. */
function expectOnlySgr(f: string): void {
  for (const m of f.matchAll(SGR)) {
    const params = m[0].slice(2, -1).split(";").filter(Boolean).map(Number);
    for (const p of params) expect(ALLOWED_SGR.has(p), `SGR ${m[0].slice(1)}`).toBe(true);
  }
  expect(f.replace(SGR, "")).not.toContain("\x1b");
  expect(f).not.toContain("\x9b");
}

describe("Markdown constructs", () => {
  it("renders headings without the # markers", () => {
    const f = plain(frame("# Title\n\n## Sub\n\n### Third\n\nbody"));
    expect(f).toContain("Title");
    expect(f).toContain("Sub");
    expect(f).toContain("Third");
    expect(f).not.toContain("#");
  });

  it("renders bold, italic and strikethrough without markers", () => {
    const f = plain(frame("this is **bold**, *italic*, _also_ and ~~gone~~ text"));
    expect(f).toContain("this is bold, italic, also and gone text");
    expect(f).not.toContain("**");
    expect(f).not.toContain("*");
    expect(f).not.toContain("~~");
  });

  it("renders inline code without backticks", () => {
    const f = plain(frame("run `pnpm test` now"));
    expect(f).toContain("run pnpm test now");
    expect(f).not.toContain("`");
  });

  it("renders bullet lists with • and nested indentation", () => {
    const lines = plain(frame("- one\n  - nested\n    - deeper\n- two")).split("\n");
    expect(lines).toContain("• one");
    expect(lines).toContain("  • nested");
    expect(lines).toContain("    • deeper");
    expect(lines).toContain("• two");
  });

  it("keeps the numbers of ordered lists", () => {
    const lines = plain(frame("3. three\n4. four\n   - sub")).split("\n");
    expect(lines).toContain("3. three");
    expect(lines).toContain("4. four");
    expect(lines).toContain("   • sub");
  });

  it("renders task list checkboxes", () => {
    const f = plain(frame("- [ ] todo\n- [x] done"));
    expect(f).toContain("• [ ] todo");
    expect(f).toContain("• [x] done");
  });

  it("gives block quotes a │ gutter", () => {
    const lines = plain(frame("> quoted line\n> second")).split("\n");
    expect(lines.some((l) => l.startsWith("│ quoted line"))).toBe(true);
    expect(plain(frame("> q"))).not.toContain(">");
  });

  it("shows a link's text and its URL in parentheses", () => {
    const f = plain(frame("see [the docs](https://example.com/docs) here"));
    expect(f).toContain("see the docs (https://example.com/docs) here");
    expect(f).not.toContain("[");
    expect(f).not.toContain("](");
  });

  it("shows the URL once when the link text is the URL", () => {
    const f = plain(frame("go to https://example.com now"));
    expect(f).toContain("go to https://example.com now");
    expect(f.split("https://example.com").length).toBe(2);
  });

  it("renders fenced code in a round box with the language label", () => {
    const f = plain(frame("```ts\nconst a = 1;\n```", 40));
    expect(f).toContain("╭");
    expect(f).toContain("╰");
    expect(f).toContain("ts");
    expect(f).toContain("const a = 1;");
    expect(f).not.toContain("```");
    expectFits(f, 40);
  });

  it("keeps code indentation", () => {
    const f = plain(frame("```\nif (x) {\n    y();\n}\n```", 40));
    expect(f).toContain("│ if (x) {");
    expect(f).toContain("│     y();");
  });

  it("renders a table as aligned columns with a header rule", () => {
    const f = plain(frame("| name | n |\n|------|---:|\n| alpha | 1 |\n| b | 200 |", 40));
    const lines = f.split("\n");
    expect(f).not.toContain("|");
    expect(lines.some((l) => /^─+$/.test(l.trim()) || /─/.test(l))).toBe(true);
    const alpha = lines.find((l) => l.includes("alpha"));
    const b = lines.find((l) => l.startsWith("b "));
    expect(alpha).toBeDefined();
    expect(b).toBeDefined();
    // Right-aligned numeric column: both rows end at the same column.
    expect(stringWidth(alpha?.trimEnd() ?? "")).toBe(stringWidth(b?.trimEnd() ?? ""));
    expectFits(f, 40);
  });

  it("truncates a wide table to fit", () => {
    const row = `| ${"x".repeat(50)} | ${"y".repeat(50)} |`;
    const f = frame(`| a | b |\n|---|---|\n${row}`, 40);
    expectFits(f, 40);
    expect(plain(f)).toContain("…");
  });

  it("degrades a table to key: value lines below about 20 columns", () => {
    const f = plain(frame("| name | n |\n|---|---|\n| alpha | 1 |", 18));
    expect(f).toContain("name: alpha");
    expect(f).toContain("n: 1");
    expectFits(f, 18);
  });

  it("renders a horizontal rule across the full width", () => {
    const f = plain(frame("above\n\n---\n\nbelow", 40));
    expect(f.split("\n")).toContain("─".repeat(40));
  });

  it("wraps paragraph text to the width", () => {
    const f = frame("word ".repeat(60), 40);
    expect(plain(f).split("\n").length).toBeGreaterThan(3);
    expectFits(f, 40);
  });

  it("leaves no markdown markers across a mixed reply", () => {
    const f = plain(
      frame(
        "## Plan\n\n1. Read **the** file\n2. Edit `src/a.ts`\n\n> note *this*\n\n```js\nlet x = 1\n```",
        60,
      ),
    );
    for (const m of ["**", "#", "`", "> "]) expect(f).not.toContain(m);
  });
});

describe("highlight", () => {
  it("colours TypeScript keywords and strings", () => {
    const lines = highlight('const x: number = 1;\nreturn "s";', "ts");
    expect(lines).toHaveLength(2);
    const first = lines[0] ?? [];
    expect(first.find((s) => s.text === "const")?.color).toBe("magenta");
    expect(first.find((s) => s.text === "1")?.color).toBe("yellow");
    expect((lines[1] ?? []).find((s) => s.text.includes('"s"'))?.color).toBe("green");
  });

  it("reproduces the code text exactly, unescaping entities", () => {
    const code = "if (a < b && c > d) { s = \"q\" + 'r' + `&amp;`; } // done";
    const lines = highlight(code, "typescript");
    expect(lines.map((l) => l.map((s) => s.text).join("")).join("\n")).toBe(code);
  });

  it("keeps a multi-line comment's colour on each line", () => {
    const lines = highlight("/* one\ntwo */\nlet y", "js");
    expect(lines).toHaveLength(3);
    expect(lines[1]?.[0]).toEqual({ text: "two */", color: "gray" });
  });

  it("renders an unknown language as plain text", () => {
    expect(highlight("a < b\nc", "klingon")).toEqual([[{ text: "a < b" }], [{ text: "c" }]]);
    expect(highlight("x", undefined)).toEqual([[{ text: "x" }]]);
  });

  it("falls back to plain text beyond the size and line caps", () => {
    const many = "let a = 1\n".repeat(HIGHLIGHT_MAX_LINES + 1);
    expect(highlight(many, "ts").every((l) => l.every((s) => s.color === undefined))).toBe(true);
    const big = `let a = "${"x".repeat(HIGHLIGHT_MAX_BYTES)}"`;
    expect(highlight(big, "ts")[0]?.[0]?.color).toBeUndefined();
    const longLine = `let a = 1\nlet b = "${"x".repeat(HIGHLIGHT_MAX_LINE)}"`;
    expect(highlight(longLine, "ts")[0]?.[0]?.color).toBeUndefined();
  });

  it("supports each registered language", () => {
    for (const lang of [
      "ts",
      "js",
      "json",
      "bash",
      "sh",
      "python",
      "go",
      "rust",
      "diff",
      "yaml",
      "md",
    ]) {
      expect(() => highlight("x = 1", lang)).not.toThrow();
    }
    expect(highlight("+added", "diff")[0]?.[0]?.color).toBe("green");
  });

  it("colours a ts keyword in the rendered frame", () => {
    const v = render(<Markdown text={"```ts\nconst a = 1\n```"} width={40} />);
    const f = v.lastFrame() ?? "";
    v.unmount();
    expect(plain(f)).toContain("const");
    expect(f).toMatch(new RegExp(`${ESC}\\[35mconst`));
  });
});

describe("robustness", () => {
  it("renders a 2,000-character code line at 40 columns without overflowing (Review Focus 2)", () => {
    const line = `const s = "${"a".repeat(2000)}";`;
    const f = frame(`\`\`\`ts\n${line}\n\`\`\``, 40);
    expectFits(f, 40);
    expect(plain(f)).toContain("…");
    expect(plain(f)).toContain("const");
  });

  it("does not throw on an unterminated fence", () => {
    const f = plain(frame("text\n\n```ts\nconst a = 1\nstill going", 40));
    expect(f).toContain("const a = 1");
    expect(f).toContain("still going");
  });

  it("does not throw on a malformed table", () => {
    expect(() => frame("| a | b\n|--\n| 1 | 2 | 3 | 4 |\n|", 40)).not.toThrow();
    expect(() => frame("| a | b | c |\n|---|---|---|\n| 1 |", 40)).not.toThrow();
  });

  it("does not throw on deeply nested lists", () => {
    const text = Array.from({ length: 60 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    const f = frame(text, 40);
    expectFits(f, 40);
    expect(plain(f)).toContain("level 0");
  });

  it("handles empty and whitespace-only text", () => {
    expect(() => frame("", 40)).not.toThrow();
    expect(() => frame("   \n\n  ", 40)).not.toThrow();
  });

  const fill = (unit: (i: number) => string): string => {
    let s = "";
    for (let i = 0; s.length < 200_000; i++) s += unit(i);
    return s;
  };
  const timed = (text: string, width = 80): { f: string; ms: number } => {
    const t0 = performance.now();
    const f = frame(text, width);
    return { f, ms: performance.now() - t0 };
  };

  it("renders 200 KB of styled prose in under 1500 ms", () => {
    const { f, ms } = timed(
      fill(() => "Some **bold** text with `code` and a [link](https://e.x) to read.\n\n"),
    );
    expect(plain(f)).toContain("Some bold text");
    expect(ms).toBeLessThan(1500);
  });

  it("renders a 200 KB code block (past the highlight cap) in under 1500 ms", () => {
    const { f, ms } = timed(
      `\`\`\`ts\n${fill(() => "const value: number = compute(1, 2);\n")}\`\`\``,
    );
    expect(plain(f)).toContain("const value");
    expect(ms).toBeLessThan(1500);
  });

  it("renders a 200 KB mixed reply (600 highlighted blocks) without pathological slowdown", () => {
    // ~11k output lines: Ink's own layout and output dominate (~0.5 s locally), hence the budget.
    const { f, ms } = timed(
      fill(
        (i) =>
          `## Step ${i}\n\nThe **parser** reads \`src/a${i}.ts\` then [docs](https://e.x/${i}).\n\n- one\n- two *x*\n\n\`\`\`ts\nexport function f${i}(a: number): number {\n  // add\n  return a + ${i};\n}\n\`\`\`\n\n`,
      ),
    );
    expect(plain(f)).toContain("Step 0");
    expect(ms).toBeLessThan(1500);
  });

  it("emits no escape byte except SGR, even for hostile input", () => {
    const hostile =
      "# t\x1b]52;c;ZXZpbA==\x07itle\n\n`co\x1b[2Jde` and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\n\n```bash\necho \x1b[31mred\x9b2J\n```\n\n| a\x1b[1m | b |\n|---|---|\n| \x1bP1$r | 2 |";
    const cleaned = cleanForMarkdown(hostile);
    expect(cleaned).not.toContain("\x1b");
    expect(cleaned).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    const f = frame(cleaned, 40);
    expectOnlySgr(f);
    expect(f).not.toContain("\x9b");
  });
});

describe("fix round 1", () => {
  const consoleQuiet = <T,>(fn: () => T): T => {
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    try {
      const out = fn();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      return out;
    } finally {
      for (const s of spies) s.mockRestore();
    }
  };

  it.each([
    ["conceal SGR", "Tests passed. &#x1b;[8mhidden text&#x1b;[0m Done."],
    ["OSC 8", "see &#27;]8;;https://evil.example&#27;\\click&#27;]8;;&#27;\\ here"],
    ["C1 CSI", "a &#155;2J b &#x9b;41m c"],
    ["background SGR in a heading", "# head &#27;[41mred"],
    ["in a table cell", "| h &#x1b;[8m |\n|---|\n| c &#27;[5m |"],
    ["in a link label", "[x &#x1b;[8my](https://e.x)"],
    ["bidi override", "abc &#x202e;fed"],
  ])("renders entity-encoded escapes (%s) inert", (_name, input) => {
    const f = consoleQuiet(() => frame(cleanForMarkdown(input), 60));
    expectOnlySgr(f);
    expect(plain(f)).not.toContain("\u202e");
    expect(plain(f)).not.toContain("&#");
  });

  it("keeps visible text around an entity-encoded escape", () => {
    const f = plain(frame("Tests passed. &#x1b;[8mhidden&#x1b;[0m Done.", 60));
    expect(f).toContain("Tests passed.");
    expect(f).toContain("hidden");
    expect(f).toContain("Done.");
  });

  it("decodes entities consistently with one mapping", () => {
    expect(plain(frame("AT&T &#169; x &lt; y &amp; z", 60))).toContain("AT&T © x < y & z");
    expect(plain(frame("if a && b &#38; c", 60))).toContain("if a && b & c");
    expect(decodeEntities("&#x110000; &#0; &#xd800; &bogus;")).toBe("\ufffd \ufffd \ufffd &bogus;");
    // Code spans and code blocks stay literal.
    expect(plain(frame("`&amp;`", 60))).toContain("&amp;");
  });

  it("redacts a secret split by markup, after lexing", () => {
    const f = plain(frame("key: `sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123`", 60));
    expect(f).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
  });

  it.each([
    ["quotes and lists", `${"> - ".repeat(100)}x`],
    ["lists", `${"- ".repeat(200)}x`],
    ["quotes", `${">".repeat(300)} x`],
  ])("caps nesting depth (%s) without crashing Yoga", (_name, input) => {
    const f = consoleQuiet(() => frame(input, 40));
    expect(plain(f)).toContain("x");
    expectFits(f, 40);
    // A later render in the same process still works (yoga-wasm state not corrupted).
    expect(plain(frame("# after\n\n- a\n  - b", 40))).toContain("after");
  });

  it("renders content past the depth cap as plain text at depth 8", () => {
    const text = Array.from({ length: 12 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    const f = plain(frame(text, 80));
    for (let i = 0; i < 12; i++) expect(f).toContain(`level ${i}`);
    expect((f.match(/•/g) ?? []).length).toBe(8);
  });

  it("keeps 30 nested quotes within 40 columns", () => {
    const f = frame(`${">".repeat(30)} hello world`, 40);
    expectFits(f, 40);
    expect(plain(f)).toContain("hello");
  });

  it("keeps 5 nested quotes within 10 columns", () => {
    const f = frame(">>>>> hello world", 10);
    expectFits(f, 10);
    expect(plain(f).replace(/[│\s]/g, "")).toBe("helloworld");
  });

  it("keeps narrow nested lists within the width", () => {
    const f = frame("- [x] a\n  - b\n    - c\n      - d", 8);
    expectFits(f, 8);
  });

  it("renders a 40,000-character single-token ts line in under 1500 ms", () => {
    const t0 = performance.now();
    const f = frame(`\`\`\`ts\n${"a".repeat(40_000)}\n\`\`\``, 40);
    expect(performance.now() - t0).toBeLessThan(1500);
    expectFits(f, 40);
  });

  it("renders an unterminated trailing fence plain until it closes", () => {
    const open = frame("text\n\n```ts\nconst a = 1", 40);
    expect(plain(open)).toContain("const a = 1");
    expect(open).not.toMatch(new RegExp(`${ESC}\\[35mconst`));
    const closed = frame("text\n\n```ts\nconst a = 1\n```", 40);
    expect(closed).toMatch(new RegExp(`${ESC}\\[35mconst`));
    // A longer closing fence closes; a shorter one or another character does not.
    expect(frame("````ts\nconst a\n`````", 40)).toMatch(new RegExp(`${ESC}\\[35mconst`));
    expect(frame("````ts\nconst a\n```", 40)).not.toMatch(new RegExp(`${ESC}\\[35mconst`));
  });

  it("shows a www. autolink once", () => {
    const f = plain(frame("visit www.example.com today", 60));
    expect(f).toContain("visit www.example.com today");
    expect(f).not.toContain("http://");
  });

  it("expands tabs in text so lines fit", () => {
    const f = frame(`# a\tb\n\npara\twith\ttabs ${"x\t".repeat(30)}`, 40);
    expect(plain(f)).not.toContain("\t");
    expectFits(f, 40);
  });
});
