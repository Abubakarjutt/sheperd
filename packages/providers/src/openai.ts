import { RewireError } from "@rewire/core";
import OpenAI from "openai";
import { providerError, streamCallbackFailed } from "./errors.js";
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
      "provider_bad_tool_args",
      `${provider} tool call "${name}" has invalid JSON arguments`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RewireError(
      "provider_bad_tool_args",
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

type OChunk = {
  choices?: ReadonlyArray<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: ReadonlyArray<{
        index: number;
        id?: string | null;
        type?: string | null;
        function?: { name?: string | null; arguments?: string | null } | null;
      }> | null;
    } | null;
  }> | null;
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
};

/** Streaming params: the non-streamed params plus `stream` and a final usage chunk. */
export function toOpenAIStreamParams(req: ChatRequest, opts: OpenAIParamOptions = {}) {
  return {
    ...toOpenAIParams(req, opts),
    stream: true as const,
    stream_options: { include_usage: true },
  };
}

/**
 * A streamed reply whose connection closed cleanly before the server sent a finish reason.
 * It is a transport failure, never a partial success: Ollama maps it like a dropped request.
 */
export class StreamTruncatedError extends Error {
  constructor() {
    super("stream ended before a finish reason");
    this.name = "StreamTruncatedError";
  }
}

/** Call the caller's stream callback; its throw surfaces as-is, never as a transport error. */
export function callOnDelta(onDelta: (text: string) => void, text: string): void {
  try {
    onDelta(text);
  } catch (err) {
    throw streamCallbackFailed(err);
  }
}

/** Call the caller's `onFirstChunk`; its throw surfaces as-is, never as a transport error. */
export function callOnFirstChunk(onFirstChunk: (() => void) | undefined): void {
  if (onFirstChunk === undefined) return;
  try {
    onFirstChunk();
  } catch (err) {
    throw streamCallbackFailed(err, "onFirstChunk");
  }
}

/**
 * Consume a chat-completions chunk stream: call `onFirstChunk` once on the first chunk that
 * carries a choice (reasoning-only and tool-call chunks included), `onDelta` per text delta, and
 * rebuild the
 * response a non-streamed call would have returned, for `fromOpenAIResponse` to parse.
 * Tool calls arrive as indexed deltas: id/name are set when present, argument fragments joined.
 * The SDK ends iteration quietly when the request is aborted, so an aborted signal is rethrown;
 * a stream that ends without a finish reason throws StreamTruncatedError.
 */
export async function collectOpenAIStream(
  stream: AsyncIterable<unknown>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onFirstChunk?: () => void,
): Promise<OResponse> {
  let first = true;
  let text = "";
  let finish: string | null = null;
  let usage: OResponse["usage"] = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const raw of stream) {
    if (signal?.aborted) break;
    const chunk = raw as OChunk;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.find((c) => (c.index ?? 0) === 0);
    if (!choice) continue;
    if (first) {
      first = false;
      callOnFirstChunk(onFirstChunk);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content !== "") {
      text += delta.content;
      callOnDelta(onDelta, delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  signal?.throwIfAborted();
  if (finish === null) throw new StreamTruncatedError();
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  return {
    choices: [
      {
        finish_reason: finish,
        message: { content: text, tool_calls: toolCalls.length > 0 ? toolCalls : null },
      },
    ],
    usage,
  };
}

/** The part of the `openai` client the provider uses; `OpenAI` and `AzureOpenAI` both fit. */
export type OpenAIChatClient = Pick<OpenAI, "chat">;

export type OpenAIProviderOptions = {
  /** The provider name used in errors (default `openai`). */
  name?: string;
  /** Extra values redacted literally from errors (credentials other than `apiKey`). */
  secrets?: readonly string[];
  /** How requests are shaped (default: OpenAI's own `max_completion_tokens`). */
  params?: OpenAIParamOptions;
};

export class OpenAIProvider implements Provider {
  private readonly client: OpenAIChatClient;
  private readonly apiKey: string;
  private readonly name: string;
  private readonly secrets: readonly string[];
  private readonly params: OpenAIParamOptions;
  constructor(apiKey: string, client?: OpenAIChatClient, opts: OpenAIProviderOptions = {}) {
    this.apiKey = apiKey;
    this.client = client ?? new OpenAI({ apiKey });
    this.name = opts.name ?? "openai";
    this.secrets = opts.secrets ?? [];
    this.params = opts.params ?? {};
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    let resp: unknown;
    try {
      if (req.onDelta) {
        const stream = await this.client.chat.completions.create(
          toOpenAIStreamParams(
            req,
            this.params,
          ) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          req.signal ? { signal: req.signal } : undefined,
        );
        resp = await collectOpenAIStream(stream, req.onDelta, req.signal, req.onFirstChunk);
      } else
        resp = await this.client.chat.completions.create(
          toOpenAIParams(
            req,
            this.params,
          ) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          req.signal ? { signal: req.signal } : undefined,
        );
    } catch (err) {
      throw providerError(this.name, err, {
        apiKey: this.apiKey,
        secrets: this.secrets,
        signal: req.signal,
      });
    }
    return fromOpenAIResponse(resp as OResponse, this.name);
  }
}
