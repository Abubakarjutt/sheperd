import { SECRET } from "@rewire/core";

/**
 * Rounds of percent-decoding, to a fixpoint. Each round that changes the text shortens it, so
 * the cap only bounds pathological inputs.
 */
const DECODE_ROUNDS = 16;
const ESCAPES = /(?:%[0-9a-fA-F]{2})+/g;
const UNICODE_ESCAPES = /%u([0-9a-fA-F]{4})/g;

/**
 * The outgoing secret pattern: `SECRET` plus the main key shapes WITHOUT its token-start guard.
 * That guard keeps display redaction from mangling words like "task-file"; on the way out it
 * would let `x<key>` through (the receiver just drops the letter). The `sk-` shape allows up to
 * eight hyphen-separated segments (prefixes like `ant-api03-`, `proj-`, `svcacct-`, and the
 * hyphens a base64url key body itself contains) and then needs a run of 20+ characters with no
 * hyphen, which keys have and hyphenated words ("ask-questions-on-stack-overflow") do not.
 */
const OUTGOING = new RegExp(
  [
    SECRET.source,
    "sk-(?:[A-Za-z0-9_]+-){0,8}[A-Za-z0-9_]{20,}",
    "ghp_[A-Za-z0-9]{30,}",
    "AKIA[0-9A-Z]{16}",
  ].join("|"),
);
/** Mixed-case key shapes, checked case-insensitively on host names (DNS folds case). */
const HOST_ONLY = /aiza[0-9a-z_-]{30,}/i;
const utf8 = new TextDecoder("utf-8");

/**
 * Decode every valid `%XX` run (as UTF-8, invalid bytes becoming U+FFFD) and leave malformed
 * escapes as written, so one stray `%` cannot stop the rest from being decoded.
 */
function percentDecode(s: string): string {
  return s
    .replace(ESCAPES, (run) => {
      const bytes = new Uint8Array(run.length / 3);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
      }
      return utf8.decode(bytes);
    })
    .replace(UNICODE_ESCAPES, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Controls (a key split by `%00`, a tab) removed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

const REFUSAL =
  "refused: it contains what looks like a secret (an API key or token), which is never sent";

/**
 * Why `text` (a search query or a URL about to be sent) must not leave this process, or
 * undefined. It is refused when any form of it matches the outgoing pattern (`SECRET`, plus key
 * shapes with no token-start guard): raw, every round of tolerant percent-decoding (`%XX` and
 * `%uXXXX`, to a fixpoint), each NFKC-folded, with `+` as a space, and with controls removed. So
 * a page cannot talk a model into sending a key out in a query string, escaped or not.
 */
export function checkOutgoing(text: string): string | undefined {
  const decoded = [text];
  let current = text;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = percentDecode(current);
    if (next === current) break;
    decoded.push(next);
    current = next;
  }
  const forms = new Set<string>();
  for (const d of decoded) {
    for (const f of [d, d.normalize("NFKC")]) {
      forms.add(f);
      forms.add(f.replaceAll("+", " "));
      forms.add(f.replace(CONTROLS, ""));
    }
  }
  for (const f of forms) if (OUTGOING.test(f)) return REFUSAL;
  return undefined;
}

/**
 * `checkOutgoing` for a URL: the raw string as given (before `URL` lowercases the host), the
 * normalised href, and the host upper-cased. DNS is case-insensitive, so a key whose pattern is
 * upper-case (`AKIA…`) still reaches the attacker's nameserver when written in lower case.
 */
export function checkOutgoingUrl(raw: string): string | undefined {
  const direct = checkOutgoing(raw);
  if (direct !== undefined) return direct;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  return (
    checkOutgoing(u.href) ??
    checkOutgoing(u.hostname.toUpperCase()) ??
    (HOST_ONLY.test(u.hostname) ? REFUSAL : undefined)
  );
}
