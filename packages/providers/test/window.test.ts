import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type ChatMessage,
  contextWindow,
  DEFAULT_CONTEXT_WINDOW,
  estimateTokens,
  type ModelRef,
  OLLAMA_PROVISIONAL_WINDOW_CAP,
  OLLAMA_TRUNCATION_HINT,
  parseNumCtx,
  refreshContextWindow,
  suspectTruncation,
  TokenEstimator,
  WINDOW_TABLE,
} from "../src/index.js";

type Reply = { status: number; body: unknown } | "destroy";

let server: http.Server;
let base: string;
let routes: Record<string, Reply>;
let hits: string[];
let requests: { path: string; method: string; body: string }[];

const ok = (body: unknown): Reply => ({ status: 200, body });

beforeEach(async () => {
  hits = [];
  requests = [];
  // Shapes follow a real Ollama 0.40.x server; extra fields are ignored by the schemas.
  routes = {
    "/api/tags": ok({
      models: [
        {
          name: "tiny:1b",
          model: "tiny:1b",
          modified_at: "2026-11-01T10:00:00Z",
          size: 815_319_791,
          digest: "sha256:tags",
          details: { format: "gguf", family: "llama", context_length: 131072 },
        },
      ],
    }),
    "/api/ps": ok({ models: [] }),
    "/api/show": ok({
      license: "...",
      modelfile: "FROM tiny",
      template: "{{ .Prompt }}",
      details: { format: "gguf", family: "llama" },
      model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
      capabilities: ["completion", "tools"],
    }),
  };
  server = http.createServer((req, res) => {
    const path = req.url ?? "";
    hits.push(path);
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      requests.push({ path, method: req.method ?? "", body });
      const r = routes[path];
      if (r === undefined) {
        res.writeHead(404);
        return void res.end("{}");
      }
      if (r === "destroy") return void req.socket.destroy();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const tiny: ModelRef = { provider: "ollama", model: "tiny:1b" };

describe("contextWindow: ollama", () => {
  test("a loaded model uses /api/ps context_length (source loaded)", async () => {
    routes["/api/ps"] = ok({
      models: [
        {
          name: "tiny:1b",
          model: "tiny:1b",
          size: 1_200_000_000,
          digest: "sha256:ps",
          details: { family: "llama" },
          expires_at: "2026-11-26T10:05:00Z",
          size_vram: 1_200_000_000,
          context_length: 16384,
        },
      ],
    });
    routes["/api/show"] = ok({
      parameters: "num_ctx 8192",
      model_info: { "llama.context_length": 131072 },
    });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: 16384,
      source: "loaded",
      provisional: false,
      digest: "sha256:ps",
    });
  });

  test("a bare name matches the loaded :latest tag", async () => {
    routes["/api/ps"] = ok({
      models: [{ name: "tiny:latest", digest: "sha256:ps", context_length: 4096 }],
    });
    await expect(
      contextWindow({ provider: "ollama", model: "tiny" }, { baseUrl: base }),
    ).resolves.toMatchObject({ window: 4096, source: "loaded" });
  });

  test("not loaded: num_ctx from /api/show parameters beats model_info", async () => {
    routes["/api/show"] = ok({
      parameters:
        'stop                           "<|end|>"\nnum_ctx                        8192\ntemperature                    0.7',
      model_info: { "llama.context_length": 131072 },
    });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: 8192,
      source: "model",
      provisional: true,
      digest: "sha256:tags",
    });
  });

  test("not loaded, no num_ctx: model_info *.context_length", async () => {
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: 131072,
      source: "model",
      provisional: true,
      digest: "sha256:tags",
    });
    const show = requests.find((r) => r.path === "/api/show");
    expect(show?.method).toBe("POST");
    expect(JSON.parse(show?.body ?? "{}")).toEqual({ model: "tiny:1b" });
  });

  test("a provisional model-source window is capped (the server picks the runtime context)", async () => {
    routes["/api/show"] = ok({ model_info: { "qwen3.context_length": 262144 } });
    expect(OLLAMA_PROVISIONAL_WINDOW_CAP).toBe(131072);
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      window: 131072,
      source: "model",
      provisional: true,
    });
  });

  test("a loaded window is not capped", async () => {
    routes["/api/ps"] = ok({
      models: [{ name: "tiny:1b", digest: "sha256:ps", context_length: 262144 }],
    });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      window: 262144,
      source: "loaded",
      provisional: false,
    });
  });

  test("a loaded entry without context_length falls through to /api/show", async () => {
    routes["/api/ps"] = ok({ models: [{ name: "tiny:1b", digest: "sha256:ps" }] });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      window: 131072,
      source: "model",
    });
  });

  test("/api/ps failing still reads /api/show", async () => {
    routes["/api/ps"] = { status: 500, body: { error: "boom" } };
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      window: 131072,
      source: "model",
    });
  });

  test("a model with no info gives default, keeping the digest", async () => {
    routes["/api/show"] = ok({ model_info: {} });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      source: "default",
      provisional: true,
      digest: "sha256:tags",
    });
  });

  test("a model that is not pulled gives default", async () => {
    routes["/api/tags"] = ok({ models: [{ name: "other:1b", digest: "x" }] });
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      source: "default",
      provisional: true,
    });
  });

  test("an unreachable server gives default and never throws", async () => {
    routes = { "/api/tags": "destroy", "/api/ps": "destroy", "/api/show": "destroy" };
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      source: "default",
      provisional: true,
    });
  });

  test("garbage JSON gives default", async () => {
    routes = {
      "/api/tags": ok("nope"),
      "/api/ps": ok("nope"),
      "/api/show": ok("nope"),
    };
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      source: "default",
    });
  });

  test("the base URL comes from OLLAMA_HOST when no baseUrl is given", async () => {
    await expect(contextWindow(tiny, { env: { OLLAMA_HOST: base } })).resolves.toMatchObject({
      window: 131072,
      source: "model",
    });
    expect(hits).toContain("/api/show");
  });
});

