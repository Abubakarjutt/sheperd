import { describe, expect, test } from "vitest";
import { resolveSearch, type WebConfig } from "../src/config.js";
import { USER_AGENT, type WebFetchFn, type WebRequestInit } from "../src/fetch.js";
import { webSearch } from "../src/search.js";

// Fake keys only.
const OLLAMA = "ollama-test-key-1";
const TAVILY = "tvly-test-key-2";
const BRAVE = "brave-test-key-3";

type Call = { url: string; init: WebRequestInit };

function json(body: unknown, status = 200): { fetchFn: WebFetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: WebFetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const cfg = (c: Partial<WebConfig> = {}): WebConfig => ({ maxResults: 5, ...c });

describe("resolveSearch", () => {
  test("unset search picks the first key present in the order ollama, tavily, brave", () => {
    expect(resolveSearch(cfg(), { BRAVE_API_KEY: BRAVE, TAVILY_API_KEY: TAVILY })).toEqual({
      backend: "tavily",
      keyEnv: "TAVILY_API_KEY",
    });
    expect(
      resolveSearch(cfg(), {
        BRAVE_API_KEY: BRAVE,
        TAVILY_API_KEY: TAVILY,
        OLLAMA_API_KEY: OLLAMA,
      }),
    ).toEqual({ backend: "ollama", keyEnv: "OLLAMA_API_KEY" });
    expect(resolveSearch(cfg(), { BRAVE_API_KEY: BRAVE })).toEqual({
      backend: "brave",
      keyEnv: "BRAVE_API_KEY",
    });
  });

  test("an empty key counts as absent", () => {
    expect(resolveSearch(cfg(), { OLLAMA_API_KEY: " ", BRAVE_API_KEY: BRAVE })).toMatchObject({
      backend: "brave",
    });
  });

  test("nothing configured names what to set", () => {
    const r = resolveSearch(cfg(), {});
    expect(r).toHaveProperty("none");
    const none = (r as { none: string }).none;
    for (const s of ["OLLAMA_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "searxng_url"]) {
      expect(none).toContain(s);
    }
  });

  test("an explicit backend wins, and its missing key is named", () => {
    expect(
      resolveSearch(cfg({ search: "brave" }), { OLLAMA_API_KEY: OLLAMA, BRAVE_API_KEY: BRAVE }),
    ).toEqual({ backend: "brave", keyEnv: "BRAVE_API_KEY" });
    expect(resolveSearch(cfg({ search: "tavily" }), { OLLAMA_API_KEY: OLLAMA })).toEqual({
      none: 'set TAVILY_API_KEY (models.toml [web] search = "tavily")',
    });
  });

  test("searxng needs a URL, not a key", () => {
    expect(
      resolveSearch(cfg({ search: "searxng", searxngUrl: "http://127.0.0.1:8888" }), {}),
    ).toEqual({ backend: "searxng" });
    expect(resolveSearch(cfg({ search: "searxng" }), {})).toHaveProperty("none");
  });
});

describe("webSearch backends", () => {
  test("ollama: POST /api/web_search with a bearer key; results{title,url,content}", async () => {
    const { fetchFn, calls } = json({
      results: [
        { title: "Vitest", url: "https://vitest.dev/", content: "Next generation testing" },
        { title: "No url" },
      ],
    });
    const r = await webSearch("vitest config", {
      config: cfg({ maxResults: 3 }),
      env: { OLLAMA_API_KEY: OLLAMA },
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    const c = calls[0] as Call;
    expect(c.url).toBe("https://ollama.com/api/web_search");
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("error");
    expect(c.init.headers).toEqual({
      authorization: `Bearer ${OLLAMA}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    });
    expect(JSON.parse(c.init.body ?? "")).toEqual({ query: "vitest config", max_results: 3 });
    expect(r).toEqual({
      backend: "ollama",
      results: [
        { title: "Vitest", url: "https://vitest.dev/", snippet: "Next generation testing" },
      ],
    });
  });

  test("tavily: POST /search with a bearer key and basic depth", async () => {
    const { fetchFn, calls } = json({
      results: [{ title: "T", url: "https://t.example/", content: "tc" }],
    });
    const r = await webSearch("q", {
      config: cfg({ search: "tavily", maxResults: 10 }),
      env: { TAVILY_API_KEY: TAVILY },
      fetchFn,
    });
    const c = calls[0] as Call;
    expect(c.url).toBe("https://api.tavily.com/search");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.authorization).toBe(`Bearer ${TAVILY}`);
    expect(JSON.parse(c.init.body ?? "")).toEqual({
      query: "q",
      max_results: 10,
      search_depth: "basic",
    });
    expect(r.results).toEqual([{ title: "T", url: "https://t.example/", snippet: "tc" }]);
  });

  test("brave: GET with q and count, X-Subscription-Token; web.results{title,url,description}", async () => {
    const { fetchFn, calls } = json({
      web: {
        results: [
          { title: "B1", url: "https://b.example/1", description: "d1" },
          { title: "B2", url: "https://b.example/2", description: "d2" },
        ],
      },
    });
    const r = await webSearch("a b&c", {
      config: cfg({ search: "brave", maxResults: 1 }),
      env: { BRAVE_API_KEY: BRAVE },
      fetchFn,
    });
    const c = calls[0] as Call;
    expect(c.url).toBe("https://api.search.brave.com/res/v1/web/search?q=a+b%26c&count=1");
    expect(c.init.method).toBe("GET");
    expect(c.init.body).toBeUndefined();
    expect(c.init.headers).toEqual({
      "x-subscription-token": BRAVE,
      accept: "application/json",
      "user-agent": USER_AGENT,
    });
    expect(r.results).toEqual([{ title: "B1", url: "https://b.example/1", snippet: "d1" }]);
  });

  test("searxng: GET <url>/search?q=…&format=json with no key; results{title,url,content}", async () => {
    // Shape of a SearXNG JSON response (searx/result_types: title, url, content; url may be null).
    const { fetchFn, calls } = json({
      query: "rust",
      number_of_results: 0,
      results: [
        {
          url: "https://www.rust-lang.org/",
          title: "Rust Programming Language",
          content: "A language empowering everyone",
          engine: "duckduckgo",
          engines: ["duckduckgo"],
          score: 1,
          category: "general",
        },
        { url: null, title: "no link", content: "" },
        { url: "https://x.example/", title: "only title" },
      ],
      answers: [],
      suggestions: [],
      unresponsive_engines: [],
    });
    const r = await webSearch("rust", {
      config: cfg({ search: "searxng", searxngUrl: "https://searx.example/sub" }),
      env: {},
      fetchFn,
    });
    const c = calls[0] as Call;
    expect(c.url).toBe("https://searx.example/sub/search?q=rust&format=json");
    expect(c.init.method).toBe("GET");
    expect(c.init.headers).toEqual({ accept: "application/json", "user-agent": USER_AGENT });
    expect(r.results).toEqual([
      {
        title: "Rust Programming Language",
        url: "https://www.rust-lang.org/",
        snippet: "A language empowering everyone",
      },
      { title: "only title", url: "https://x.example/", snippet: "" },
    ]);
  });

  test("searxng: a 403 says the JSON format is disabled on the server", async () => {
    const { fetchFn } = json("Forbidden", 403);
    await expect(
      webSearch("q", {
        config: cfg({ search: "searxng", searxngUrl: "http://127.0.0.1:8888/" }),
        env: {},
        fetchFn,
      }),
    ).rejects.toThrow(/JSON output is disabled.*search\.formats/);
  });
});

describe("webSearch refusals and failures", () => {
  const never: WebFetchFn = async () => {
    throw new Error("must not fetch");
  };

  test("no backend configured is an error naming what to set", async () => {
    await expect(webSearch("q", { config: cfg(), env: {}, fetchFn: never })).rejects.toThrow(
      /OLLAMA_API_KEY/,
    );
  });

  test("a query carrying a secret is refused before sending", async () => {
    await expect(
      webSearch("leak AKIAABCDEFGHIJKLMNOP please", {
        config: cfg(),
        env: { OLLAMA_API_KEY: OLLAMA },
        fetchFn: never,
      }),
    ).rejects.toThrow(/secret/);
  });

  test("an empty or over-long query is refused", async () => {
    const o = { config: cfg(), env: { OLLAMA_API_KEY: OLLAMA }, fetchFn: never };
    await expect(webSearch("  ", o)).rejects.toThrow(/empty/);
    await expect(webSearch("x".repeat(401), o)).rejects.toThrow(/400/);
  });

  test("an auth failure names the key env var, never the key", async () => {
    const { fetchFn } = json({ error: "unauthorized" }, 401);
    const err = await webSearch("q", {
      config: cfg(),
      env: { OLLAMA_API_KEY: OLLAMA },
      fetchFn,
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401.*OLLAMA_API_KEY/);
    expect((err as Error).message).not.toContain(OLLAMA);
  });

  test("a body that is not JSON, or has no results array, is an error", async () => {
    const env = { OLLAMA_API_KEY: OLLAMA };
    await expect(
      webSearch("q", { config: cfg(), env, fetchFn: json("<html>").fetchFn }),
    ).rejects.toThrow(/not JSON/);
    await expect(
      webSearch("q", { config: cfg(), env, fetchFn: json({ nope: 1 }).fetchFn }),
    ).rejects.toThrow(/no results list/);
  });

  test("a network failure is reported without the key", async () => {
    const fetchFn: WebFetchFn = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(
      webSearch("q", { config: cfg(), env: { OLLAMA_API_KEY: OLLAMA }, fetchFn }),
    ).rejects.toThrow(/ollama search failed: connect ECONNREFUSED/);
  });

  test("a search that never answers times out", async () => {
    const fetchFn: WebFetchFn = (_u, init) =>
      new Promise((_r, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    await expect(
      webSearch("q", { config: cfg(), env: { OLLAMA_API_KEY: OLLAMA }, fetchFn, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });

  test("non-http result URLs are dropped and long snippets clipped", async () => {
    const { fetchFn } = json({
      results: [
        { title: "js", url: "javascript:alert(1)", content: "x" },
        { title: "long", url: "https://l.example/", content: "z".repeat(5000) },
      ],
    });
    const r = await webSearch("q", { config: cfg(), env: { OLLAMA_API_KEY: OLLAMA }, fetchFn });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.snippet.length).toBeLessThanOrEqual(2001);
  });
});
