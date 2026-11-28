import type { AgentTool } from "@rewire/loop";
import type { ChatMessage } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import { clearedLabel, clearedStub, clearToFit } from "../src/in-turn.js";

const KEY = `sk-ant-api03-${"D".repeat(40)}`;

describe("clearedLabel", () => {
  test("uses the tool's summary hook, never the arguments", () => {
    const tool = {
      spec: { name: "web_fetch" },
      summary: () => "example.com/docs",
    } as never as AgentTool;
    expect(clearedLabel("web_fetch", { url: `https://example.com/docs?k=${KEY}` }, tool)).toBe(
      "web_fetch example.com/docs",
    );
  });

  test("picks named fields of the chat tools, redacted; an unknown tool gets its name only", () => {
    expect(clearedLabel("read", { path: "src/a.ts", offset: 10, limit: 50 }, undefined)).toBe(
      "read src/a.ts offset=10 limit=50",
    );
    expect(clearedLabel("bash", { command: `curl -H "x: ${KEY}"\n  x` }, undefined)).toBe(
      'bash curl -H "x: [redacted]" x',
    );
    expect(clearedLabel("mystery", { secret: KEY }, undefined)).toBe("mystery");
  });

  test("a throwing hook gives a placeholder; the label is capped", () => {
    const bad = {
      summary: () => {
        throw new Error("x");
      },
    } as never as AgentTool;
    expect(clearedLabel("t", {}, bad)).toBe("t [summary unavailable]");
    expect(Array.from(clearedLabel("read", { path: "a".repeat(500) }, undefined))).toHaveLength(
      120,
    );
  });
});

describe("clearToFit", () => {
  const turn = (sizes: number[]): ChatMessage[] => [
    { role: "user", content: "earlier" },
    { role: "user", content: "now" },
    ...sizes.flatMap((n, i): ChatMessage[] => [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read", arguments: { path: `f${i}` } }],
      },
      { role: "tool", content: "y".repeat(n), toolCallId: `c${i}` },
    ]),
  ];
  const chars = (m: ChatMessage[]): number => m.reduce((n, x) => n + x.content.length, 0);
  const base = { from: 1, estimate: chars, label: (c: { name: string }) => c.name };

  test("clears oldest first, keeps the newest `keep`, leaves the input untouched", () => {
    const msgs = turn([1000, 1000, 1000, 1000]);
    const copy = structuredClone(msgs);
    const cleared = new Map<string, string>();
    const r = clearToFit(msgs, { ...base, cleared, max: 2500, keep: 2 });
    expect(msgs).toEqual(copy);
    expect([...cleared.keys()]).toEqual(["c0", "c1"]);
    expect(r.newly).toBe(2);
    expect(r.messages[3]?.content).toBe(clearedStub("read", 1000));
    expect(r.messages[9]?.content).toHaveLength(1000);
    // Under the target after two: the rest stay whole.
    expect(r.estimate).toBeLessThanOrEqual(2500);
  });

  test("a result no longer than its stub is not cleared; the cleared map is reapplied as is", () => {
    const msgs = turn([50, 1000, 1000, 1000]);
    const cleared = new Map<string, string>();
    clearToFit(msgs, { ...base, cleared, max: 2500, keep: 2 });
    expect([...cleared.keys()]).toEqual(["c1"]);
    const again = clearToFit(msgs, { ...base, cleared, max: 1_000_000, keep: 2 });
    expect(again.newly).toBe(0);
    expect(again.messages[5]?.content).toBe(cleared.get("c1"));
  });
});
