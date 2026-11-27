import { RewireError } from "@rewire/core";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { providerError } from "./errors.js";
import {
  collectOpenAIStream,
  fromOpenAIResponse,
  StreamTruncatedError,
  toOpenAIParams,
  toOpenAIStreamParams,
} from "./openai.js";
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
const MAX_CHAT_TIMEOUT_S = 86_400;

/** Seconds one Ollama reply may take. Local models on modest hardware can need well over 300s. */
export const OLLAMA_TIMEOUT_ENV = "REWIRE_OLLAMA_TIMEOUT_S";

/** The per-reply Ollama timeout from REWIRE_OLLAMA_TIMEOUT_S: whole seconds, 1 to 86400; default 300. */
export function ollamaChatTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = (env[OLLAMA_TIMEOUT_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_CHAT_TIMEOUT_MS;
  const s = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(s) || s < 1 || s > MAX_CHAT_TIMEOUT_S) {
    throw new RewireError(
      "ollama_timeout_invalid",
      `${OLLAMA_TIMEOUT_ENV}="${raw}" is not a whole number of seconds from 1 to ${MAX_CHAT_TIMEOUT_S}`,
      `e.g. ${OLLAMA_TIMEOUT_ENV}=900 for 15 minutes per reply`,
    );
  }
  return s * 1000;
}

/** `host:port`, `0.0.0.0` and `http://host/` style OLLAMA_HOST values -> `http://host[:port]`. */
export function normalizeOllamaHost(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v === "") return DEFAULT_OLLAMA_HOST;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v.replace(/\/+$/, "");
  // Scheme-less: Ollama treats a bare host as port 11434.
  let host = v.replace(/\/+$/, "");
  if (host.includes("/")) {
    throw new RewireError(
      "ollama_host_invalid",
      `OLLAMA_HOST "${raw}" has a path but no scheme`,
      "use host:port, or a full URL like http://host:11434",
    );
  }
  if ((host.match(/:/g) ?? []).length > 1 && !host.startsWith("[")) host = `[${host}]`; // bare IPv6
  if (!/:\d+$/.test(host)) host = `${host}:11434`;
  return `http://${host}`;
}

function unreachable(baseUrl: string, detail?: string): RewireError {
  return new RewireError(
    "ollama_unreachable",
    `Ollama is not reachable at ${baseUrl}${detail ? ` (${detail})` : ""}`,
    "Start it with: ollama serve",
  );
}

/** Whether the Ollama server still answers (after a chat request's connection broke). */
async function answers(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
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
  /** Modelfile parameters as a text block, one "name value" per line (e.g. "num_ctx 8192"). */
  parameters: z.string().optional(),
});
const TagsSchema = z.object({
  models: z.array(
    z.object({ name: z.string(), model: z.string().optional(), digest: z.string().min(1) }),
  ),
});
const PsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      digest: z.string().optional(),
      context_length: z.number().optional(),
    }),
  ),
});

export type OllamaModelInfo = {
  capabilities: string[];
  contextLength: number | null;
  digest: string;
};

/** What `/api/show` says about a model's context. */
export type OllamaShowInfo = {
  capabilities: string[];
  /** The trained maximum: model_info `*.context_length`. */
  contextLength: number | null;
  /** The `num_ctx` Modelfile parameter, when the model sets one. */
  numCtx: number | null;
};

/** A model currently loaded in Ollama memory (`/api/ps`). */
export type OllamaLoadedModel = { name: string; digest?: string; contextLength: number | null };

/** "tiny" also names "tiny:latest"; a tagged name names only itself. */
function nameCandidates(model: string): string[] {
  return model.includes(":") ? [model] : [model, `${model}:latest`];
}

function matchesName(m: { name: string; model?: string }, candidates: string[]): boolean {
  return candidates.includes(m.name) || (m.model !== undefined && candidates.includes(m.model));
}

