import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitize.js";

describe("sanitize", () => {
  it("strips OSC 52 clipboard writes and CSI sequences", () => {
    expect(sanitize("a\x1b]52;c;ZXZpbA==\x07b\x1b[2Jc")).toBe("abc");
  });
  it("strips OSC terminated by ST, and DCS/SOS/PM/APC strings", () => {
    expect(sanitize("a\x1b]0;title\x1b\\b")).toBe("ab");
    for (const intro of ["P", "X", "^", "_"]) {
      expect(sanitize(`a\x1b${intro}payload\x1b\\b`)).toBe("ab");
    }
  });
  it("strips lone ESC, other ESC sequences, NUL, DEL, C0 and C1 but keeps newline and tab", () => {
    expect(sanitize("a\x1bb")).toBe("a");
    expect(sanitize("x\x1b")).toBe("x");
    expect(sanitize("a\x1bcb\x1b(0c")).toBe("abc");
    expect(sanitize("a\x00\x01\x07\x08\x7f\x85\x9bz\n\tb")).toBe("a\n\tb");
    expect(sanitize("a\u009b31mb\u009d52;c;x\u009cc")).toBe("abc");
  });
  it("turns CRLF into LF and drops a lone CR", () => {
    expect(sanitize("a\r\nb\rc")).toBe("a\nbc");
  });
  it("keeps ordinary unicode text", () => {
    expect(sanitize("héllo ● ✗ 日本語 🙂")).toBe("héllo ● ✗ 日本語 🙂");
  });
  it("is linear on a long adversarial unterminated OSC and on repeated introducers", () => {
    const n = 2_000_000;
    const t0 = performance.now();
    expect(sanitize(`ok\x1b]52;c;${"\x1b".repeat(n)}`)).toBe("ok");
    expect(sanitize(`ok\x1b]${"x".repeat(n)}`)).toBe("ok");
    expect(sanitize(`${"\x1b[".repeat(n / 2)}z`)).toBe(""); // the final "z" closes the last CSI
    expect(sanitize("\x1b[;".repeat(n / 3))).toBe("");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