describe("refreshContextWindow", () => {
  test("after a turn, re-reads /api/ps and returns the loaded context", async () => {
    await expect(contextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      provisional: true,
    });
    routes["/api/ps"] = ok({
      models: [{ name: "tiny:1b", digest: "sha256:ps", context_length: 4096 }],
    });
    hits = [];
    await expect(refreshContextWindow(tiny, { baseUrl: base })).resolves.toEqual({
      window: 4096,
      source: "loaded",
      provisional: false,
      digest: "sha256:ps",
    });
    expect(hits).toEqual(["/api/ps"]);
  });
  test("not loaded: same as contextWindow", async () => {
    await expect(refreshContextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      window: 131072,
      source: "model",
      provisional: true,
    });
  });
  test("an unreachable server gives default", async () => {
    routes = { "/api/tags": "destroy", "/api/ps": "destroy", "/api/show": "destroy" };
    await expect(refreshContextWindow(tiny, { baseUrl: base })).resolves.toMatchObject({
      source: "default",
    });
  });
  test("other providers: same as contextWindow; invalid refs still throw", async () => {
    await expect(
      refreshContextWindow({ provider: "anthropic", model: "claude-sonnet-4-5" }),
    ).resolves.toEqual({ window: 200_000, source: "table", provisional: true });
    await expect(refreshContextWindow({ provider: "ollama", model: "" })).rejects.toMatchObject({
      code: "context_window_unknown",
    });
  });
});

describe("parseNumCtx", () => {
  test("reads num_ctx from the parameters text block", () => {
    expect(parseNumCtx("num_ctx 4096")).toBe(4096);
    expect(parseNumCtx("temperature 1\nnum_ctx    32768\n")).toBe(32768);
  });
  test("absent, malformed or non-positive gives null", () => {
    expect(parseNumCtx(undefined)).toBeNull();
    expect(parseNumCtx("temperature 1")).toBeNull();
    expect(parseNumCtx("num_ctx lots")).toBeNull();
    expect(parseNumCtx("num_ctx 0")).toBeNull();
    expect(parseNumCtx("my_num_ctx 99")).toBeNull();
  });
});

