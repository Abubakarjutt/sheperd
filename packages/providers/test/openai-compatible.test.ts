import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAIProvider, toOpenAIParams, toOpenAIStreamParams } from "../src/openai.js";
import {
  createAzureProvider,
  createEndpointProvider,
  createGeminiProvider,
  GEMINI_BASE_URL,
} from "../src/openai-compatible.js";
import { createProvider } from "../src/registry.js";
import { type ChatRequest, parseModelRef, registerEndpoints } from "../src/types.js";
import { contextWindow, DEFAULT_CONTEXT_WINDOW } from "../src/window.js";
import { openaiChunks, openaiSSE } from "./sse.js";

// Fake values only: no real credential is ever read or sent.
const AZURE_KEY = "fakeazurekey0123456789abcdef";
const GEMINI_KEY = "fakegeminikey0123456789abcdef";
const GROQ_KEY = "fakegroqkey0123456789abcdef";

type Seen = { url: string; method: string; headers: Headers; body: Record<string, unknown> };

const usage = { prompt_tokens: 11, completion_tokens: 7 };
const completion = {
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello" } }],
  usage,
};
const sse = openaiSSE(openaiChunks({ text: ["Hel", "lo"], finish: "stop", usage }));

/** Records each request and replies with a completion (or its stream when the body asks). */
function recordingFetch(reply?: (body: Record<string, unknown>) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({
      url: String(input),
      method: String(init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body,
    });
    if (reply) return reply(body);
    if (body.stream) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

const req = (model: string): ChatRequest => ({
  model,
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 9,
  tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
});
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

/** One plain and one streamed chat; returns both recorded requests and the streamed deltas. */
async function both(provider: OpenAIProvider, seen: Seen[], r: ChatRequest) {
  const plain = await provider.chat(r);
  expect(plain.message.text).toBe("Hello");
  const deltas: string[] = [];
  const streamed = await provider.chat({ ...r, onDelta: (d) => deltas.push(d) });
  expect(streamed).toEqual(plain);
  expect(deltas).toEqual(["Hel", "lo"]);
  expect(seen).toHaveLength(2);
  return { plain: seen[0] as Seen, stream: seen[1] as Seen };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** SDK env defaults that must never steer or decorate a request (the env passed in is authoritative). */
function stubSdkEnv() {
  vi.stubEnv("OPENAI_BASE_URL", "https://evil.example.com/v1");
  vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://evil.openai.azure.com");
  vi.stubEnv("AZURE_OPENAI_API_KEY", "processenvazurekey000000");
  vi.stubEnv("OPENAI_API_VERSION", "1999-01-01");
  vi.stubEnv("OPENAI_ORG_ID", "org-fake");
  vi.stubEnv("OPENAI_PROJECT_ID", "proj-fake");
  vi.stubEnv("OPENAI_API_KEY", OPENAI_KEY);
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", CUSTOM_HEADERS);
}

/** A credential meant for an OpenAI gateway: it must never reach another vendor. */
const OPENAI_KEY = "sk-processenvopenaikey0000000";
const GATEWAY_KEY = "gatewaykey0123456789abcdef";
const CUSTOM_HEADERS = `Authorization: Bearer ${OPENAI_KEY}\napi-key: ${GATEWAY_KEY}\nx-foo: 1`;

function expectNoOpenAIHeaders(h: Headers) {
  expect(h.has("openai-organization")).toBe(false);
  expect(h.has("openai-project")).toBe(false);
  expect(h.has("x-foo")).toBe(false);
  const all = [...h.values()].join(" ");
  expect(all).not.toContain(OPENAI_KEY);
  expect(all).not.toContain(GATEWAY_KEY);
}

/** Exactly this client's own credential, in its own header, and no other auth header. */
function expectOwnAuth(h: Headers, auth: { apiKey: string } | { bearer: string } | "none") {
  if (auth === "none") {
    expect(h.has("authorization")).toBe(false);
    expect(h.has("api-key")).toBe(false);
  } else if ("apiKey" in auth) {
    expect(h.get("api-key")).toBe(auth.apiKey);
    expect(h.has("authorization")).toBe(false);
  } else {
    expect(h.get("authorization")).toBe(`Bearer ${auth.bearer}`);
    expect(h.has("api-key")).toBe(false);
  }
  expectNoOpenAIHeaders(h);
}

describe("azure", () => {
  const settings = {
    azure: { endpoint: "https://res.openai.azure.com/", apiVersion: "2024-10-21" },
  };

  test("hits <endpoint>/openai/deployments/<deployment>/chat/completions with an api-key header", async () => {
    stubSdkEnv();
    const f = recordingFetch();
    const p = createAzureProvider(
      settings,
      { AZURE_OPENAI_API_KEY: AZURE_KEY },
      { fetch: f.fetch },
    );
    const r = req("my-gpt");
    const { plain, stream } = await both(p, f.seen, r);
    for (const s of [plain, stream]) {
      expect(s.url).toBe(
        "https://res.openai.azure.com/openai/deployments/my-gpt/chat/completions?api-version=2024-10-21",
      );
      expect(s.method).toBe("POST");
      expectOwnAuth(s.headers, { apiKey: AZURE_KEY });
    }
    expect(plain.body).toEqual(wire(toOpenAIParams(r)));
    expect(stream.body).toEqual(wire(toOpenAIStreamParams(r)));
    expect(plain.body.max_completion_tokens).toBe(9);
  });

  test("endpoint and api version from env when models.toml has none; toml wins over env", async () => {
    const f = recordingFetch();
    const env = {
      AZURE_OPENAI_API_KEY: AZURE_KEY,
      AZURE_OPENAI_ENDPOINT: "https://envres.openai.azure.com",
      OPENAI_API_VERSION: "2025-01-01",
    };
    await createAzureProvider({}, env, { fetch: f.fetch }).chat(req("d"));
    await createAzureProvider(settings, env, { fetch: f.fetch }).chat(req("d"));
    expect(f.seen.map((s) => s.url)).toEqual([
      "https://envres.openai.azure.com/openai/deployments/d/chat/completions?api-version=2025-01-01",
      "https://res.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21",
    ]);
  });

  test("missing key, endpoint or api version is provider_auth_missing naming what to set", () => {
    stubSdkEnv();
    const cases: [Parameters<typeof createAzureProvider>[0], NodeJS.ProcessEnv, RegExp][] = [
      [settings, {}, /AZURE_OPENAI_API_KEY/],
      [
        { azure: { apiVersion: "v" } },
        { AZURE_OPENAI_API_KEY: AZURE_KEY },
        /AZURE_OPENAI_ENDPOINT/,
      ],
      [
        { azure: { endpoint: "https://res.openai.azure.com" } },
        { AZURE_OPENAI_API_KEY: AZURE_KEY },
        /OPENAI_API_VERSION/,
      ],
    ];
    for (const [s, env, names] of cases) {
      let err: unknown;
      try {
        createAzureProvider(s, env);
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: "provider_auth_missing" });
      const e = err as { message: string; hint?: string };
      expect(`${e.message} ${e.hint ?? ""}`).toMatch(names);
    }
  });

  test("an endpoint that is not https (or loopback http) is refused at creation", () => {
    for (const endpoint of [
      "http://res.openai.azure.com",
      "https://u:p@res.openai.azure.com",
      "https://res.openai.azure.com/?x=1",
      "https://res.openai.azure.com/openai/deployments/foo",
      "not a url",
    ]) {
      expect(() =>
        createAzureProvider(
          {},
          {
            AZURE_OPENAI_API_KEY: AZURE_KEY,
            AZURE_OPENAI_ENDPOINT: endpoint,
            OPENAI_API_VERSION: "v",
          },
        ),
      ).toThrowError(expect.objectContaining({ code: "provider_auth_missing" }));
    }
  });
});

describe("gemini", () => {
  test("hits the OpenAI-compatible base with Bearer auth and max_tokens", async () => {
    stubSdkEnv();
    const f = recordingFetch();
    const p = createGeminiProvider({ GEMINI_API_KEY: GEMINI_KEY }, { fetch: f.fetch });
    const r = req("gemini-2.5-pro");
    const { plain, stream } = await both(p, f.seen, r);
    expect(GEMINI_BASE_URL).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
    for (const s of [plain, stream]) {
      expect(s.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
      expect(s.method).toBe("POST");
      expectOwnAuth(s.headers, { bearer: GEMINI_KEY });
    }
    expect(plain.body).toEqual(wire(toOpenAIParams(r, { maxTokensField: "max_tokens" })));
    expect(stream.body).toEqual(wire(toOpenAIStreamParams(r, { maxTokensField: "max_tokens" })));
    expect(plain.body.max_tokens).toBe(9);
    expect(plain.body).not.toHaveProperty("max_completion_tokens");
  });

  test("GOOGLE_API_KEY is the fallback; neither is provider_auth_missing naming GEMINI_API_KEY", async () => {
    const f = recordingFetch();
    await createGeminiProvider({ GOOGLE_API_KEY: GEMINI_KEY }, { fetch: f.fetch }).chat(req("g"));
    expect(f.seen).toHaveLength(1);
    expect(() => createGeminiProvider({ GEMINI_API_KEY: "" })).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        message: "GEMINI_API_KEY is not set",
      }),
    );
  });
});

