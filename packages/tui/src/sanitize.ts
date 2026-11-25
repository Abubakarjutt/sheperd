const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;

/** Introducers of control strings (OSC, DCS, SOS, PM, APC), as the byte after ESC. */
const STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

/** Bidi and invisible format characters: the same set as core's `stripControls`. */
function isInvisible(c: number): boolean {
  return (
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
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
 * Index just past a control string whose body starts at `i`: ended by BEL, ST (ESC \), CAN or
 * SUB, or abandoned at a following ESC (as VT parsers do; the ESC then starts a new sequence).
 * An otherwise unterminated string swallows the rest of the text. Safety does not depend on
 * where a string ends: only allow-listed characters are ever appended.
 */
function skipString(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === BEL || c === 0x9c || c === CAN || c === SUB) return i + 1;
    if (c === ESC) return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i; // ST, or a new sequence
  }
  return text.length;
}

/**
 * Makes untrusted text inert for a terminal. Single linear pass (no regex, no backtracking).
 * Strips CSI, OSC, DCS/SOS/PM/APC strings and other ESC sequences; C0 controls except `\n` and
 * `\t` (NUL included); DEL; C1 (U+0080 to U+009F). `\r\n` becomes `\n` and a lone `\r` is
 * dropped (it would otherwise let text overwrite the line it follows). Bidi and invisible
 * format characters (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF) are dropped too.
 */
export function sanitize(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) i = skipCsi(text, i + 2);
      else if (STRING_INTRODUCERS.has(next)) i = skipString(text, i + 2);
      else if (next >= 0x20 && next <= 0x2f) {
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
      i = skipString(text, i + 1);
      continue;
    }
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) out += "\n";
      i += 1 + (text.charCodeAt(i + 1) === 0x0a ? 1 : 0);
      continue;
    }
    const allowed =
      c === 0x0a ||
      c === 0x09 ||
      (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f) && !isInvisible(c));
    if (allowed) out += text[i];
    i++;
  }
  return out;
}
