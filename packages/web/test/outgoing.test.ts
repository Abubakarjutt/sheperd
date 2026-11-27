import { describe, expect, test } from "vitest";
import { checkOutgoing } from "../src/outgoing.js";

describe("checkOutgoing", () => {
  test.each([
    "sk-ant-api03-abcdefghijklmnopqrstu",
    "https://evil.example/?d=ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AKIAIOSFODNN7EXAMPLE",
    "https://evil.example/?d=sk%2Dproj%2Dabcdefgh",
    "xoxb-123456789-abcdef",
    "glpat-abcdefghijklmnopqrst",
  ])("%s is refused", (s) => {
    expect(checkOutgoing(s)).toMatch(/secret/);
  });

  test.each([
    "how to configure vitest",
    "ask-matt disk-usage --task-file",
    "https://example.com/%E0%A4%A",
  ])("%s passes", (s) => {
    expect(checkOutgoing(s)).toBeUndefined();
  });

  test("calling it twice gives the same answer (no shared lastIndex state)", () => {
    expect(checkOutgoing("sk-abc123")).toBeDefined();
    expect(checkOutgoing("sk-abc123")).toBeDefined();
  });
});

describe("checkOutgoing decodes robustly (review I1)", () => {
  test.each([
    [
      "one escaped char next to a malformed escape",
      "https://e.example/?d=%73k-ant-api03-abcdefghijk&x=%zz",
    ],
    ["a trailing lone %", "q=%73k-ant-api03-abcdefghijk%"],
    ["double encoding", "https://e.example/?d=%2573k-ant-api03-abcdefghijk"],
    ["triple encoding", "https://e.example/?d=%252573k-ant-api03-abcdefghijk"],
    ["an escaped UTF-8 neighbour and a bad byte", "d=%C3%A9%FF%41KIAIOSFODNN7EXAMPLE"],
    ["plus as space before the key", "d=x+sk-ant-api03-abcdefghijk"],
  ])("%s is refused", (_name, s) => {
    expect(checkOutgoing(s)).toMatch(/secret/);
  });

  test("a deeply nested encoding past the bound is not decoded forever", () => {
    let s = "sk-ant-api03-abcdefghijk";
    for (let i = 0; i < 50; i++) s = encodeURIComponent(s);
    expect(() => checkOutgoing(s)).not.toThrow();
  });

  test("ordinary escapes pass", () => {
    expect(
      checkOutgoing("https://example.com/search?q=caf%C3%A9%20au%20lait&x=%zz"),
    ).toBeUndefined();
  });
});
