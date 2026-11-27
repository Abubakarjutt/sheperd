import Anthropic from "@anthropic-ai/sdk";
import { RewireError } from "@rewire/core";
import { providerError, streamCallbackFailed } from "./errors.js";
import type { ChatRequest, ChatResponse, Provider, StopReason, ToolCall } from "./types.js";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
type AMessage = { role: "user" | "assistant"; content: string | Block[] };

export function toAnthropicParams(req: ChatRequest) {
  const messages: AMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      if (!m.toolCallId) {
        throw new RewireError("provider_bad_request", "tool message is missing toolCallId");
      }
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = messages[messages.length - 1];
      if (
        prev &&
        prev.role === "user" &&
        Array.isArray(prev.content) &&
        prev.content.every((b) => b.type === "tool_result")
      ) {
        prev.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const content: Block[] = [];
      if (m.content !== "") content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      }
      messages.push({ role: "assistant", content });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const params: {
    model: string;
    system: string;
    max_tokens: number;
    messages: AMessage[];
    tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  } = { model: req.model, system: req.system, max_tokens: req.maxTokens, messages };
  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  return params;
}

export function mapAnthropicStopReason(r: string | null | undefined): StopReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    default:
      return "error";
  }
}

type AResponse = {
  content: ReadonlyArray<{ type: string; [k: string]: unknown }>;
  stop_reason: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
};

export function fromAnthropicResponse(resp: AResponse): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const b of resp.content) {
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type === "tool_use") {
      const input = b.input;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new RewireError("provider_bad_response", "anthropic tool_use input is not an object");
      }
      if (typeof b.id !== "string" || b.id === "" || typeof b.name !== "string" || b.name === "") {
        throw new RewireError("provider_bad_response", "anthropic tool_use block lacks id or name");
      }
      toolCalls.push({
        id: b.id,
        name: b.name,
        arguments: input as Record<string, unknown>,
      });
    }
  }
  return {
    message: { text, toolCalls },
    stopReason: mapAnthropicStopReason(resp.stop_reason),
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly apiKey: string;
  constructor(apiKey: string, client?: Anthropic) {
    this.apiKey = apiKey;
    this.client = client ?? new Anthropic({ apiKey });
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    let resp: unknown;
    try {
      if (req.onDelta) {
        // The SDK's MessageStream accumulates content blocks (tool_use input from
        // input_json_delta included) into the same Message shape `messages.create` returns.
        const stream = this.client.messages.stream(
          toAnthropicParams(req) as unknown as Anthropic.MessageStreamParams,
          req.signal ? { signal: req.signal } : undefined,
        );
        const onDelta = req.onDelta;
        const onFirstChunk = req.onFirstChunk;
        let callbackError: RewireError | undefined;
        let stopped = false;
        let first = true;
        stream.on("streamEvent", (event) => {
          if (event.type === "message_stop") stopped = true;
          // The first content event of any kind (thinking and tool_use included); message_start
          // is only the envelope and arrives before the prompt is read.
          if (
            first &&
            (event.type === "content_block_start" || event.type === "content_block_delta")
          ) {
            first = false;
            if (onFirstChunk && !callbackError) {
              try {
                onFirstChunk();
              } catch (err) {
                callbackError = streamCallbackFailed(err, "onFirstChunk");
                stream.abort();
              }
            }
          }
        });
        stream.on("text", (delta) => {
          if (callbackError) return;
          try {
            onDelta(delta);
          } catch (err) {
            // Surface the caller's throw as-is: stop the request and rethrow it below.
            callbackError = streamCallbackFailed(err);
            stream.abort();
          }
        });
        try {
          resp = await stream.finalMessage();
        } catch (err) {
          if (callbackError) throw callbackError;
          throw err;
        }
        if (callbackError) throw callbackError;
        // A stream that closes before message_stop is a failed request, never a partial reply.
        if (!stopped) throw new Error("stream ended before message_stop");
      } else
        resp = await this.client.messages.create(
          toAnthropicParams(req) as unknown as Anthropic.MessageCreateParamsNonStreaming,
          req.signal ? { signal: req.signal } : undefined,
        );
    } catch (err) {
      throw providerError("anthropic", err, { apiKey: this.apiKey, signal: req.signal });
    }
    return fromAnthropicResponse(resp as AResponse);
  }
}
