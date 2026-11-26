import { randomUUID } from "node:crypto";

/** A fence id: a lowercase UUID. */
export const FENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Any closing tag of an `untrusted_*` fence, however spaced or cased. */
const UNTRUSTED_CLOSER = /<\s*\/\s*(untrusted_[A-Za-z0-9_]*)/gi;

/**
 * Fence untrusted text for a prompt (M4: the one helper for the pipeline stages): the real tags
 * carry a random per-call `id`, and every `untrusted_*` closer inside the content is defanged
 * (`</untrusted_x` becomes `<\/untrusted_x`), so content can neither guess nor forge the end.
 * The reviewers' `wrapUntrusted` applies the same scheme to its own tag set. `id` may be given
 * (a lowercase UUID) when the same fence must be rebuilt byte for byte, e.g. a persisted chat
 * record re-rendered on resume; it must still be random when first chosen.
 */
export function fenceUntrusted(tag: string, content: string, id: string = randomUUID()): string {
  if (!FENCE_ID.test(id)) {
    throw new Error("fenceUntrusted: the fence id must be a lowercase UUID");
  }
  return `<${tag} id="${id}">\n${defangUntrustedClosers(content)}\n</${tag} id="${id}">`;
}

/** `</untrusted_x` → `<\/untrusted_x` everywhere in `content`. */
export const defangUntrustedClosers = (content: string): string =>
  content.replace(UNTRUSTED_CLOSER, "<\\/$1");