/** `num_ctx` from `/api/show` `parameters`; null when absent or not a positive integer. */
export function parseNumCtx(parameters: string | undefined): number | null {
  if (parameters === undefined) return null;
  const m = /^\s*num_ctx\s+(\S+)\s*$/m.exec(parameters);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The `/api/tags` entry for `model`. Throws `model_not_pulled` when it is not there. */
export async function findOllamaTag(
  baseUrl: string,
  model: string,
): Promise<{ name: string; digest: string }> {
  const tagsRaw = await ollamaRequest(baseUrl, "/api/tags");
  const tags = TagsSchema.safeParse(tagsRaw);
  if (!tags.success) {
    throw new RewireError("provider_bad_response", "ollama /api/tags has an unexpected shape");
  }
  const candidates = nameCandidates(model);
  const entry = tags.data.models.find((m) => matchesName(m, candidates));
  if (!entry) {
    throw new RewireError(
      "model_not_pulled",
      `Model "${model}" is not available in Ollama at ${baseUrl}`,
      `Run: ollama pull ${model}`,
    );
  }
  return { name: entry.name, digest: entry.digest };
}

export async function showOllamaModel(baseUrl: string, model: string): Promise<OllamaShowInfo> {
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
  return {
    capabilities: show.data.capabilities ?? [],
    contextLength,
    numCtx: parseNumCtx(show.data.parameters),
  };
}

/** The loaded instance of `model` from `/api/ps`, or null when it is not loaded. */
export async function getLoadedOllamaModel(
  baseUrl: string,
  model: string,
): Promise<OllamaLoadedModel | null> {
  const psRaw = await ollamaRequest(baseUrl, "/api/ps");
  const ps = PsSchema.safeParse(psRaw);
  if (!ps.success) {
    throw new RewireError("provider_bad_response", "ollama /api/ps has an unexpected shape");
  }
  const candidates = nameCandidates(model);
  const entry = ps.data.models.find((m) => matchesName(m, candidates));
  if (!entry) return null;
  const n = entry.context_length;
  return {
    name: entry.name,
    ...(entry.digest !== undefined && entry.digest !== "" ? { digest: entry.digest } : {}),
    contextLength: n !== undefined && Number.isInteger(n) && n > 0 ? n : null,
  };
}

export async function getModelInfo(baseUrl: string, model: string): Promise<OllamaModelInfo> {
  const entry = await findOllamaTag(baseUrl, model);
  const { capabilities, contextLength } = await showOllamaModel(baseUrl, model);
  return { capabilities, contextLength, digest: entry.digest };
}

const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/**
 * Whether an error thrown while reading a started stream is the connection breaking: a clean
 * close before the finish reason, or undici's body-read failure (`TypeError: terminated`, with
 * a socket error code on its cause). Malformed SSE, API error events and callback throws are not.
 */
function isStreamTransportError(err: unknown): boolean {
  if (err instanceof StreamTruncatedError) return true;
  let e: unknown = err;
  for (let depth = 0; depth < 4 && typeof e === "object" && e !== null; depth++) {
    const o = e as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    if (typeof o.code === "string" && TRANSPORT_CODES.has(o.code)) return true;
    if (o.name === "TypeError" && o.message === "terminated") return true;
    e = o.cause;
  }
  return false;
}

function isConnectionError(err: unknown): boolean {
  const name = err instanceof Error ? err.constructor.name : "";
  return name === "APIConnectionError" || name === "APIConnectionTimeoutError";
}

/** The SDK's own timeout sits just past ours, so ours fires first and names the variable. */
const SDK_TIMEOUT_SLACK_MS = 5_000;

/** No headers or body timeout: the per-request reply timeout is the only limit (see below). */
const OLLAMA_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class OllamaProvider implements Provider {
  private readonly client: OpenAI;
  constructor(
    private readonly baseUrl: string = DEFAULT_OLLAMA_HOST,
    private readonly chatTimeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS,
  ) {
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "ollama",
      maxRetries: 0,
      // A local model can read a long prompt for many minutes before it sends the response
      // headers. Node's fetch gives up after 300 s without headers and the SDK after 600 s, both
      // below a REWIRE_OLLAMA_TIMEOUT_S of 900: turn both off so the reply timeout (an
      // AbortSignal per request, below) is the only limit. undici's fetch is used because a
      // dispatcher only applies to the fetch from the same undici.
      fetch: undiciFetch as unknown as typeof fetch,
      fetchOptions: { dispatcher: OLLAMA_DISPATCHER } as Record<string, unknown>,
    });
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const timeoutMs = req.timeoutMs ?? this.chatTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const started = Date.now();
    let resp: unknown;
    // Set once a streamed reply has started: a transport failure after that is a dropped request.
    let streaming = false;
    try {
      if (req.onDelta) {
        const stream = await this.client.chat.completions.create(
          toOpenAIStreamParams(req, {
            maxTokensField: "max_tokens",
          }) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal, timeout: timeoutMs + SDK_TIMEOUT_SLACK_MS },
        );
        streaming = true;
        resp = await collectOpenAIStream(stream, req.onDelta, signal, req.onFirstChunk);
      } else
        resp = await this.client.chat.completions.create(
          // Ollama's OpenAI-compat layer lists `max_tokens` (not `max_completion_tokens`) as supported:
          // https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
          toOpenAIParams(req, {
            maxTokensField: "max_tokens",
          }) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { signal, timeout: timeoutMs + SDK_TIMEOUT_SLACK_MS },
        );
    } catch (err) {
      if (req.signal?.aborted) throw providerError("ollama", err, { signal: req.signal });
      if (timeout.aborted) {
        throw new RewireError(
          "ollama_timeout",
          `Ollama chat request to ${this.baseUrl} timed out after ${Math.round(timeoutMs / 1000)}s`,
          `The model may still be loading, or replies slowly on this machine: retry, or set ${OLLAMA_TIMEOUT_ENV} (seconds, e.g. 900)`,
        );
      }
      const midStreamDrop = streaming && isStreamTransportError(err);
      if (isConnectionError(err) || midStreamDrop) {
        // A broken connection to a server that still answers is a dropped request, not an outage.
        if (!(await answers(this.baseUrl))) throw unreachable(this.baseUrl);
        throw new RewireError(
          "ollama_request_dropped",
          `Ollama at ${this.baseUrl} dropped the chat request after ${Math.round((Date.now() - started) / 1000)}s`,
          "Ollama is running. It serves one request at a time per model, so another client using the same model (or a model reload) can make it give up on this one: retry when it is idle",
        );
      }
      throw providerError("ollama", err);
    }
    return fromOpenAIResponse(resp as Parameters<typeof fromOpenAIResponse>[0], "ollama");
  }
}
