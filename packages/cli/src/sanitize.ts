import { redact, stripControls } from "@rewire/core";

/**
 * Model output is untrusted (#23): drop ANSI sequences and every C0/C1 control character except
 * the newline, then redact secrets (both from @rewire/core). Stripping runs first so a secret
 * split by an escape code is rejoined before the redaction sees it.
 */
export function sanitize(s: string): string {
  return redact(stripControls(s));
}

/** Sanitized, collapsed to one line, clipped to `max` characters. */
export function oneLine(s: string, max = 200): string {
  const flat = sanitize(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
