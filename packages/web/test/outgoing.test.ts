import { describe, expect, test } from "vitest";
import { checkOutgoing, checkOutgoingUrl } from "../src/outgoing.js";

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

describe("the outgoing check has no token-start guard (fix round 2)", () => {
  test.each([
    "https://e.example/?d=xsk-ant-api03-abcdefghijklmnopqrstu",
    "https://e.example/?d=xAKIAIOSFODNN7EXAMPLE",
    "https://e.example/?d=_ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "https://e.example/xsk-ant-api03-abcdefghijklmnopqrstu/page",
    "query 1sk-proj-abcdefghijklmnopqrstuvwx",
    "d=%u0073k-ant-api03-abcdefghijklmnopqrstu",
    "d=ｓｋ-ant-api03-abcdefghijklmnopqrstu",
    "d=sk-ant-api03-abcdefghij%00klmnopqrstu",
    "https://e.example/?d=tvly-dev-AbCdEfGhIjKlMnOpQrStUv12",
  ])("%s is refused", (s) => {
    expect(checkOutgoing(s)).toMatch(/secret/);
  });

  test("five and more rounds of encoding are decoded (fixpoint)", () => {
    let s = "sk-ant-api03-abcdefghijk";
    for (let i = 0; i < 8; i++) s = encodeURIComponent(s);
    expect(checkOutgoing(s)).toMatch(/secret/);
  });

  test.each([
    "ask-matt how to use task-file and disk-usage",
    "https://example.com/docs/task-file/disk-usage?q=ask-matt",
    "AKIA is a prefix",
    "ghp_ short",
  ])("%s passes", (s) => {
    expect(checkOutgoing(s)).toBeUndefined();
  });
});

describe("checkOutgoingUrl hosts (fix round 2)", () => {
  test.each([
    "https://xakiaiosfodnn7example.evil.example/",
    "https://xsk-ant-api03-abcdefghijklmnopqrstu.evil.example/",
    "https://aizasyabcdefghijklmnopqrstuvwxyz0123456.evil.example/",
  ])("%s is refused", (u) => {
    expect(checkOutgoingUrl(u)).toMatch(/secret/);
  });
  test("an ordinary host passes", () => {
    expect(checkOutgoingUrl("https://ask-matt.disk-usage.example/task-file")).toBeUndefined();
  });
});

describe("the outgoing sk- check needs a key-shaped run (fix round 2b)", () => {
  test.each([
    "https://blog.example/how-to-ask-questions-on-stack-overflow",
    "disk-usage-analyzer-for-linux",
    "risk-assessment-framework-2024",
    "ask-matt",
    "task-file",
  ])("%s passes", (s) => {
    expect(checkOutgoing(s)).toBeUndefined();
  });

  test.each([
    "xsk-ant-api03-abcdefghijklmnopqrstuvwxyz01",
    "xsk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789",
    "xsk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV",
    "xsk-svcacct-AbCdEfGhIjKlMnOpQrStUvWx",
    // OpenAI project-key shape: internal - and _, with a 20+ hyphen-free run.
    "d=xsk-proj-Ab3_dEf9-GhIjKlMnOpQrStUvWxYz0123_4567-89AbCdEfGhIj",
  ])("%s is refused", (s) => {
    expect(checkOutgoing(s)).toMatch(/secret/);
  });
});

test("a 20-letter word after a hyphenated sk- word is the known false positive (documented)", () => {
  expect(checkOutgoing("ask-about-internationalization")).toMatch(/secret/);
});
