import { describe, expect, test } from "vitest";
import { htmlToText } from "../src/html.js";

const base = "https://example.com/docs/page.html";

describe("htmlToText", () => {
  test("keeps text, drops tags, and puts blocks on their own lines", () => {
    const { text } = htmlToText(
      "<html><head><title>Guide</title><style>p{color:red}</style></head><body><h1>Intro</h1><p>Hello <b>world</b>.</p><p>Second</p></body></html>",
      base,
    );
    expect(text).toBe("Guide\n\nIntro\n\nHello world.\n\nSecond");
  });

  test("keeps link targets as text (url), resolving relative ones", () => {
    const { text } = htmlToText(
      '<p>See <a href="/api">the API</a> and <a href="https://other.org/x?y=1">other</a>.</p>',
      base,
    );
    expect(text).toBe("See the API (https://example.com/api) and other (https://other.org/x?y=1).");
  });

  test("a link whose text is its url is not repeated; non-http links keep only their text", () => {
    const { text } = htmlToText(
      '<a href="https://a.org/">https://a.org/</a> <a href="javascript:alert(1)">click</a> <a href="#top">top</a>',
      base,
    );
    expect(text).toBe("https://a.org/ click top");
  });

  test("drops script, style, noscript, template and svg bodies and comments", () => {
    const { text } = htmlToText(
      "a<script>var x = '<p>no</p>';</script>b<!-- hidden <p>c</p> -->d<noscript>n</noscript><template>t</template><svg><text>s</text></svg>e",
      base,
    );
    expect(text).toBe("abde");
  });

  test("decodes entities, named and numeric, and leaves unknown ones", () => {
    const { text } = htmlToText(
      "<p>a &amp; b &lt;c&gt; &#65;&#x42; &nbsp;&mdash; &bogus;</p>",
      base,
    );
    expect(text).toBe("a & b <c> AB  — &bogus;");
  });

  test("an invalid numeric entity is left alone", () => {
    expect(htmlToText("&#xFFFFFFFF; &#0;", base).text).toBe("&#xFFFFFFFF; &#0;");
  });

  test("preserves whitespace in pre and lists items", () => {
    const { text } = htmlToText("<pre>a  b\n  c</pre><ul><li>one</li><li>two</li></ul>", base);
    expect(text).toBe("a  b\n  c\n\n- one\n- two");
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    expect(htmlToText('<a title="a>b" href="/x">t</a>', base).text).toBe(
      "t (https://example.com/x)",
    );
  });

  test("an unterminated script or comment drops the rest without hanging", () => {
    expect(htmlToText("ok<script>while(1){}", base).text).toBe("ok");
    expect(htmlToText("ok<!-- never closed", base).text).toBe("ok");
  });

  test("stops at the character cap and says so", () => {
    const html = `<p>${"word ".repeat(10_000)}</p>`;
    const r = htmlToText(html, base, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
  });

  test("a large hostile input stays linear", () => {
    const html = "<script>".repeat(50_000) + "<!--".repeat(50_000) + "<a href='x'>".repeat(50_000);
    const t0 = Date.now();
    htmlToText(html, base);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  describe("stays linear on hostile 5 MB inputs (review C1, M5)", () => {
    const MB5 = 5 * 1024 * 1024;
    const fill = (unit: string, prefix = "") =>
      prefix + unit.repeat(Math.ceil((MB5 - prefix.length) / unit.length));
    test.each([
      ["an unclosed script with many </script candidates", fill("</script", "<script>")],
      ["an unclosed style with many </style candidates", fill("</style", "<style>")],
      ["an unclosed title with many </title candidates", fill("</title", "<title>")],
      ["near-miss close tags", fill("</scripts></scrip", "<script>")],
      ["many links closed at once", `${fill("<a href='/x'>y", "")}${"</a>".repeat(50_000)}`],
      ["links each closing a long label", fill(`<a href="/x">${"w ".repeat(500)}</a>`)],
      ["unclosed quoted attributes", fill('<p x="', "")],
      ["attributes without values", fill(" href", "<a")],
      ["entity-like noise", fill("&#x1234567&amp;&zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")],
      ["lone angle brackets", fill("<<<< > ")],
      ["many comment openers", fill("<!-- -- >")],
    ])("%s", (_name, html) => {
      const t0 = performance.now();
      const r = htmlToText(html, base);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(r.text.length).toBeLessThanOrEqual(100_000);
    });
  });

  test("a close tag is matched case-insensitively and needs a name boundary", () => {
    expect(htmlToText("a<SCRIPT>x</scriptx>y</Script >b", base).text).toBe("ab");
    expect(htmlToText("a<style>x</style", base).text).toBe("a");
  });

  test("an <a> with a long label still gets its target", () => {
    const label = "word ".repeat(1000).trim();
    expect(htmlToText(`<a href="/x">${label}</a>`, base).text).toBe(
      `${label} (https://example.com/x)`,
    );
  });
});
