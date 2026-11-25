// Force Ink's colour output on (before ink/chalk load) so the SGR assertions are not vacuous.
vi.hoisted(() => {
  process.env.FORCE_COLOR = "1";
});

import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { describe, expect, it, vi } from "vitest";
import { HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES, highlight } from "../src/highlight.js";
import { cleanForMarkdown, Markdown } from "../src/markdown.js";

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

/** No escape byte other than Ink's own SGR colour codes. */
function expectOnlySgr(f: string): void {
  expect(f.replace(SGR, "")).not.toContain("\x1b");
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

  it("renders 200 KB of styled prose in under 500 ms", () => {
    const { f, ms } = timed(
      fill(() => "Some **bold** text with `code` and a [link](https://e.x) to read.\n\n"),
    );
    expect(plain(f)).toContain("Some bold text");
    expect(ms).toBeLessThan(500);
  });

  it("renders a 200 KB code block (past the highlight cap) in under 500 ms", () => {
    const { f, ms } = timed(
      `\`\`\`ts\n${fill(() => "const value: number = compute(1, 2);\n")}\`\`\``,
    );
    expect(plain(f)).toContain("const value");
    expect(ms).toBeLessThan(500);
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
