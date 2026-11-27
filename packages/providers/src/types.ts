import { RewireError } from "@rewire/core";

export const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "ollama",
  "faux",
  "bedrock",
  "vertex",
  "foundry",
  "azure",
  "gemini",
] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * `provider` is a built-in `ProviderName` or the name of an OpenAI-compatible endpoint registered
 * with `registerEndpoints` (from `[endpoints.<name>]` in models.toml). Code that switches on the
 * provider narrows with `builtinProvider` first, so a switch over built-ins stays exhaustive.
 */
export type ModelRef = { provider: ProviderName | (string & {}); model: string };

/** `[endpoints.<name>]` in models.toml: an OpenAI-compatible API reached at `baseUrl`. */
export type EndpointConfig = {
  baseUrl: string;
  /** The name of the env var holding the API key (never the key itself); optional on loopback. */
  apiKeyEnv?: string;
  /** Overrides the family derived from the model id. */
  family?: string;
  contextWindow?: number;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

/** `[providers.*]` in models.toml: per-platform settings for the cloud providers. */
export type ProviderSettings = {
  bedrock?: { region?: string };
  vertex?: { project?: string; region?: string };
  foundry?: { resource?: string; baseUrl?: string };
  azure?: { endpoint?: string; apiVersion?: string };
};

/** Endpoint names: lowercase, start with a letter, at most 32 characters. */
export const ENDPOINT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const endpoints = new Map<string, EndpointConfig>();

/** `name` as a built-in provider name, or undefined when it is not one (an endpoint, or unknown). */
export function builtinProvider(name: string): ProviderName | undefined {
  return (PROVIDER_NAMES as readonly string[]).includes(name) ? (name as ProviderName) : undefined;
}

/** Why `name` cannot be an endpoint name, or undefined when it can. */
export function endpointNameProblem(name: string): string | undefined {
  if (builtinProvider(name) !== undefined) {
    return `endpoint name "${name}" is a built-in provider`;
  }
  if (!ENDPOINT_NAME_RE.test(name)) {
    return `endpoint name "${name}" must match ${ENDPOINT_NAME_RE.source}`;
  }
  return undefined;
}

/**
 * Registers OpenAI-compatible endpoints so `<name>:<model>` parses and resolves. Module-level
 * state, like `registerProvider`. Returns a function that restores the previous entries for
 * these names. Throws `model_ref_invalid` (registering nothing) for a malformed or built-in name.
 */
export function registerEndpoints(entries: Record<string, EndpointConfig>): () => void {
  for (const name of Object.keys(entries)) {
    const problem = endpointNameProblem(name);
    if (problem !== undefined) {
      throw new RewireError(
        "model_ref_invalid",
        problem,
        "use a lowercase name that is not a built-in provider",
      );
    }
  }
  const prev = new Map<string, EndpointConfig | undefined>();
  for (const [name, config] of Object.entries(entries)) {
    if (!prev.has(name)) prev.set(name, endpoints.get(name));
    endpoints.set(name, { ...config });
  }
  return () => {
    for (const [name, config] of prev) {
      if (config) endpoints.set(name, config);
      else endpoints.delete(name);
    }
  };
}

/** The registered endpoint called `name`, if any. */
export function endpointConfig(name: string): EndpointConfig | undefined {
  const c = endpoints.get(name);
  return c ? { ...c } : undefined;
}

/** Whether `name` is a registered endpoint (built-in provider names never are). */
export function isEndpointName(name: string): boolean {
  return endpoints.has(name);
}

/** Whether `name` is a built-in provider or a registered endpoint. */
export function isKnownProvider(name: string): boolean {
  return builtinProvider(name) !== undefined || endpoints.has(name);
}

export function parseModelRef(s: string): ModelRef {
  const i = s.indexOf(":");
  const provider = i < 0 ? s : s.slice(0, i);
  const model = i < 0 ? "" : s.slice(i + 1);
  if (!isKnownProvider(provider)) {
    const names = [...PROVIDER_NAMES, ...endpoints.keys()];
    throw new RewireError(
      "model_ref_invalid",
      `unknown provider in model ref "${s}"`,
      `use one of: ${names.join(", ")} as <provider>:<model>, or declare [endpoints.${ENDPOINT_NAME_RE.test(provider) ? provider : "<name>"}] in models.toml`,
    );
  }
  if (model === "") {
    throw new RewireError(
      "model_ref_invalid",
      `model ref "${s}" has no model name`,
      "use <provider>:<model>",
    );
  }
  return { provider, model };
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
