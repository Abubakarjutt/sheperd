import { describe, expect, test } from "vitest";
import { redact, SECRET, stripControls } from "../src/index.js";

// Assembled at runtime so no literal token sits in the source (secret scanners).
const tok = (prefix: string, body = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"): string => `${prefix}${body}`;

describe("redact (I9: one implementation, broadened)", () => {
  test.each([
    ["OpenAI/Anthropic sk-", tok("sk-")],
    ["sk-ant-", tok("sk-ant-api03-")],
    ["GitHub classic ghp_", tok("ghp_")],
    ["GitHub OAuth gho_", tok("gho_")],
    ["GitHub server ghs_", tok("ghs_")],
    ["GitHub user ghu_", tok("ghu_")],
    ["GitHub fine-grained", tok("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")],
    ["AWS key id", tok("AKIA", "IOSFODNN7EXAMPLE")],
    ["Slack bot", tok("xoxb-", "123456789012-123456789012-abcdefghijklmnop")],
    ["Slack app", tok("xoxa-", "2-123456789012-abcdef")],
    ["Slack user", tok("xoxp-", "123-456-789-abc")],
    ["Google API key", tok("AIza", "SyA1234567890abcdefghijklmnopqrstu")],
    ["GitLab PAT", tok("glpat-", "abcdefghij1234567890")],
  ])("%s", (_name, secret) => {
    const out = redact(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
    expect(out.startsWith("before ")).toBe(true);
    expect(out.endsWith(" after")).toBe(true);
  });

  test("PEM private-key blocks, closed and truncated", () => {
    const begin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    const end = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
    const block = `${begin}\nMIIEowIBAAKCAQEA\nabcdef\n${end}`;
    const out = redact(`key:\n${block}\ntail`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).toContain("tail");
    const cut = redact(
      `x ${["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")}\nb3BlbnNzaC1rZXk`,
    );
    expect(cut).not.toContain("b3BlbnNzaC1rZXk");
  });

  test("ordinary text is untouched", () => {
    const s = "AIzaWord is short; github_pat is a word; xoxo hugs";
    expect(redact(s)).toBe(s);
  });

  test("SECRET is a global pattern that matches the same tokens", () => {
    expect(SECRET.global).toBe(true);
    expect(`a ${tok("ghs_")} b`.replace(SECRET, "[x]")).toBe("a [x] b");
  });
});

describe("stripControls (M1)", () => {
  test("drops ANSI, C0/C1 controls and bidi/invisible marks; keeps newlines", () => {
    const s =
      "a\u001b[31mred\u001b[0m\u0007 b\u202e c\u001b]8;;http://x\u0007link\u001b]8;;\u0007\nd\u009b";
    expect(stripControls(s)).toBe("ared b clink\nd");
  });
  test("a secret split by an escape is rejoined before redaction", () => {
    const secret = tok("ghp_");
    const split = `${secret.slice(0, 6)}\u001b[0m${secret.slice(6)}`;
    expect(redact(stripControls(split))).not.toContain(secret.slice(6));
  });
});
