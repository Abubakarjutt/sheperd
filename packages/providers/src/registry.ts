import { RewireError } from "@rewire/core";
import { AnthropicProvider } from "./anthropic.js";
import { FauxProvider } from "./faux.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelRef, Provider } from "./types.js";

export type ProviderFactory = (ref: ModelRef, env: NodeJS.ProcessEnv) => Provider;

const factories = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  factories.set(name, factory);
}

export function requireKey(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new RewireError("provider_auth_missing", `${name} is not set`);
  }
  return v;
}

export function createProvider(ref: ModelRef, env: NodeJS.ProcessEnv = process.env): Provider {
  const factory = factories.get(ref.provider);
  if (!factory) {
    throw new RewireError(
      "provider_unknown",
      `no provider registered for "${ref.provider}"`,
      ref.provider === "ollama" ? "ollama provider arrives in a later task" : undefined,
    );
  }
  return factory(ref, env);
}

registerProvider(
  "anthropic",
  (_ref, env) => new AnthropicProvider(requireKey(env, "ANTHROPIC_API_KEY")),
);
registerProvider("openai", (_ref, env) => new OpenAIProvider(requireKey(env, "OPENAI_API_KEY")));
registerProvider("faux", () => new FauxProvider([]));
