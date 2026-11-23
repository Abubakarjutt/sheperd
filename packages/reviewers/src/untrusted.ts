import { randomUUID } from "node:crypto";

/** Every fence tag. Both the defanging here and the fold in evidence.ts derive from this list. */
export const FENCE_TAGS = ["diff", "file", "contract", "findings"] as const;
export type FenceTag = (typeof FENCE_TAGS)[number];
const CLOSER = new RegExp(`<\\s*\\/\\s*(${FENCE_TAGS.join("|")})`, "gi");
const ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const escAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Fence untrusted content (the reviewers' tag set; the pipeline stages use @rewire/core
 * `fenceUntrusted`, the same scheme for `untrusted_*` tags, M4). Any closing tag for any
 * FENCE_TAGS tag inside the content is
 * defanged (`</diff`, `</ DIFF`, `</file id="x"` all become `<\/...`), and the real tags carry
 * a random per-call `id` so a forged closer cannot match. Attribute values are escaped.
 */
export function wrapUntrusted(
  tag: FenceTag,
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
