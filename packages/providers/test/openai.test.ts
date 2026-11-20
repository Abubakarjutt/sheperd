import { describe, expect, test } from "vitest";
import { fromOpenAIResponse, mapOpenAIFinishReason, toOpenAIParams } from "../src/openai.js";

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
    "bad tool args %s -> provider_bad_response",
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
      ).toThrowError(expect.objectContaining({ code: "provider_bad_response" }));
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
    ).toThrowError(expect.objectContaining({ code: "provider_bad_response" }));
  });
});
