import { RewireError } from "@rewire/core";

export const PROVIDER_NAMES = ["anthropic", "openai", "ollama", "faux"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type ModelRef = { provider: ProviderName; model: string };

export function parseModelRef(s: string): ModelRef {
  const i = s.indexOf(":");
  const provider = i < 0 ? s : s.slice(0, i);
  const model = i < 0 ? "" : s.slice(i + 1);
  if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
    throw new RewireError(
      "model_ref_invalid",
      `unknown provider in model ref "${s}"`,
      `use one of: ${PROVIDER_NAMES.join(", ")} as <provider>:<model>`,
    );
  }
  if (model === "") {
    throw new RewireError(
      "model_ref_invalid",
      `model ref "${s}" has no model name`,
      "use <provider>:<model>",
    );
  }
  return { provider: provider as ProviderName, model };
}

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};
export type AssistantMessage = { text: string; toolCalls: ToolCall[] };
export type Usage = { inputTokens: number; outputTokens: number };
export type StopReason = "end" | "tool_use" | "length" | "error";

export type ChatRequest = {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Optional wall-clock cap for the call; honored by providers that support it (ollama). */
  timeoutMs?: number;
  /**
   * Optional token streaming. When set, providers request a streamed reply and call this with
   * each text delta, in order; the resolved ChatResponse is the same as without it. When unset,
   * the request is exactly the non-streamed one.
   * OpenAI and Anthropic streams have no wall-clock bound once headers arrive: callers that
   * stream must pass a `signal` (Ollama's REWIRE_OLLAMA_TIMEOUT_S still covers the whole call).
   */
  onDelta?: (text: string) => void;
  /**
   * Called exactly once, when the first stream chunk of any kind arrives (reasoning/thinking and
   * tool-call deltas included), so callers can time prompt reading apart from generation. Only
   * fires on a streamed call (`onDelta` set); never changes the request sent.
   */
  onFirstChunk?: () => void;
};
export type ChatResponse = { message: AssistantMessage; stopReason: StopReason; usage: Usage };

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
