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

describe("web_request event", () => {
  const web = { ...base, type: "web_request" };
  test("accepts a search and a fetch record, success or failure", () => {
    for (const e of [
      {
        ...web,
        tool: "web_search",
        backend: "ollama",
        query: "vitest config",
        ok: true,
        bytes: 120,
        results: 3,
      },
      { ...web, tool: "web_fetch", url: "example.com/docs", status: 200, ok: true, bytes: 4096 },
      {
        ...web,
        tool: "web_fetch",
        url: "example.com/x",
        ok: false,
        bytes: 0,
        error: "refused by policy",
      },
    ]) {
      const r = RunEvent.safeParse(e);
      expect(r.success, JSON.stringify(r.error)).toBe(true);
      expect(r.data).toEqual(e);
    }
  });
  test("rejects an unknown tool and a negative byte count", () => {
    expect(RunEvent.safeParse({ ...web, tool: "bash", ok: true, bytes: 0 }).success).toBe(false);
    expect(
      RunEvent.safeParse({ ...web, tool: "web_fetch", url: "a/b", ok: true, bytes: -1 }).success,
    ).toBe(false);
  });
});
