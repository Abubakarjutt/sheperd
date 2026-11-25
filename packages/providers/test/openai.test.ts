import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import {
  fromOpenAIResponse,
  mapOpenAIFinishReason,
  OpenAIProvider,
  toOpenAIParams,
} from "../src/openai.js";
import type { ChatRequest } from "../src/types.js";
import { type FetchReply, openaiChunks, openaiSSE, scriptedFetch } from "./sse.js";

describe("openai mapping", () => {
  test("request: system message, tool_calls, tool role", () => {
    const p = toOpenAIParams({
      model: "m",
      system: "SYS",
      maxTokens: 50,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "a", name: "t", arguments: { x: 1 } }],
        },
        { role: "tool", content: "r1", toolCallId: "a" },
      ],
    });
    expect(p.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: '{"x":1}' } }],
      },
      { role: "tool", tool_call_id: "a", content: "r1" },
    ]);
    expect(p.tools).toEqual([
      {
        type: "function",
        function: { name: "t", description: "d", parameters: { type: "object" } },
      },
    ]);
  });
  test("finish reasons", () => {
    expect(mapOpenAIFinishReason("stop")).toBe("end");
    expect(mapOpenAIFinishReason("tool_calls")).toBe("tool_use");
    expect(mapOpenAIFinishReason("length")).toBe("length");
    expect(mapOpenAIFinishReason("content_filter")).toBe("error");
    expect(mapOpenAIFinishReason(undefined)).toBe("error");
  });
  test("response mapping parses args", () => {
    const r = fromOpenAIResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "hey",
            tool_calls: [
              { id: "a", type: "function", function: { name: "t", arguments: '{"k":2}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    });
    expect(r).toEqual({
      message: { text: "hey", toolCalls: [{ id: "a", name: "t", arguments: { k: 2 } }] },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
  });
  test.each(["{not json", "[1]", "null", '"s"'])(
    "bad tool args %s -> provider_bad_tool_args",
    (args) => {
      expect(() =>
        fromOpenAIResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  { id: "a", type: "function", function: { name: "t", arguments: args } },
                ],
              },
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: "provider_bad_tool_args" }));
    },
  );
  test("empty arguments string is bad too (fail closed)", () => {
    expect(() =>
      fromOpenAIResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: "" } }],
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "provider_bad_tool_args" }));
  });
});

describe("openai hardening", () => {
  const KEY = "custom-proxy-key-12345";
  const mk = (err: unknown) =>
    new OpenAIProvider(KEY, {
      chat: {
        completions: {
          create: async () => {
            throw err;
          },
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
    const nested = Object.assign(new Error("400"), { error: { message: `x ${KEY}` } });
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
    const e2 = await mk(Object.assign(new Error("x"), { name: "AbortError" }))
      .chat(req)
      .catch((e) => e);
    expect(e2.code).toBe("provider_aborted");
  });
});

describe("openai streaming (onDelta)", () => {
  const req: ChatRequest = {
    model: "m",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 9,
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
  };
  const usage = { prompt_tokens: 11, completion_tokens: 7 };
  const mk = (reply: (body: Record<string, unknown>) => FetchReply) => {
    const f = scriptedFetch(reply);
    const client = new OpenAI({ apiKey: "sk-test", fetch: f.fetch, maxRetries: 0 });
    return { provider: new OpenAIProvider("sk-test", client), bodies: f.bodies };
  };
  const cases: {
    name: string;
    json: unknown;
    chunks: Parameters<typeof openaiChunks>[0];
    deltas: string[];
  }[] = [
    {
      name: "text only",
      json: {
        choices: [{ finish_reason: "stop", message: { content: "Hello world" } }],
        usage,
      },
      chunks: { text: ["Hel", "lo", " world"], finish: "stop", usage },
      deltas: ["Hel", "lo", " world"],
    },
    {
      name: "text plus a tool call",
      json: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "let me look",
              tool_calls: [
                { id: "a", type: "function", function: { name: "t", arguments: '{"k":[1,2]}' } },
              ],
            },
          },
        ],
        usage,
      },
      chunks: {
        text: ["let ", "me look"],
        toolCalls: [{ id: "a", name: "t", argPieces: ['{"k":', "[1,", "2]}"] }],
        finish: "tool_calls",
        usage,
      },
      deltas: ["let ", "me look"],
    },
    {
      name: "multiple tool calls",
      json: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "a", type: "function", function: { name: "t", arguments: '{"x":1}' } },
                { id: "b", type: "function", function: { name: "u", arguments: '{"y":"z"}' } },
              ],
            },
          },
        ],
        usage,
      },
      chunks: {
        toolCalls: [
          { id: "a", name: "t", argPieces: ['{"x"', ":1}"] },
          { id: "b", name: "u", argPieces: ['{"y":', '"z"}'] },
        ],
        finish: "tool_calls",
        usage,
      },
      deltas: [],
    },
  ];
  test.each(cases)("$name: streamed response equals the non-streamed one", async (c) => {
    const { provider, bodies } = mk((b) =>
      b.stream ? { sse: openaiSSE(openaiChunks(c.chunks)) } : { json: c.json },
    );
    const plain = await provider.chat(req);
    const deltas: string[] = [];
    const streamed = await provider.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(streamed).toEqual(plain);
    expect(deltas).toEqual(c.deltas);
    expect(bodies[0]).not.toHaveProperty("stream");
    expect(bodies[0]).not.toHaveProperty("stream_options");
    expect(bodies[1]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    const { stream: _s, stream_options: _o, ...rest } = bodies[1] as Record<string, unknown>;
    expect(rest).toEqual(bodies[0]);
  });
  test("without onDelta the request body is exactly toOpenAIParams", async () => {
    const { provider, bodies } = mk(() => ({ json: cases[0]?.json }));
    await provider.chat(req);
    expect(bodies[0]).toEqual(JSON.parse(JSON.stringify(toOpenAIParams(req))));
  });
  test("abort mid-stream throws provider_aborted", async () => {
    const ac = new AbortController();
    const { provider } = mk(() => ({
      sse: openaiSSE(openaiChunks({ text: ["part"], finish: "stop" }).slice(0, 2), false),
      hang: true,
    }));
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
  test("bad tool args in a stream fail closed like the non-streamed path", async () => {
    const { provider } = mk(() => ({
      sse: openaiSSE(
        openaiChunks({
          toolCalls: [{ id: "a", name: "t", argPieces: ['{"x":'] }],
          finish: "tool_calls",
        }),
      ),
    }));
    await expect(provider.chat({ ...req, onDelta: () => {} })).rejects.toMatchObject({
      code: "provider_bad_tool_args",
    });
  });
});
