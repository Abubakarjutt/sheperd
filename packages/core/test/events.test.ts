import { describe, expect, test } from "vitest";
import { RunEvent } from "../src/index.js";

const base = { runId: "r1", ts: "2026-01-01T00:00:00.000Z", stage: "spec" };
const checkpoint = (decision: unknown, kind: string = "contract") => ({
  ...base,
  type: "checkpoint",
  kind,
  decision,
});

describe("checkpoint event", () => {
  test.each([
    { action: "approve" },
    { action: "revise", note: "tighten criterion 2" },
    { action: "stop" },
    { action: "stop", note: "wrong direction" },
  ])("accepts decision %j and round-trips it", (decision) => {
    for (const kind of ["contract", "tests", "commit"]) {
      const input = checkpoint(decision, kind);
      const r = RunEvent.safeParse(input);
      expect(r.success).toBe(true);
      expect(r.data).toEqual(input);
    }
  });

  test("rejects revise with an empty note", () => {
    expect(RunEvent.safeParse(checkpoint({ action: "revise", note: "" })).success).toBe(false);
  });

  test("revise note length boundary is 2000", () => {
    expect(
      RunEvent.safeParse(checkpoint({ action: "revise", note: "x".repeat(2000) })).success,
    ).toBe(true);
    expect(
      RunEvent.safeParse(checkpoint({ action: "revise", note: "x".repeat(2001) })).success,
    ).toBe(false);
  });

  test("stop with an empty note is rejected", () => {
    expect(RunEvent.safeParse(checkpoint({ action: "stop", note: "" })).success).toBe(false);
  });

  test("rejects an unknown kind", () => {
    expect(RunEvent.safeParse(checkpoint({ action: "approve" }, "deploy")).success).toBe(false);
  });
});

describe("skill_loaded event", () => {
  const ev = (sha256: string) => ({
    ...base,
    type: "skill_loaded",
    name: "tdd",
    source: "user",
    sha256,
  });
  test("accepts a 64-hex sha256 and round-trips it", () => {
    const input = ev("a1".repeat(32));
    const r = RunEvent.safeParse(input);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(input);
  });
  test.each([
    ["63 hex", "a".repeat(63)],
    ["65 hex", "a".repeat(65)],
    ["uppercase hex", "A".repeat(64)],
  ])("rejects %s", (_n, sha) => {
    expect(RunEvent.safeParse(ev(sha)).success).toBe(false);
  });
});
