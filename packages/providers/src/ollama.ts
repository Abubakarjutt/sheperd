import { RewireError } from "@rewire/core";
import OpenAI from "openai";
import { z } from "zod";
import { providerError } from "./errors.js";
import { fromOpenAIResponse, toOpenAIParams } from "./openai.js";
import type { ChatRequest, ChatResponse, Provider } from "./types.js";

/**
 * Oldest Ollama we support. It is the later of the two features we depend on:
 *  (a) `/api/show` returning `capabilities`: ollama/ollama PR #10066 ("api: return model
 *      capabilities from the show endpoint"), merged 2025-04-01, first released in v0.6.4
 *      (https://github.com/ollama/ollama/pull/10066, https://github.com/ollama/ollama/releases/tag/v0.6.4).
 *      The API doc shows the field: https://github.com/ollama/ollama/blob/main/docs/api.md
 *  (b) tool calling on `/v1/chat/completions`: PR #5614 "OpenAI: Support Tools", merged
 *      2024-07-17, first released in v0.3.0
 *      (https://github.com/ollama/ollama/pull/5614, https://github.com/ollama/ollama/releases/tag/v0.3.0;
 *      current support matrix: https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx).
 * Verified by checking that the v0.6.4 and v0.3.0 tags contain the respective merge commits.
 */
export const MIN_OLLAMA_VERSION = "0.6.4";

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_CHAT_TIMEOUT_MS = 300_000;

/** `host:port`, `0.0.0.0` and `http://host/` style OLLAMA_HOST values -> `http://host[:port]`. */
export function normalizeOllamaHost(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v === "") return DEFAULT_OLLAMA_HOST;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
  return withScheme.replace(/\/+$/, "");
}

function unreachable(baseUrl: string, detail?: string): RewireError {
  return new RewireError(
    "ollama_unreachable",
    `Ollama is not reachable at ${baseUrl}${detail ? ` (${detail})` : ""}`,
    "Start it with: ollama serve",
  );
}

async function ollamaRequest(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw unreachable(baseUrl);
  }
  if (!res.ok) {
    throw new RewireError("provider_bad_response", `ollama ${path} returned HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new RewireError("provider_bad_response", `ollama ${path} returned unparseable JSON`);
  }
}

function parseVersion(v: string): [number, number, number] | undefined {
  // Pre-release/build suffixes (e.g. "0.6.4-rc1") are ignored: rc1 counts as the release.
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function isOlderThan(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y;
  }
  return false;
}

export async function probeOllama(baseUrl: string): Promise<{ version: string }> {
  const body = await ollamaRequest(baseUrl, "/api/version");
  const parsed = z.object({ version: z.string() }).safeParse(body);
  if (!parsed.success) {
    throw new RewireError("provider_bad_response", "ollama /api/version has no version string");
  }
  const { version } = parsed.data;
  const have = parseVersion(version);
  if (!have) {
    throw new RewireError(
      "provider_bad_response",
      `ollama reported unparseable version "${version}"`,
    );
  }
  if (isOlderThan(have, parseVersion(MIN_OLLAMA_VERSION) as [number, number, number])) {
    throw new RewireError(
      "ollama_too_old",
      `Ollama ${version} is older than the minimum supported ${MIN_OLLAMA_VERSION}`,
      "Upgrade Ollama: https://ollama.com/download",
    );
  }
  return { version };
}

const ShowSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
});
const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), model: z.string().optional(), digest: z.string() })),
});

export type OllamaModelInfo = {
  capabilities: string[];
  contextLength: number | null;
  digest: string;
};

export async function getModelInfo(baseUrl: string, model: string): Promise<OllamaModelInfo> {
  const tagsRaw = await ollamaRequest(baseUrl, "/api/tags");
  const tags = TagsSchema.safeParse(tagsRaw);
  if (!tags.success) {
    throw new RewireError("provider_bad_response", "ollama /api/tags has an unexpected shape");
  }
  const candidates = model.includes(":") ? [model] : [model, `${model}:latest`];
  const entry = tags.data.models.find(
    (m) => candidates.includes(m.name) || (m.model !== undefined && candidates.includes(m.model)),
  );
  if (!entry) {
    throw new RewireError(
      "model_not_pulled",
      `Model "${model}" is not available in Ollama at ${baseUrl}`,
      `Run: ollama pull ${model}`,
    );
  }
  const showRaw = await ollamaRequest(baseUrl, "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const show = ShowSchema.safeParse(showRaw);
  if (!show.success) {
    throw new RewireError("provider_bad_response", "ollama /api/show has an unexpected shape");
  }
  let contextLength: number | null = null;
  for (const [k, v] of Object.entries(show.data.model_info ?? {})) {
    if (k.endsWith(".context_length") && typeof v === "number") contextLength = v;
  }
  return { capabilities: show.data.capabilities ?? [], contextLength, digest: entry.digest };
}

function isConnectionError(err: unknown): boolean {
  const name = err instanceof Error ? err.constructor.name : "";
  return name === "APIConnectionError" || name === "APIConnectionTimeoutError";
}

export class OllamaProvider implements Provider {
  private readonly client: OpenAI;
  constructor(private readonly baseUrl: string = DEFAULT_OLLAMA_HOST) {
    this.client = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: "ollama", maxRetries: 0 });
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let resp: unknown;
    try {
      resp = await this.client.chat.completions.create(
        // Ollama's OpenAI-compat layer lists `max_tokens` (not `max_completion_tokens`) as supported:
        // https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
        toOpenAIParams(req, {
          maxTokensField: "max_tokens",
        }) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal },
      );
    } catch (err) {
      if (req.signal?.aborted) throw providerError("ollama", err, { signal: req.signal });
      if (timeout.aborted) throw unreachable(this.baseUrl, "request timed out");
      if (isConnectionError(err)) throw unreachable(this.baseUrl);
      throw providerError("ollama", err);
    }
    return fromOpenAIResponse(resp as Parameters<typeof fromOpenAIResponse>[0], "ollama");
  }
}
