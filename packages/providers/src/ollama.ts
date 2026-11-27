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
import type { ChatRequest, ChatResponse, Provider, ProviderSettings } from "./types.js";

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
const DEFAULT_CHAT_TIMEOUT_MS = 900_000;
const MAX_CHAT_TIMEOUT_S = 86_400;

/**
 * Seconds one Ollama reply may take (for a streamed reply: until its first chunk). Local models
 * on modest hardware can need many minutes to read a long prompt.
 */
export const OLLAMA_TIMEOUT_ENV = "REWIRE_OLLAMA_TIMEOUT_S";

/**
 * A streamed reply that has started fails only when no chunk (text, thinking or tool-call delta)
 * arrives for this long. There is no total cap while chunks flow.
 */
export const OLLAMA_IDLE_TIMEOUT_MS = 120_000;

/** The reply timeout in use and where it came from. */
export type OllamaTimeout = { ms: number; source: "env" | "models.toml" | "default" };

/**
 * The reply timeout: REWIRE_OLLAMA_TIMEOUT_S, else models.toml's `[providers.ollama] timeout_s`,
 * else 900 s. The variable is whole seconds, 1 to 86400; an invalid value is refused even when
 * models.toml sets one (it wins, so it must not be silently ignored).
 */
export function resolveOllamaTimeout(
  env: Record<string, string | undefined>,
  settings: ProviderSettings = {},
): OllamaTimeout {
  const raw = (env[OLLAMA_TIMEOUT_ENV] ?? "").trim();
  if (raw !== "") {
    const s = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(s) || s < 1 || s > MAX_CHAT_TIMEOUT_S) {
      throw new RewireError(
        "ollama_timeout_invalid",
        `${OLLAMA_TIMEOUT_ENV}="${raw}" is not a whole number of seconds from 1 to ${MAX_CHAT_TIMEOUT_S}`,
        `e.g. ${OLLAMA_TIMEOUT_ENV}=900 for 15 minutes per reply`,
      );
    }
    return { ms: s * 1000, source: "env" };
  }
  const fromToml = settings.ollama?.timeoutS;
  if (fromToml !== undefined) return { ms: fromToml * 1000, source: "models.toml" };
  return { ms: DEFAULT_CHAT_TIMEOUT_MS, source: "default" };
}

/** The reply timeout's milliseconds from REWIRE_OLLAMA_TIMEOUT_S alone (default 900 s). */
export function ollamaChatTimeoutMs(env: Record<string, string | undefined>): number {
  return resolveOllamaTimeout(env).ms;
}

/** `900s`, or `250ms` for a value that is not whole seconds (only tests use those). */
function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** Where the reply timeout came from, for the `ollama_timeout` message. */
function describeTimeout(t: OllamaTimeout): string {
  if (t.source === "env") return `${OLLAMA_TIMEOUT_ENV}=${t.ms / 1000} from the environment`;
  if (t.source === "models.toml") return `[providers.ollama] timeout_s in models.toml`;
  return `the ${duration(t.ms)} default`;
}