describe("OpenAI-compatible endpoints", () => {
  test("hits <base_url>/chat/completions with Bearer from api_key_env and max_tokens by default", async () => {
    stubSdkEnv();
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
    });
    try {
      const f = recordingFetch();
      const p = createEndpointProvider("groq", { GROQ_API_KEY: GROQ_KEY }, { fetch: f.fetch });
      const r = req("llama-3.3-70b");
      const { plain, stream } = await both(p, f.seen, r);
      for (const s of [plain, stream]) {
        expect(s.url).toBe("https://api.groq.com/openai/v1/chat/completions");
        expect(s.method).toBe("POST");
        expectOwnAuth(s.headers, { bearer: GROQ_KEY });
      }
      expect(plain.body).toEqual(wire(toOpenAIParams(r, { maxTokensField: "max_tokens" })));
      expect(stream.body).toEqual(wire(toOpenAIStreamParams(r, { maxTokensField: "max_tokens" })));
    } finally {
      undo();
    }
  });

  test("max_tokens_field = max_completion_tokens is honoured", async () => {
    const undo = registerEndpoints({
      deepseek: {
        baseUrl: "https://api.deepseek.com/",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        maxTokensField: "max_completion_tokens",
      },
    });
    try {
      const f = recordingFetch();
      await createEndpointProvider(
        "deepseek",
        { DEEPSEEK_API_KEY: GROQ_KEY },
        { fetch: f.fetch },
      ).chat(req("deepseek-chat"));
      expect(f.seen[0]?.url).toBe("https://api.deepseek.com/chat/completions");
      expect(f.seen[0]?.body.max_completion_tokens).toBe(9);
      expect(f.seen[0]?.body).not.toHaveProperty("max_tokens");
    } finally {
      undo();
    }
  });

  test("a loopback endpoint without api_key_env sends no auth header at all", async () => {
    stubSdkEnv();
    const undo = registerEndpoints({ local: { baseUrl: "http://127.0.0.1:8080/v1" } });
    try {
      const f = recordingFetch();
      const p = createEndpointProvider("local", {}, { fetch: f.fetch });
      await both(p, f.seen, req("qwen2.5-coder"));
      for (const s of f.seen) {
        expect(s.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
        expectOwnAuth(s.headers, "none");
        // Nothing key-like anywhere in the headers.
        expect([...s.headers.values()].join(" ")).not.toMatch(/Bearer|sk-/);
      }
    } finally {
      undo();
    }
  });

  test("a missing key is provider_auth_missing naming the api_key_env variable", () => {
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
    });
    try {
      expect(() => createEndpointProvider("groq", {})).toThrowError(
        expect.objectContaining({
          code: "provider_auth_missing",
          message: "GROQ_API_KEY is not set",
        }),
      );
    } finally {
      undo();
    }
  });

  test("a non-loopback endpoint without api_key_env fails closed; an unregistered one is provider_unknown", () => {
    const undo = registerEndpoints({ open: { baseUrl: "https://llm.example.com/v1" } });
    try {
      expect(() => createEndpointProvider("open", {})).toThrowError(
        expect.objectContaining({ code: "provider_auth_missing" }),
      );
    } finally {
      undo();
    }
    expect(() => createEndpointProvider("nope", {})).toThrowError(
      expect.objectContaining({ code: "provider_unknown" }),
    );
  });

  test("tool calls round-trip, plain and streamed", async () => {
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
    });
    try {
      const call = { id: "a", type: "function", function: { name: "t", arguments: '{"k":[1,2]}' } };
      const f = recordingFetch((body) =>
        body.stream
          ? new Response(
              openaiSSE(
                openaiChunks({
                  text: ["look"],
                  toolCalls: [{ id: "a", name: "t", argPieces: ['{"k":', "[1,2]}"] }],
                  finish: "tool_calls",
                  usage,
                }),
              ),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            )
          : new Response(
              JSON.stringify({
                ...completion,
                choices: [
                  {
                    index: 0,
                    finish_reason: "tool_calls",
                    message: { role: "assistant", content: "look", tool_calls: [call] },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
      );
      const p = createEndpointProvider("groq", { GROQ_API_KEY: GROQ_KEY }, { fetch: f.fetch });
      const r: ChatRequest = {
        ...req("llama-3.3-70b"),
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "z", name: "t", arguments: { x: 1 } }],
          },
          { role: "tool", content: "r1", toolCallId: "z" },
        ],
      };
      const expected = {
        message: { text: "look", toolCalls: [{ id: "a", name: "t", arguments: { k: [1, 2] } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 11, outputTokens: 7 },
      };
      await expect(p.chat(r)).resolves.toEqual(expected);
      const deltas: string[] = [];
      await expect(p.chat({ ...r, onDelta: (d) => deltas.push(d) })).resolves.toEqual(expected);
      expect(deltas).toEqual(["look"]);
      expect(f.seen[0]?.body.messages).toEqual([
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "z", type: "function", function: { name: "t", arguments: '{"x":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "z", content: "r1" },
      ]);
    } finally {
      undo();
    }
  });
});

