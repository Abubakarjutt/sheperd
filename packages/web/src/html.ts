/**
 * HTML to readable text: a bounded, single-pass scanner (no DOM, no dependency). It keeps the
 * text, puts block elements on their own lines, keeps link targets as `text (url)`, drops
 * script/style-like bodies and comments, and decodes entities. Every search moves forward from
 * the current position, so the work is linear in the input whatever its shape; output stops at
 * `maxChars`.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  times: "×",
  deg: "°",
  rarr: "→",
  larr: "←",
};

/** Decode `&name;`, `&#N;` and `&#xN;`; unknown names and invalid code points stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : whole;
    }
    return Object.hasOwn(NAMED, body.toLowerCase()) ? (NAMED[body.toLowerCase()] ?? whole) : whole;
  });
}

/** Elements whose content is never text for a reader. */
const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
]);
/** Elements whose content is text but never markup. */
const RCDATA = new Set(["title", "textarea"]);
/** Elements that start a paragraph (a blank line). */
const PARAGRAPH = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "title",
  "pre",
  "ul",
  "ol",
  "dl",
  "table",
  "blockquote",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "figure",
  "form",
  "hr",
]);
/** Elements that start a line. */
const LINE = new Set(["br", "div", "tr", "dt", "dd", "figcaption", "textarea", "address", "li"]);

export type HtmlText = { text: string; truncated: boolean };

export function htmlToText(html: string, baseUrl: string, maxChars = 100_000): HtmlText {
  const out: string[] = [];
  let len = 0;
  let pendingSpace = false;
  let pendingBreak = 0;
  let atStart = true;
  let pre = 0;
  let full = false;
  const links: { href: string | undefined; raw: string; at: number }[] = [];

  const push = (s: string): void => {
    if (full || s === "") return;
    out.push(s);
    len += s.length;
    atStart = false;
    if (len >= maxChars) full = true;
  };
  const flush = (): void => {
    if (!atStart && pendingBreak > 0) push("\n".repeat(pendingBreak));
    else if (!atStart && pendingSpace) push(" ");
    pendingBreak = 0;
    pendingSpace = false;
  };
  const block = (n: number): void => {
    pendingBreak = Math.max(pendingBreak, n);
    pendingSpace = false;
  };
  const text = (raw: string): void => {
    if (raw === "") return;
    if (pre > 0) {
      flush();
      push(decodeEntities(raw.replace(/\r\n?/g, "\n")));
      return;
    }
    const collapsed = raw.replace(/[ \t\n\r\f]+/g, " ");
    if (collapsed.startsWith(" ")) pendingSpace = pendingBreak === 0;
    const content = collapsed.trim();
    if (content !== "") {
      flush();
      push(decodeEntities(content));
      pendingSpace = collapsed.endsWith(" ");
    }
  };

  const tagName = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
  let pos = 0;
  while (pos < html.length && !full) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) {
      text(html.slice(pos));
      break;
    }
    text(html.slice(pos, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      pos = end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      if (end < 0) break;
      pos = end + 1;
      continue;
    }
    tagName.lastIndex = lt;
    const m = tagName.exec(html);
    if (m === null) {
      text("<");
      pos = lt + 1;
      continue;
    }
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const end = tagEnd(html, tagName.lastIndex);
    if (end < 0) break;
    const attrs = html.slice(tagName.lastIndex, end);
    pos = end + 1;

    if (!closing && (SKIP.has(name) || RCDATA.has(name))) {
      const close = new RegExp(`</${name}\\b[^>]*>`, "gi");
      close.lastIndex = pos;
      const c = close.exec(html);
      const inner = html.slice(pos, c === null ? html.length : c.index);
      pos = c === null ? html.length : close.lastIndex;
      if (RCDATA.has(name)) {
        block(PARAGRAPH.has(name) ? 2 : 1);
        text(inner);
        block(PARAGRAPH.has(name) ? 2 : 1);
      }
      continue;
    }
    if (PARAGRAPH.has(name)) block(2);
    else if (LINE.has(name)) block(1);
    else if (name === "td" || name === "th") pendingSpace = !atStart;
    if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    if (name === "li" && !closing) {
      flush();
      push("- ");
    }
    if (name === "a") {
      if (!closing) {
        const raw = attr(attrs, "href");
        links.push({
          href: raw === undefined ? undefined : linkTarget(raw, baseUrl),
          raw: raw ?? "",
          at: out.length,
        });
      } else {
        const link = links.pop();
        if (link?.href !== undefined) {
          const label = out.slice(link.at).join("").trim();
          if (label === "") {
            flush();
            push(link.href);
          } else if (label !== link.href && label !== link.raw) {
            push(` (${link.href})`);
          }
        }
      }
    }
  }
  const joined = out.join("");
  const truncated = full;
  return { text: (truncated ? joined.slice(0, maxChars) : joined).trimEnd(), truncated };
}

/** The index of the `>` that ends a tag whose attributes start at `from`, or -1. */
function tagEnd(html: string, from: number): number {
  let lastNonSpace = "";
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (ch === ">") return i;
    if ((ch === '"' || ch === "'") && lastNonSpace === "=") {
      const close = html.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
      lastNonSpace = ch;
      continue;
    }
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== "\f") {
      lastNonSpace = ch ?? "";
    }
  }
  return -1;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
    attrs,
  );
  if (m === null) return undefined;
  return decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
}

/** An absolute http(s) link target, or undefined for fragments, javascript:, mailto: and junk. */
function linkTarget(href: string, baseUrl: string): string | undefined {
  if (href === "" || href.startsWith("#")) return undefined;
  try {
    const u = new URL(href, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
