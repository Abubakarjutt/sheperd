import { RewireError } from "@rewire/core";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCloudProvider } from "./claude-cloud.js";
import { FauxProvider } from "./faux.js";
import { normalizeOllamaHost, OllamaProvider, ollamaChatTimeoutMs } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import {
  createAzureProvider,
  createEndpointProvider,
  createGeminiProvider,
} from "./openai-compatible.js";
import { isEndpointName, type ModelRef, type Provider, type ProviderSettings } from "./types.js";

/** `settings` are models.toml's `[providers.*]` tables (empty when there is no file). */
export type ProviderFactory = (
  ref: ModelRef,
  env: NodeJS.ProcessEnv,
  settings: ProviderSettings,
) => Provider;

const factories = new Map<string, ProviderFactory>();

/** Registers (or overrides) a factory. Returns a function that restores the previous state. */
export function registerProvider(name: string, factory: ProviderFactory): () => void {
  const prev = factories.get(name);
  factories.set(name, factory);
  return () => {
    if (prev) factories.set(name, prev);
    else factories.delete(name);
  };
}

export function requireKey(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new RewireError("provider_auth_missing", `${name} is not set`);
  }
  return v;
}

export function createProvider(
  ref: ModelRef,
  env: NodeJS.ProcessEnv = process.env,
  settings: ProviderSettings = {},
): Provider {
  const factory = factories.get(ref.provider);
  // A registered `[endpoints.<name>]` without an overriding factory.
  if (!factory && isEndpointName(ref.provider)) return createEndpointProvider(ref.provider, env);
  if (!factory) {
    throw new RewireError("provider_unknown", `no provider registered for "${ref.provider}"`);
  }
  return factory(ref, env, settings);
}

registerProvider(
  "anthropic",
  (_ref, env) => new AnthropicProvider(requireKey(env, "ANTHROPIC_API_KEY")),
);
registerProvider("openai", (_ref, env) => new OpenAIProvider(requireKey(env, "OPENAI_API_KEY")));
registerProvider("faux", () => new FauxProvider([]));
registerProvider("azure", (_ref, env, settings) => createAzureProvider(settings, env));
registerProvider("gemini", (_ref, env) => createGeminiProvider(env));
// Claude on the clouds: settings are checked now; each SDK is imported on the first chat.
for (const name of ["bedrock", "vertex", "foundry"] as const) {
  registerProvider(name, (_ref, env, settings) => new ClaudeCloudProvider(name, settings, env));
}
/** The Ollama base URL the provider and window discovery use: OLLAMA_HOST, normalized. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOllamaHost(env.OLLAMA_HOST);
}

registerProvider(
  "ollama",
  (_ref, env) => new OllamaProvider(ollamaBaseUrl(env), ollamaChatTimeoutMs(env)),
);
