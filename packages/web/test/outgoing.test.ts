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
