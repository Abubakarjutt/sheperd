import { RewireError } from "@rewire/core";
import { type ModelRef, normalizeOllamaHost } from "@rewire/providers";
import { z } from "zod";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_OPENAI_MODEL = "gpt-5";
export const OLLAMA_PROBE_TIMEOUT_MS = 2000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const ollamaBase = (env: NodeJS.ProcessEnv): string =>
  env.OLLAMA_HOST && env.OLLAMA_HOST.trim() !== ""
    ? normalizeOllamaHost(env.OLLAMA_HOST)
    : "http://127.0.0.1:11434";

const Tags = z.object({ models: z.array(z.object({ name: z.string().min(1) })) });

/**
 * Models when there is no models file: whichever API keys exist (values are only tested for
 * presence, never printed), then the first tagged model of a reachable local Ollama.
 */
export async function discoverModels(
  env: NodeJS.ProcessEnv,
  fetchFn: FetchLike = fetch,
): Promise<ModelRef[]> {
  const found: ModelRef[] = [];
  if (env.ANTHROPIC_API_KEY) found.push({ provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL });
  if (env.OPENAI_API_KEY) found.push({ provider: "openai", model: DEFAULT_OPENAI_MODEL });
  try {
    const res = await fetchFn(`${ollamaBase(env)}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const tags = Tags.safeParse(await res.json());
      const first = tags.success ? tags.data.models[0] : undefined;
      if (first) found.push({ provider: "ollama", model: first.name });
    }
  } catch {
    // Not reachable: Ollama is simply not a candidate.
  }
  if (found.length === 0) {
    throw new RewireError(
      "no_models_available",
      "no models available: no API key set and no reachable Ollama with a pulled model",
      "set ANTHROPIC_API_KEY or OPENAI_API_KEY, run `ollama serve` with a pulled model, or pass --models <file>",
    );
  }
  return found;
}