/** How to raise the reply timeout, given where the current one came from. */
function raiseHint(t: OllamaTimeout): string {
  if (t.source === "default") {
    return `${OLLAMA_TIMEOUT_ENV} is not set in this process's environment, so the default applies (a terminal opened before you edited ~/.zshrc does not have it: open a new one), or set [providers.ollama] timeout_s in models.toml (seconds, e.g. 1800)`;
  }
  if (t.source === "env") {
    return `raise ${OLLAMA_TIMEOUT_ENV} (seconds, e.g. 1800); it overrides [providers.ollama] timeout_s`;
  }
  return `raise [providers.ollama] timeout_s in models.toml (seconds, e.g. 1800), unless ${OLLAMA_TIMEOUT_ENV} is set: it wins`;
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

/**
 * The SDK's own timeout sits just past ours, so ours fires first. The SDK clears it once the
 * response headers arrive, so on a stream it bounds only the wait for headers, which is never
 * longer than the wait for the first chunk: it cannot cap a stream that has started.
 */
const SDK_TIMEOUT_SLACK_MS = 5_000;

/**
 * No headers or body timeout: our own timers are the only limit (see below). A body timeout
 * would also be an idle limit on a stream, but one that fails with a transport error instead of
 * `ollama_timeout`.
 */
const OLLAMA_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Yields what `it` yields, calling `touch` before each item. */
async function* touching<T>(it: AsyncIterable<T>, touch: () => void): AsyncGenerator<T> {
  for await (const x of it) {
    touch();
    yield x;
  }
}

export type OllamaProviderOptions = {
  /** Test seam: the streamed-reply idle timeout (default `OLLAMA_IDLE_TIMEOUT_MS`). */
  idleTimeoutMs?: number;
};

export class OllamaProvider implements Provider {
  private readonly client: OpenAI;
  private readonly idleTimeoutMs: number;
  constructor(
    private readonly baseUrl: string = DEFAULT_OLLAMA_HOST,
    private readonly timeout: OllamaTimeout = { ms: DEFAULT_CHAT_TIMEOUT_MS, source: "default" },
    opts: OllamaProviderOptions = {},
  ) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? OLLAMA_IDLE_TIMEOUT_MS;
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "ollama",
      maxRetries: 0,
      // A local model can read a long prompt for many minutes before it sends the response
      // headers. Node's fetch gives up after 300 s without headers and the SDK after 600 s, both
      // below a reply timeout of 900: turn both off so our own timers (per request, below) are
      // the only limit. undici's fetch is used because a dispatcher only applies to the fetch
      // from the same undici.
      fetch: undiciFetch as unknown as typeof fetch,
      fetchOptions: { dispatcher: OLLAMA_DISPATCHER } as Record<string, unknown>,
    });
  }
  /**
   * Non-streamed: one total timeout, the reply timeout. Streamed (`onDelta`): the reply timeout
   * bounds only the wait for the first chunk (prompt reading); after that the request fails only
   * when no chunk arrives for the idle timeout, so a model that keeps writing is never cut off.
   * The caller's `signal` aborts either way.
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const limit: OllamaTimeout =
      req.timeoutMs === undefined || req.timeoutMs === this.timeout.ms
        ? this.timeout
        : { ...this.timeout, ms: req.timeoutMs };
    const perCall = limit !== this.timeout;
    const timer = new AbortController();
    let fired: "total" | "first" | "idle" | undefined;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, kind: "total" | "first" | "idle") => {
      clearTimeout(handle);
      handle = setTimeout(() => {
        fired = kind;
        timer.abort();
      }, ms);
    };
    const signal = req.signal ? AbortSignal.any([req.signal, timer.signal]) : timer.signal;
    const started = Date.now();
    let resp: unknown;
    // Set once a streamed reply has started: a transport failure after that is a dropped request.
    let streaming = false;
    try {
      if (req.onDelta) {
        arm(limit.ms, "first");
        const stream = await this.client.chat.completions.create(
          toOpenAIStreamParams(req, {
            maxTokensField: "max_tokens",
          }) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          { signal, timeout: limit.ms + SDK_TIMEOUT_SLACK_MS },
        );
        streaming = true;
        const idle = () => arm(this.idleTimeoutMs, "idle");
        resp = await collectOpenAIStream(
          touching(stream, idle),
          req.onDelta,
          signal,
          req.onFirstChunk,
        );
      } else {
        arm(limit.ms, "total");
        resp = await this.client.chat.completions.create(
          // Ollama's OpenAI-compat layer lists `max_tokens` (not `max_completion_tokens`) as supported:
          // https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
          toOpenAIParams(req, {
            maxTokensField: "max_tokens",
          }) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { signal, timeout: limit.ms + SDK_TIMEOUT_SLACK_MS },
        );
      }
    } catch (err) {
      if (req.signal?.aborted) throw providerError("ollama", err, { signal: req.signal });
      if (fired !== undefined) throw this.timedOut(fired, limit, perCall);
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
    } finally {
      clearTimeout(handle);
    }
    return fromOpenAIResponse(resp as Parameters<typeof fromOpenAIResponse>[0], "ollama");
  }

  private timedOut(
    kind: "total" | "first" | "idle",
    limit: OllamaTimeout,
    perCall: boolean,
  ): RewireError {
    const at = `Ollama chat request to ${this.baseUrl}`;
    if (kind === "idle") {
      return new RewireError(
        "ollama_timeout",
        `${at} stopped streaming: no output for ${duration(this.idleTimeoutMs)} after the reply started`,
        "The model stalled mid-reply (or the machine is overloaded): retry. This idle limit is fixed; the reply timeout only bounds the wait for the first output",
      );
    }
    const what = perCall
      ? `a per-call limit of ${duration(limit.ms)}`
      : `reply timeout ${duration(limit.ms)}: ${describeTimeout(limit)}`;
    const message =
      kind === "first"
        ? `${at} timed out: no output within ${duration(limit.ms)} (${what})`
        : `${at} timed out after ${duration(limit.ms)} (${what})`;
    return new RewireError(
      "ollama_timeout",
      message,
      `The model may still be loading, or reads the prompt slowly on this machine: retry, or ${raiseHint(this.timeout)}`,
    );
  }
}