describe("OPENAI_CUSTOM_HEADERS never reaches Azure, Gemini or endpoints", () => {
  test("from process.env or the env passed in: each client sends exactly its own credential", async () => {
    stubSdkEnv();
    const passed = { OPENAI_CUSTOM_HEADERS: "X-Bar: 2\nAuthorization: Bearer passedenvtoken00000" };
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
      local: { baseUrl: "http://localhost:11434/v1" },
    });
    try {
      const cases: [
        (f: typeof globalThis.fetch) => OpenAIProvider,
        Parameters<typeof expectOwnAuth>[1],
      ][] = [
        [
          (fetch) =>
            createAzureProvider(
              { azure: { endpoint: "https://res.openai.azure.com", apiVersion: "v" } },
              { ...passed, AZURE_OPENAI_API_KEY: AZURE_KEY },
              { fetch },
            ),
          { apiKey: AZURE_KEY },
        ],
        [
          (fetch) => createGeminiProvider({ ...passed, GEMINI_API_KEY: GEMINI_KEY }, { fetch }),
          { bearer: GEMINI_KEY },
        ],
        [
          (fetch) =>
            createEndpointProvider("groq", { ...passed, GROQ_API_KEY: GROQ_KEY }, { fetch }),
          { bearer: GROQ_KEY },
        ],
        [(fetch) => createEndpointProvider("local", passed, { fetch }), "none"],
      ];
      for (const [make, auth] of cases) {
        const f = recordingFetch();
        await both(make(f.fetch), f.seen, req("m"));
        for (const s of f.seen) {
          expectOwnAuth(s.headers, auth);
          expect(s.headers.has("x-bar")).toBe(false);
          expect([...s.headers.values()].join(" ")).not.toContain("passedenvtoken");
        }
      }
    } finally {
      undo();
    }
  });

  test("the plain openai provider still applies OPENAI_CUSTOM_HEADERS (unchanged)", async () => {
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "x-foo: 1");
    const p = createProvider(parseModelRef("openai:gpt-5"), {
      OPENAI_API_KEY: "sk-test-openai-000",
    });
    expect(p).toBeInstanceOf(OpenAIProvider);
    const { default: OpenAI } = await import("openai");
    const f = recordingFetch();
    const client = new OpenAI({ apiKey: "sk-test-openai-000", fetch: f.fetch, maxRetries: 0 });
    await new OpenAIProvider("sk-test-openai-000", client).chat(req("gpt-5"));
    expect(f.seen[0]?.headers.get("x-foo")).toBe("1");
  });
});

