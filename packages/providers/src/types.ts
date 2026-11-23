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
};
export type ChatResponse = { message: AssistantMessage; stopReason: StopReason; usage: Usage };

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
