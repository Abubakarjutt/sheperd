const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;

/** Introducers of control strings (OSC, DCS, SOS, PM, APC), as the byte after ESC. */
const STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

/**
 * Characters a terminal renders as nothing (or as a line break it does not draw), which could hide
 * text from a reader: the Unicode Default_Ignorable_Code_Point set (soft hyphen, combining
 * grapheme joiner, Arabic letter mark, Hangul fillers, Khmer vowels, Mongolian selectors,
 * zero-width and bidi marks, word joiner and invisible operators, variation selectors, BOM,
 * Hangul halfwidth filler, U+FFF0-FFF8, shorthand format controls, musical format controls,
 * tags and the variation selectors supplement), plus U+2028/U+2029.
 */
function isInvisible(c: number): boolean {
  if (c < 0xad) return false;
  return (
    c === 0xad ||
    c === 0x34f ||
    c === 0x61c ||
    c === 0x115f ||
    c === 0x1160 ||
    c === 0x17b4 ||
    c === 0x17b5 ||
    (c >= 0x180b && c <= 0x180f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0x3164 ||
    (c >= 0xfe00 && c <= 0xfe0f) ||
    c === 0xfeff ||
    c === 0xffa0 ||
    (c >= 0xfff0 && c <= 0xfff8) ||
    (c >= 0x1bca0 && c <= 0x1bca3) ||
    (c >= 0x1d173 && c <= 0x1d17a) ||
    (c >= 0xe0000 && c <= 0xe0fff)
  );
}

/** Index just past a CSI sequence whose parameter bytes start at `i`. */
function skipCsi(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c >= 0x30 && c <= 0x3f) i++;
    else if (c >= 0x20 && c <= 0x2f) i++;
    else break;
  }
  const final = text.charCodeAt(i);
  // A final byte ends the sequence; anything else aborts it and is left to the main loop.
  return final >= 0x40 && final <= 0x7e ? i + 1 : i;
}

/**
 * Index just past a control string whose body starts at `start`: ended by BEL, ST (ESC \ or
 * U+009C), CAN or SUB, or abandoned at a following ESC (as VT parsers do; the ESC then starts a
 * new sequence). Returns -1 when the string is unterminated, i.e. a newline, another C1 control
 * or the end of the text comes first: the caller then drops only the introducer and keeps the
 * text (N2; mojibake such as `â€\u009d` must not swallow the rest of a report). Safety does not
 * depend on where a string ends: only allow-listed characters are ever appended. Linear overall:
 * a failed scan stops before the next introducer, so no character is scanned twice by it.
 */
function skipString(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BEL || c === 0x9c || c === CAN || c === SUB) return i + 1;
    if (c === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i; // ST, or a new sequence
    if (c === 0x0a || (c >= 0x80 && c <= 0x9f)) return -1;
  }
  return -1;
}

/**
 * The one terminal sanitizer: makes untrusted text inert for a terminal, a file people `cat`,
 * or `git log`. Single linear pass (no regex, no backtracking).
 * Strips CSI, OSC, DCS/SOS/PM/APC strings and other ESC sequences; C0 controls except `\n` and
 * `\t` (NUL included); DEL; C1 (U+0080 to U+009F). `\r\n` becomes `\n` and a lone `\r` is
 * dropped (it would otherwise let text overwrite the line it follows). Default-ignorable
 * (invisible) code points and U+2028/2029 are dropped too (see `isInvisible`). A control string
 * with no terminator before a newline or the end loses only its introducer (N2).
 */
export function sanitizeTerminal(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) i = skipCsi(text, i + 2);
      else if (STRING_INTRODUCERS.has(next)) {
        const end = skipString(text, i + 2);
        i = end < 0 ? i + 2 : end;
      } else if (next >= 0x20 && next <= 0x2f) {
        // ESC + intermediates + final byte (charset selection and similar).
        let j = i + 1;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        const fin = text.charCodeAt(j);
        i = fin >= 0x30 && fin <= 0x7e ? j + 1 : j;
      } else if (next >= 0x30 && next <= 0x7e) i += 2;
      else i += 1; // lone ESC
      continue;
    }
    if (c === 0x9b) {
      i = skipCsi(text, i + 1);
      continue;
    }
    if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
      const end = skipString(text, i + 1);
      i = end < 0 ? i + 1 : end;
      continue;
    }
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) out += "\n";
      i += 1 + (text.charCodeAt(i + 1) === 0x0a ? 1 : 0);
      continue;
    }
    // By code point, so astral characters (tags, U+1D173...) are judged whole.
    const cp = text.codePointAt(i) ?? c;
    const size = cp > 0xffff ? 2 : 1;
    const allowed =
      cp === 0x0a ||
      cp === 0x09 ||
      (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f) && !isInvisible(cp));
    if (allowed) out += text.slice(i, i + size);
    i += size;
  }
  return out;
}
