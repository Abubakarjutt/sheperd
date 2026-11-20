import { RewireError } from "@rewire/core";
import OpenAI from "openai";
import { providerError } from "./errors.js";
import type { ChatRequest, ChatResponse, Provider, StopReason, ToolCall } from "./types.js";

type OMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIParamOptions = {
  /**
   * Which request field carries the output cap. OpenAI uses `max_completion_tokens`; Ollama's
   * OpenAI-compatible endpoint only lists `max_tokens` as supported
   * (https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx).
   */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

export function toOpenAIParams(req: ChatRequest, opts: OpenAIParamOptions = {}) {
  const messages: OMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") {
      if (!m.toolCallId) {
        throw new RewireError("provider_bad_request", "tool message is missing toolCallId");
      }
      messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant") {
      const msg: OMessage = { role: "assistant", content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }));
      }
      messages.push(msg);
    } else {
      messages.push({ role: "user", content: m.content });
    }
  }
  const params: {
    model: string;
    max_completion_tokens?: number;
    max_tokens?: number;
    messages: OMessage[];
    tools?: {
      type: "function";
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }[];
  } = { model: req.model, messages };
  if (opts.maxTokensField === "max_tokens") params.max_tokens = req.maxTokens;
  else params.max_completion_tokens = req.maxTokens;
  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return params;
}

export function mapOpenAIFinishReason(r: string | null | undefined): StopReason {
  switch (r) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "length";
    default:
      return "error";
  }
}

type OResponse = {
  choices: ReadonlyArray<{
    finish_reason?: string | null;
    message: {
      content?: string | null;
      tool_calls?: ReadonlyArray<{
        id: string;
        type?: string;
        function?: { name: string; arguments: string };
      }> | null;
    };
  }>;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
};

function parseArgs(raw: unknown, name: string, provider: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : "");
  } catch {
    throw new RewireError(
      "provider_bad_response",
      `${provider} tool call "${name}" has invalid JSON arguments`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RewireError(
      "provider_bad_response",
      `${provider} tool call "${name}" arguments are not an object`,
    );
  }
  return parsed as Record<string, unknown>;
}

export function fromOpenAIResponse(resp: OResponse, provider = "openai"): ChatResponse {
  const choice = resp.choices[0];
  if (!choice)
    throw new RewireError("provider_bad_response", `${provider} response has no choices`);
  const toolCalls: ToolCall[] = [];
  for (const c of choice.message.tool_calls ?? []) {
    if (!c.function) {
      throw new RewireError("provider_bad_response", `${provider} tool call has no function`);
    }
    toolCalls.push({
      id: c.id,
      name: c.function.name,
      arguments: parseArgs(c.function.arguments, c.function.name, provider),
    });
  }
  return {
    message: { text: choice.message.content ?? "", toolCalls },
    stopReason: mapOpenAIFinishReason(choice.finish_reason),
    usage: {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  constructor(apiKey: string, client?: OpenAI) {
    this.apiKey = apiKey;
    this.client = client ?? new OpenAI({ apiKey });
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    let resp: unknown;
    try {
      resp = await this.client.chat.completions.create(
        toOpenAIParams(
          req,
        ) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      throw providerError("openai", err, { apiKey: this.apiKey, signal: req.signal });
    }
    return fromOpenAIResponse(resp as OResponse);
  }
}