describe("contextWindow: table providers", () => {
  test("a known anthropic model comes from the table", async () => {
    await expect(
      contextWindow({ provider: "anthropic", model: "claude-sonnet-4-5" }),
    ).resolves.toEqual({ window: 200_000, source: "table", provisional: true });
    await expect(
      contextWindow({ provider: "anthropic", model: "claude-sonnet-5-20261001" }),
    ).resolves.toMatchObject({ window: 200_000, source: "table" });
  });
  test("openai uses the longest matching prefix", async () => {
    await expect(
      contextWindow({ provider: "openai", model: "gpt-4o-mini-2024-07-18" }),
    ).resolves.toEqual({ window: 128_000, source: "table", provisional: true });
    await expect(contextWindow({ provider: "openai", model: "gpt-4-0613" })).resolves.toEqual({
      window: 8_192,
      source: "table",
      provisional: true,
    });
    await expect(contextWindow({ provider: "openai", model: "gpt-4-32k" })).resolves.toMatchObject({
      window: 32_768,
    });
  });
  test("an unknown model gets the conservative default", async () => {
    await expect(contextWindow({ provider: "openai", model: "mystery-model" })).resolves.toEqual({
      window: 32_768,
      source: "default",
      provisional: true,
    });
    expect(DEFAULT_CONTEXT_WINDOW).toBe(32_768);
  });
  test("the table only holds positive integer windows", () => {
    for (const rows of Object.values(WINDOW_TABLE)) {
      for (const [prefix, w] of rows) {
        expect(prefix.length).toBeGreaterThan(0);
        expect(Number.isInteger(w) && w > 0).toBe(true);
      }
    }
  });
});

describe("contextWindow: faux", () => {
  test("configurable through the option", async () => {
    await expect(
      contextWindow({ provider: "faux", model: "m" }, { fauxWindow: 4096 }),
    ).resolves.toEqual({ window: 4096, source: "model", provisional: true });
  });
  test("configurable through REWIRE_FAUX_WINDOW", async () => {
    await expect(
      contextWindow({ provider: "faux", model: "m" }, { env: { REWIRE_FAUX_WINDOW: "2048" } }),
    ).resolves.toEqual({ window: 2048, source: "model", provisional: true });
  });
  test("unconfigured or invalid gives default", async () => {
    await expect(
      contextWindow({ provider: "faux", model: "m" }, { env: { REWIRE_FAUX_WINDOW: "x" } }),
    ).resolves.toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: "default", provisional: true });
  });
});

describe("contextWindow: invalid ref", () => {
  test("an unknown provider throws context_window_unknown", async () => {
    await expect(
      contextWindow({ provider: "nope", model: "m" } as unknown as ModelRef),
    ).rejects.toMatchObject({ code: "context_window_unknown" });
  });
  test("an empty model throws context_window_unknown", async () => {
    await expect(contextWindow({ provider: "anthropic", model: "" })).rejects.toMatchObject({
      code: "context_window_unknown",
    });
  });
});

describe("estimateTokens", () => {
  test("chars/4 over system and message content, rounded up", () => {
    expect(estimateTokens([], "")).toBe(0);
    const a = estimateTokens([{ role: "user", content: "x".repeat(400) }], "y".repeat(400));
    expect(a).toBeGreaterThanOrEqual(200);
    expect(a).toBeLessThan(215);
  });
  test("counts tool-call arguments and tool results", () => {
    const plain: ChatMessage[] = [{ role: "assistant", content: "" }];
    const withCall: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "p".repeat(800) } }],
      },
      { role: "tool", toolCallId: "c1", content: "r".repeat(800) },
    ];
    expect(estimateTokens(withCall, "") - estimateTokens(plain, "")).toBeGreaterThanOrEqual(400);
  });
  test("counts tool specs when given", () => {
    const tools = [{ name: "t", description: "d".repeat(400), inputSchema: {} }];
    expect(estimateTokens([], "", tools)).toBeGreaterThanOrEqual(100);
  });
});

