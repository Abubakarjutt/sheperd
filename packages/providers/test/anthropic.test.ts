import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import {
  AnthropicProvider,
  fromAnthropicResponse,
  mapAnthropicStopReason,
  toAnthropicParams,
} from "../src/anthropic.js";
import type { ChatRequest } from "../src/types.js";
import { anthropicEvents, anthropicSSE, type FetchReply, scriptedFetch } from "./sse.js";

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

describe("anthropic streaming (onDelta)", () => {
  const req: ChatRequest = {
    model: "m",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 9,
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
  };
  const usage = { input_tokens: 11, output_tokens: 7 };
  const mk = (reply: (body: Record<string, unknown>) => FetchReply) => {
    const f = scriptedFetch(reply);
    const client = new Anthropic({ apiKey: "sk-ant-test", fetch: f.fetch, maxRetries: 0 });
    return { provider: new AnthropicProvider("sk-ant-test", client), bodies: f.bodies };
  };
  const msg = (content: unknown[], stop_reason: string) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content,
    stop_reason,
    stop_sequence: null,
    usage,
  });
  const cases: {
    name: string;
    json: unknown;
    events: Parameters<typeof anthropicEvents>[0];
    deltas: string[];
  }[] = [
    {
      name: "text only",
      json: msg([{ type: "text", text: "Hello world" }], "end_turn"),
      events: {
        blocks: [{ type: "text", pieces: ["Hel", "lo", " world"] }],
        stop: "end_turn",
        usage,
      },
      deltas: ["Hel", "lo", " world"],
    },
    {
      name: "text plus a tool call",
      json: msg(
        [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "a", name: "t", input: { k: [1, 2] } },
        ],
        "tool_use",
      ),
      events: {
        blocks: [
          { type: "text", pieces: ["let ", "me look"] },
          { type: "tool_use", id: "a", name: "t", argPieces: ['{"k":', "[1,", "2]}"] },
        ],
        stop: "tool_use",
        usage,
      },
      deltas: ["let ", "me look"],
    },
    {
      name: "multiple tool calls",
      json: msg(
        [
          { type: "tool_use", id: "a", name: "t", input: { x: 1 } },
          { type: "tool_use", id: "b", name: "u", input: { y: "z" } },
        ],
        "tool_use",
      ),
      events: {
        blocks: [
          { type: "tool_use", id: "a", name: "t", argPieces: ['{"x"', ":1}"] },
          { type: "tool_use", id: "b", name: "u", argPieces: ['{"y":', '"z"}'] },
        ],
        stop: "tool_use",
        usage,
      },
      deltas: [],
    },
  ];
  test.each(cases)("$name: streamed response equals the non-streamed one", async (c) => {
    const { provider, bodies } = mk((b) =>
      b.stream ? { sse: anthropicSSE(anthropicEvents(c.events)) } : { json: c.json },
    );
    const plain = await provider.chat(req);
    const deltas: string[] = [];
    const streamed = await provider.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(streamed).toEqual(plain);
    expect(deltas).toEqual(c.deltas);
    expect(bodies[0]).not.toHaveProperty("stream");
    expect(bodies[1]).toMatchObject({ stream: true });
    const { stream: _s, ...rest } = bodies[1] as Record<string, unknown>;
    expect(rest).toEqual(bodies[0]);
  });
  test("without onDelta the request body is exactly toAnthropicParams", async () => {
    const { provider, bodies } = mk(() => ({ json: cases[0]?.json }));
    await provider.chat(req);
    expect(bodies[0]).toEqual(JSON.parse(JSON.stringify(toAnthropicParams(req))));
  });
  test("abort mid-stream throws provider_aborted", async () => {
    const ac = new AbortController();
    const events = anthropicEvents({
      blocks: [{ type: "text", pieces: ["part"] }],
      stop: "end_turn",
      usage,
    }).slice(0, 3);
    const { provider } = mk(() => ({ sse: anthropicSSE(events), hang: true }));
    const deltas: string[] = [];
    const err = await provider
      .chat({
        ...req,
        signal: ac.signal,
        onDelta: (d) => {
          deltas.push(d);
          ac.abort();
        },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "provider_aborted" });
    expect(deltas).toEqual(["part"]);
  });
});
