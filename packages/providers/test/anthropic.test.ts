import { describe, expect, test } from "vitest";
import {
  AnthropicProvider,
  fromAnthropicResponse,
  mapAnthropicStopReason,
  toAnthropicParams,
} from "../src/anthropic.js";

describe("anthropic mapping", () => {
  test("request: system field, tool_use blocks, merged tool_results", () => {
    const p = toAnthropicParams({
      model: "m",
      system: "SYS",
      maxTokens: 50,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "thinking",
          toolCalls: [
            { id: "a", name: "t", arguments: { x: 1 } },
            { id: "b", name: "t", arguments: {} },
          ],
        },
        { role: "tool", content: "r1", toolCallId: "a" },
        { role: "tool", content: "r2", toolCallId: "b" },
        { role: "user", content: "next" },
      ],
    });
    expect(p.system).toBe("SYS");
    expect(p.max_tokens).toBe(50);
    expect(p.tools).toEqual([{ name: "t", description: "d", input_schema: { type: "object" } }]);
    expect(p.messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "a", name: "t", input: { x: 1 } },
          { type: "tool_use", id: "b", name: "t", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "r1" },
          { type: "tool_result", tool_use_id: "b", content: "r2" },
        ],
      },
      { role: "user", content: "next" },
    ]);
  });
  test("stop reasons", () => {
    expect(mapAnthropicStopReason("end_turn")).toBe("end");
    expect(mapAnthropicStopReason("stop_sequence")).toBe("end");
    expect(mapAnthropicStopReason("tool_use")).toBe("tool_use");
    expect(mapAnthropicStopReason("max_tokens")).toBe("length");
    expect(mapAnthropicStopReason("refusal")).toBe("error");
    expect(mapAnthropicStopReason(null)).toBe("error");
  });
  test("response mapping", () => {
    const r = fromAnthropicResponse({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "tool_use", id: "z", name: "t", input: { k: 1 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(r).toEqual({
      message: { text: "ab", toolCalls: [{ id: "z", name: "t", arguments: { k: 1 } }] },
      stopReason: "tool_use",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    expect(fromAnthropicResponse({ content: [], stop_reason: "end_turn" }).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("anthropic hardening", () => {
  test("tool_use without id or name is provider_bad_response", () => {
    for (const block of [
      { type: "tool_use", name: "t", input: {} },
      { type: "tool_use", id: "a", input: {} },
      { type: "tool_use", id: "", name: "t", input: {} },
    ]) {
      expect(() =>
        fromAnthropicResponse({ content: [block], stop_reason: "tool_use" }),
      ).toThrowError(expect.objectContaining({ code: "provider_bad_response" }));
    }
  });
  const KEY = "custom-proxy-key-12345";
  const mk = (err: unknown) =>
    new AnthropicProvider(KEY, {
      messages: {
        create: async () => {
          throw err;
        },
      },
    } as never);
  const req = { model: "m", system: "s", messages: [], maxTokens: 1 };
  test("real key is redacted, including nested error.error.message", async () => {
    const e1 = await mk(new Error(`bad auth ${KEY} here`))
      .chat(req)
      .catch((e) => e);
    expect(e1.code).toBe("provider_error");
    expect(e1.message).not.toContain(KEY);
    const nested = Object.assign(new Error("400"), { error: { error: { message: `x ${KEY}` } } });
    const e2 = await mk(nested)
      .chat(req)
      .catch((e) => e);
    expect(e2.message).not.toContain(KEY);
  });
  test("abort maps to provider_aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const e1 = await mk(new Error("boom"))
      .chat({ ...req, signal: ac.signal })
      .catch((e) => e);
    expect(e1.code).toBe("provider_aborted");
    const abortErr = Object.assign(new Error("Request was aborted."), {
      name: "APIUserAbortError",
    });
    const e2 = await mk(abortErr)
      .chat(req)
      .catch((e) => e);
    expect(e2.code).toBe("provider_aborted");
  });
});