describe("errors never carry the key", () => {
  const echo = (key: string) => () =>
    new Response(JSON.stringify({ error: { message: `invalid key ${key} given` } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  test("azure, gemini and endpoint keys are redacted literally", async () => {
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
    });
    try {
      const providers: [OpenAIProvider, string, string][] = [
        [
          createAzureProvider(
            { azure: { endpoint: "https://res.openai.azure.com", apiVersion: "v" } },
            { AZURE_OPENAI_API_KEY: AZURE_KEY },
            { fetch: recordingFetch(echo(AZURE_KEY)).fetch },
          ),
          AZURE_KEY,
          "azure",
        ],
        [
          createGeminiProvider(
            { GEMINI_API_KEY: GEMINI_KEY },
            { fetch: recordingFetch(echo(GEMINI_KEY)).fetch },
          ),
          GEMINI_KEY,
          "gemini",
        ],
        [
          createEndpointProvider(
            "groq",
            { GROQ_API_KEY: GROQ_KEY },
            { fetch: recordingFetch(echo(GROQ_KEY)).fetch },
          ),
          GROQ_KEY,
          "groq",
        ],
      ];
      for (const [p, key, name] of providers) {
        const err = await p.chat(req("m")).catch((e) => e);
        expect(err).toMatchObject({ code: "provider_error" });
        expect(err.message).toMatch(new RegExp(`^${name} request failed`));
        expect(err.message).not.toContain(key);
        expect(err.message).toContain("[redacted]");
      }
    } finally {
      undo();
    }
  });
});

describe("createProvider wires azure, gemini and endpoints", () => {
  test("creates each with its credentials and settings; missing ones are provider_auth_missing", () => {
    const undo = registerEndpoints({
      groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
    });
    try {
      const settings = { azure: { endpoint: "https://res.openai.azure.com", apiVersion: "v" } };
      expect(
        createProvider(parseModelRef("azure:d"), { AZURE_OPENAI_API_KEY: AZURE_KEY }, settings),
      ).toBeInstanceOf(OpenAIProvider);
      expect(
        createProvider(parseModelRef("gemini:gemini-2.5-pro"), { GEMINI_API_KEY: GEMINI_KEY }),
      ).toBeInstanceOf(OpenAIProvider);
      expect(createProvider(parseModelRef("groq:m"), { GROQ_API_KEY: GROQ_KEY })).toBeInstanceOf(
        OpenAIProvider,
      );
      for (const ref of ["azure:d", "gemini:gemini-2.5-pro", "groq:m"]) {
        expect(() => createProvider(parseModelRef(ref), {}, settings)).toThrowError(
          expect.objectContaining({ code: "provider_auth_missing" }),
        );
      }
    } finally {
      undo();
    }
  });
});

describe("context windows", () => {
  const w = (window: number, source = "table") => ({ window, source, provisional: true });

  test("azure uses the openai table by deployment name, else the default", async () => {
    await expect(contextWindow(parseModelRef("azure:gpt-5"))).resolves.toEqual(w(272_000));
    await expect(contextWindow(parseModelRef("azure:my-deploy"))).resolves.toEqual(
      w(DEFAULT_CONTEXT_WINDOW, "default"),
    );
  });

  test("gemini table: gemini-2.5 and later and any gemini- id are 1M, else the default", async () => {
    for (const m of [
      "gemini-2.5-pro",
      "gemini-3-flash",
      "gemini-1.5-pro",
      "models/gemini-2.5-pro",
      "Gemini-2.5-Pro",
    ]) {
      await expect(contextWindow({ provider: "gemini", model: m })).resolves.toEqual(w(1_048_576));
    }
    await expect(contextWindow({ provider: "gemini", model: "learnlm-2.0" })).resolves.toEqual(
      w(DEFAULT_CONTEXT_WINDOW, "default"),
    );
  });

  test("endpoints: context_window, else the derived family's table, else the default", async () => {
    const undo = registerEndpoints({
      big: { baseUrl: "https://a.example.com/v1", apiKeyEnv: "K", contextWindow: 131_072 },
      or: { baseUrl: "https://b.example.com/v1", apiKeyEnv: "K" },
    });
    try {
      await expect(contextWindow({ provider: "big", model: "anything" })).resolves.toEqual(
        w(131_072, "model"),
      );
      const cases: [string, number, string][] = [
        ["anthropic/claude-opus-5-5", 200_000, "table"],
        ["openai/gpt-5", 272_000, "table"],
        ["gpt-4o", 128_000, "table"],
        ["google/gemini-2.5-pro", 1_048_576, "table"],
        ["meta-llama/llama-3.3-70b", DEFAULT_CONTEXT_WINDOW, "default"],
        // A router id has no derivable family: the default, never a throw.
        ["openrouter/auto", DEFAULT_CONTEXT_WINDOW, "default"],
      ];
      for (const [model, window, source] of cases) {
        await expect(contextWindow({ provider: "or", model })).resolves.toEqual(w(window, source));
      }
    } finally {
      undo();
    }
  });
});
