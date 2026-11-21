import { randomUUID } from "node:crypto";

const CLOSER = /<\s*\/\s*(diff|file|contract)/gi;
const ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const escAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Fence untrusted content. Any closing tag for diff/file/contract inside the content is
 * defanged (`</diff`, `</ DIFF`, `</file id="x"` all become `<\/...`), and the real tags carry
 * a random per-call `id` so a forged closer cannot match. Attribute values are escaped.
 */
export function wrapUntrusted(
  tag: "diff" | "file" | "contract",
  content: string,
  attrs: Record<string, string> = {},
): string {
  const id = randomUUID();
  const extra = Object.entries(attrs)
    .filter(([k]) => k !== "id")
    .map(([k, v]) => {
      if (!ATTR_NAME.test(k)) throw new Error(`invalid attribute name: ${k}`);
      return ` ${k}="${escAttr(v)}"`;
    })
    .join("");
  const body = content.replace(CLOSER, "<\\/$1");
  return `<${tag} id="${id}"${extra}>\n${body}\n</${tag} id="${id}">`;
}
