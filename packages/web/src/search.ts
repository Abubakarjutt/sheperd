import {
  type Env,
  MAX_MAX_RESULTS,
  resolveSearch,
  type SearchBackend,
  type WebConfig,
} from "./config.js";
import { WebError } from "./error.js";
import {
  defaultFetch,
  FETCH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  USER_AGENT,
  type WebFetchFn,
  type WebRequestInit,
} from "./fetch.js";
import { checkOutgoing } from "./outgoing.js";

export const MAX_QUERY_CHARS = 400;
/** Ollama's `content` can be a whole page; a snippet is a preview. */
export const MAX_SNIPPET_CHARS = 2000;

export type SearchResult = { title: string; url: string; snippet: string };

export type WebSearchOptions = {
  config: WebConfig;
  env: Env;
  fetchFn?: WebFetchFn;
  signal?: AbortSignal;
  /** Overrides the 30 s timeout, for tests. */
  timeoutMs?: number;
};

export type WebSearchResult = { results: SearchResult[]; backend: SearchBackend };

type Request = { url: string; init: Omit<WebRequestInit, "signal" | "redirect"> };

function request(
  backend: SearchBackend,
  query: string,
  count: number,
  config: WebConfig,
  key: string,
): Request {
  const json = { accept: "application/json", "user-agent": USER_AGENT };
  switch (backend) {
    case "ollama":
      return {
        url: "https://ollama.com/api/web_search",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...json },
          body: JSON.stringify({ query, max_results: count }),
        },
      };
    case "tavily":
      return {
        url: "https://api.tavily.com/search",
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...json },
          body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
        },
      };
    case "brave":
      return {
        url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count) })}`,
        init: { method: "GET", headers: { "x-subscription-token": key, ...json } },
      };
    case "searxng": {
      const base = new URL(config.searxngUrl ?? "");
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      const url = new URL("search", base);
      url.search = new URLSearchParams({ q: query, format: "json" }).toString();
      return { url: url.href, init: { method: "GET", headers: json } };
    }
  }
}

/** Where each backend keeps its result list, and the field it calls the snippet. */
function extract(backend: SearchBackend, body: unknown): { list: unknown; snippet: string } {
  const o = (body ?? {}) as Record<string, unknown>;
  if (backend === "brave") {
    return { list: ((o.web ?? {}) as Record<string, unknown>).results, snippet: "description" };
  }
  return { list: o.results, snippet: "content" };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function isHttp(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * Search the web with the backend `resolveSearch` picks. The query is refused before sending
 * when it is empty, over 400 characters or carries a secret. Results are parsed defensively
 * (entries without an http(s) URL are dropped) and capped at `config.maxResults`; they are NOT
 * sanitized or fenced here (the tool wrapping does that). Throws `WebError`.
 */
export async function webSearch(query: string, o: WebSearchOptions): Promise<WebSearchResult> {
  const q = query.trim();
  if (q === "") throw new WebError("refused: the search query is empty");
  if (q.length > MAX_QUERY_CHARS) {
    throw new WebError(`refused: the search query is longer than ${MAX_QUERY_CHARS} characters`);
  }
  const secret = checkOutgoing(q);
  if (secret !== undefined) throw new WebError(secret);
  const chosen = resolveSearch(o.config, o.env);
  if ("none" in chosen) throw new WebError(chosen.none);
  const { backend, keyEnv } = chosen;
  const count = Math.max(1, Math.min(MAX_MAX_RESULTS, Math.trunc(o.config.maxResults)));
  const key = keyEnv === undefined ? "" : (o.env[keyEnv] ?? "").trim();
  const req = request(backend, q, count, o.config, key);

  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const fetchFn = o.fetchFn ?? defaultFetch;
  let res: Response;
  let text: string;
  try {
    // redirect "error": an API key header must never follow a redirect to another host.
    res = await fetchFn(req.url, { ...req.init, redirect: "error", signal });
    text = await readText(res);
  } catch (e) {
    if (timeout.aborted) {
      throw new WebError(`${backend} search timed out after ${Math.round(timeoutMs / 1000)} s`);
    }
    if (o.signal?.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new WebError(
      `${backend} search failed: ${key === "" ? msg : msg.replaceAll(key, "[key]")}`,
    );
  }
  if (!res.ok) {
    if (backend === "searxng" && res.status === 403) {
      throw new WebError(
        "searxng search failed: HTTP 403, so the server's JSON output is disabled; add json to search.formats in its settings.yml",
      );
    }
    const hint =
      (res.status === 401 || res.status === 403) && keyEnv !== undefined
        ? ` (check ${keyEnv})`
        : "";
    throw new WebError(`${backend} search failed: HTTP ${res.status}${hint}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebError(`${backend} search returned a response that is not JSON`);
  }
  const { list, snippet } = extract(backend, body);
  if (!Array.isArray(list)) throw new WebError(`${backend} search returned no results list`);
  const results: SearchResult[] = [];
  for (const item of list) {
    if (results.length >= count) break;
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const url = str(r.url);
    if (!isHttp(url)) continue;
    const s = str(r[snippet]);
    results.push({
      title: str(r.title),
      url,
      snippet: s.length > MAX_SNIPPET_CHARS ? `${s.slice(0, MAX_SNIPPET_CHARS)}…` : s,
    });
  }
  return { results, backend };
}

/** The body as text, at most 5 MB. */
async function readText(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error("the response is larger than 5 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