describe("TokenEstimator", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(4000) }];

  test("starts uncorrected", () => {
    const e = new TokenEstimator();
    expect(e.ratio).toBe(1);
    expect(e.estimate("", msgs)).toBe(estimateTokens(msgs, ""));
  });

  test("the first observation sets the ratio, later ones move it as an EMA", () => {
    const e = new TokenEstimator();
    const est = e.estimate("", msgs);
    e.observe(est, Math.round(est * 1.5));
    expect(e.ratio).toBeCloseTo(1.5, 2);
    expect(e.estimate("", msgs)).toBeCloseTo(est * 1.5, -1);
    // The corrected estimate was exact: the ratio stays put.
    const est2 = e.estimate("", msgs);
    e.observe(est2, est2);
    expect(e.ratio).toBeCloseTo(1.5, 2);
    // Actual came in below: the ratio moves down, but only partway.
    const est3 = e.estimate("", msgs);
    e.observe(est3, Math.round(est3 / 1.5));
    expect(e.ratio).toBeLessThan(1.5);
    expect(e.ratio).toBeGreaterThan(1);
  });

  test("the ratio is clamped to 0.5..2.0", () => {
    const hi = new TokenEstimator();
    hi.observe(100, 390);
    expect(hi.ratio).toBe(2);
    const lo = new TokenEstimator();
    lo.observe(1_000, 300);
    expect(lo.ratio).toBe(0.5);
  });

  test("samples with actual/estimated outside 0.25..4 are ignored", () => {
    const e = new TokenEstimator();
    e.observe(100, 401);
    e.observe(1_000, 249);
    expect(e.ratio).toBe(1);
    e.observe(100, 400);
    expect(e.ratio).toBe(2);
  });

  test("a truncated large prompt does not drag the ratio down", () => {
    // 60K chars sent to a 4K-context server: Ollama truncates and reports ~4000 tokens.
    const e = new TokenEstimator();
    e.observe(15_000, 4_000);
    expect(e.ratio).toBe(1);
    // 0.55 is inside 0.25..4 but on a large prompt it is truncation, not a correction.
    e.observe(15_000, 8_250);
    expect(e.ratio).toBe(1);
    expect(e.suspectTruncation(15_000, 8_250)).toBe(true);
  });
});

describe("suspectTruncation", () => {
  test("true when actual < 0.6 x estimated on prompts over 8K", () => {
    expect(suspectTruncation(15_000, 4_000)).toBe(true);
    expect(suspectTruncation(10_000, 5_999)).toBe(true);
  });
  test("false at or above 0.6, or on small prompts, or on bad input", () => {
    expect(suspectTruncation(10_000, 6_000)).toBe(false);
    expect(suspectTruncation(15_000, 14_000)).toBe(false);
    expect(suspectTruncation(8_192, 100)).toBe(false);
    expect(suspectTruncation(Number.NaN, 100)).toBe(false);
    expect(suspectTruncation(15_000, Number.NaN)).toBe(false);
  });
  test("the hint names the two remedies", () => {
    expect(OLLAMA_TRUNCATION_HINT).toContain("OLLAMA_CONTEXT_LENGTH");
    expect(OLLAMA_TRUNCATION_HINT).toContain("num_ctx");
  });

  test("zero, negative or non-finite observations are ignored (faux reports 0)", () => {
    const e = new TokenEstimator();
    e.observe(100, 0);
    e.observe(0, 100);
    e.observe(Number.NaN, 100);
    e.observe(100, Number.POSITIVE_INFINITY);
    expect(e.ratio).toBe(1);
  });

  test("a starting ratio can be supplied and is clamped", () => {
    expect(new TokenEstimator({ ratio: 1.2 }).ratio).toBe(1.2);
    expect(new TokenEstimator({ ratio: 9 }).ratio).toBe(2);
  });
});

describe("contextWindow: endpoints", () => {
  test("an unregistered endpoint throws context_window_unknown", async () => {
    await expect(contextWindow({ provider: "groq", model: "m" })).rejects.toMatchObject({
      code: "context_window_unknown",
    });
  });
});
