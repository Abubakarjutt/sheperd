import { SECRET } from "@rewire/core";

/** How many rounds of percent-decoding are tried (catches double and triple encoding). */
const DECODE_ROUNDS = 4;
const ESCAPES = /(?:%[0-9a-fA-F]{2})+/g;
const utf8 = new TextDecoder("utf-8");

/**
 * Decode every valid `%XX` run (as UTF-8, invalid bytes becoming U+FFFD) and leave malformed
 * escapes as written, so one stray `%` cannot stop the rest from being decoded.
 */
function percentDecode(s: string): string {
  return s.replace(ESCAPES, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return utf8.decode(bytes);
  });
}

const REFUSAL =
  "refused: it contains what looks like a secret (an API key or token), which is never sent";

/**
 * Why `text` (a search query or a URL about to be sent) must not leave this process, or
 * undefined. It is refused when its raw form, its form with `+` as a space, or any of up to four
 * rounds of tolerant percent-decoding contains anything `SECRET` matches, so a page cannot talk
 * a model into sending a key out in a query string, escaped or not.
 */
export function checkOutgoing(text: string): string | undefined {
  const forms = new Set<string>([text, text.replaceAll("+", " ")]);
  let current = text;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = percentDecode(current);
    if (next === current) break;
    forms.add(next);
    forms.add(next.replaceAll("+", " "));
    current = next;
  }
  // `search` ignores the global flag and lastIndex, so the shared regex is safe to use here.
  for (const f of forms) if (f.search(SECRET) >= 0) return REFUSAL;
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
  return checkOutgoing(u.href) ?? checkOutgoing(u.hostname.toUpperCase());
}
