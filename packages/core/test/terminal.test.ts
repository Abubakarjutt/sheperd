import { describe, expect, it } from "vitest";
import { sanitizeTerminal, stripControls } from "../src/index.js";

describe("sanitizeTerminal (the one terminal sanitizer)", () => {
  it("strips OSC 52, CSI, DCS/SOS/PM/APC strings and C1 string bodies", () => {
    expect(sanitizeTerminal("a\x1b]52;c;ZXZpbA==\x07b\x1b[2Jc")).toBe("abc");
    for (const intro of ["P", "X", "^", "_"]) {
      expect(sanitizeTerminal(`a\x1b${intro}payload\x1b\\b`)).toBe("ab");
    }
    expect(sanitizeTerminal("a\u009b31mb\u009d52;c;x\u009cc")).toBe("abc");
  });
  it("keeps newline and tab, drops other controls, CR, bidi and invisibles", () => {
    expect(sanitizeTerminal("a\x00\x07\x7f\x85z\n\tb\r\nc\rd")).toBe("az\n\tb\ncd");
    expect(sanitizeTerminal("a‮b⁦c​d﻿e")).toBe("abcde");
  });
  it("is linear on an adversarial unterminated OSC", () => {
    const t0 = performance.now();
    expect(sanitizeTerminal(`ok\x1b]${"x".repeat(2_000_000)}`)).toBe("ok");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("stripControls is sanitizeTerminal without tabs", () => {
  it("removes a whole unterminated OSC body and ESC + lowercase final, which the regexes kept", () => {
    expect(stripControls("a\x1b]0;hidden task\x07b")).toBe("ab");
    expect(stripControls("a\u009dhidden\u009cb")).toBe("ab");
    expect(stripControls("a\x1bcb")).toBe("ab");
    expect(stripControls("a\tb")).toBe("ab");
  });
});
