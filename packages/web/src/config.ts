/** The search services `web_search` can use (`[web] search` in models.toml). */
export const SEARCH_BACKENDS = ["ollama", "tavily", "brave", "searxng"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

/** `[web]` in models.toml. */
export type WebConfig = {
  /** The chosen backend; unset picks the first whose key is present (see `resolveSearch`). */
  search?: SearchBackend;
  /** The SearXNG instance (`searxng_url`): https, or http on a loopback host. */
  searxngUrl?: string;
  /** Results per search (`max_results`, 1 to 10). */
  maxResults: number;
};

export const DEFAULT_MAX_RESULTS = 5;
export const MAX_MAX_RESULTS = 10;

/** A fresh copy of the defaults, safe to mutate. */
export const defaultWebConfig = (): WebConfig => ({ maxResults: DEFAULT_MAX_RESULTS });

/** The env var holding each keyed backend's API key, in auto-selection order. */
export const SEARCH_KEY_ENV = {
  ollama: "OLLAMA_API_KEY",
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
} as const satisfies Partial<Record<SearchBackend, string>>;

export type Env = Record<string, string | undefined>;

export type ResolvedSearch = { backend: SearchBackend; keyEnv?: string } | { none: string };

const present = (env: Env, name: string): boolean => (env[name] ?? "").trim() !== "";

/**
 * Which backend `web_search` uses, or `{ none }` with what to set. `config.search` wins (its key
 * must be present, or for SearXNG its URL); unset, the first of ollama, tavily, brave whose key
 * is in `env`. Never throws: no backend is a tool error at search time, not a startup failure.
 */
export function resolveSearch(config: WebConfig, env: Env): ResolvedSearch {
  const chosen = config.search;
  if (chosen === "searxng") {
    return config.searxngUrl === undefined
      ? { none: 'set searxng_url in the [web] table of models.toml (search = "searxng")' }
      : { backend: "searxng" };
  }
  if (chosen !== undefined) {
    const keyEnv = SEARCH_KEY_ENV[chosen];
    return present(env, keyEnv)
      ? { backend: chosen, keyEnv }
      : { none: `set ${keyEnv} (models.toml [web] search = "${chosen}")` };
  }
  for (const backend of ["ollama", "tavily", "brave"] as const) {
    const keyEnv = SEARCH_KEY_ENV[backend];
    if (present(env, keyEnv)) return { backend, keyEnv };
  }
  return {
    none:
      "no web search service is configured: set OLLAMA_API_KEY (a free key from ollama.com), " +
      'TAVILY_API_KEY or BRAVE_API_KEY, or set [web] search = "searxng" and searxng_url in ' +
      "models.toml",
  };
}

/** The fixed host each keyed backend's request goes to (`searchServiceHost`). */
export const SEARCH_HOSTS = {
  ollama: "ollama.com",
  tavily: "api.tavily.com",
  brave: "api.search.brave.com",
} as const satisfies Partial<Record<SearchBackend, string>>;

/**
 * The host a search with `backend` is sent to, lowercased (policy checks it before a search):
 * the fixed service host, or the SearXNG URL's host; undefined for SearXNG without a URL.
 */
export function searchServiceHost(backend: SearchBackend, config: WebConfig): string | undefined {
  if (backend !== "searxng") return SEARCH_HOSTS[backend];
  if (config.searxngUrl === undefined) return undefined;
  try {
    return new URL(config.searxngUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
