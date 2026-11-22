// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching control characters is the job
import { redact } from "@rewire/reviewers";

// The control characters are the point of these patterns, not an accident.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_PAIR = /\u001b[@-Z\\-_]?/g;
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * Model output is untrusted (#23): drop ANSI sequences and every C0/C1 control character except
 * the newline, then redact secrets. Stripping runs first so a secret split by an escape code is
 * rejoined before the redaction sees it.
 */
export function sanitize(s: string): string {
  return redact(s.replace(OSC, "").replace(CSI, "").replace(ESC_PAIR, "").replace(CONTROLS, ""));
}

/** Sanitized, collapsed to one line, clipped to `max` characters. */
export function oneLine(s: string, max = 200): string {
  const flat = sanitize(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
