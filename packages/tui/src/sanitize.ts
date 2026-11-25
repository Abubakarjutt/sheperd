/**
 * The TUI's name for `@rewire/core`'s single terminal sanitizer (strips ANSI/OSC/DCS strings,
 * C0/C1 controls except newline and tab, CR, and bidi/invisible format characters).
 */
export { sanitizeTerminal as sanitize } from "@rewire/core";
