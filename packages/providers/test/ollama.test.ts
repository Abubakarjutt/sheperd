import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertRoleFit,
  createProvider,
  FITNESS_TEST_VERSION,
  getModelInfo,
  MIN_OLLAMA_VERSION,
  normalizeOllamaHost,
  OLLAMA_IDLE_TIMEOUT_MS,
  OLLAMA_TIMEOUT_ENV,
  OllamaProvider,
  type OllamaTimeout,
  ollamaChatTimeoutMs,
  probeOllama,
  resolveOllamaTimeout,
} from "../src/index.js";
import { openaiChunks, openaiSSE } from "./sse.js";

type Mock = {
  version: string;
  capabilities: string[];
  models: { name: string; digest: string }[];
  showStatus: number;
  tagsBody: string | null;
  /**
   * Called for each chat request; returns the OpenAI-style body, "destroy" to drop the socket,
   * "hang", or `{ __sse, after }` to stream SSE text and then end, hang or destroy the socket.
   */
  chat: (body: Record<string, unknown>) => unknown;
};

const structuredOk = () => ({
  choices: [{ finish_reason: "stop", message: { content: '{"ok":true,"n":3}' } }],
});
const toolCall = (value: unknown) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ value }) },
          },
        ],
      },
    },
  ],
});
const goodChat = (body: Record<string, unknown>) =>
  body.tools ? toolCall("ping") : structuredOk();

let server: http.Server;
let base: string;
let mock: Mock;
let hits: Record<string, number>;
let chatBodies: Record<string, unknown>[];
let cache: string;

beforeEach(async () => {
  mock = {
    version: "0.9.0",
    capabilities: ["completion", "tools"],
    models: [{ name: "tiny:1b", digest: "sha256:abc" }],
    showStatus: 200,
    tagsBody: null,
    chat: goodChat,
  };
  hits = {};
  chatBodies = [];
  cache = join(await mkdtemp(join(tmpdir(), "rewire-fit-")), "cache");
  server = http.createServer((req, res) => {
    const path = req.url ?? "";
    hits[path] = (hits[path] ?? 0) + 1;
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (path === "/api/version") return json(200, { version: mock.version });
      if (path === "/api/show") {
        return mock.showStatus === 200
          ? json(200, {
              capabilities: mock.capabilities,
              model_info: { "llama.context_length": 8192 },
            })
          : json(mock.showStatus, { error: "boom" });
      }
      if (path === "/api/tags") return json(200, mock.tagsBody ?? { models: mock.models });
      if (path === "/v1/chat/completions") {
        const body = JSON.parse(raw) as Record<string, unknown>;
        chatBodies.push(body);
        const out = mock.chat(body);
        if (out === "destroy") return void req.socket.destroy();
        if (out === "hang") return;
        if (typeof out === "object" && out !== null && "__delayMs" in out) {
          const { __delayMs } = out as { __delayMs: number };
          setTimeout(() => json(200, structuredOk()), __delayMs);
          return;
        }
        if (typeof out === "object" && out !== null && "__drip" in out) {
          // One SSE event every `everyMs`, then end (or hang, to go silent).
          const { __drip, everyMs, after } = out as {
            __drip: string[];
            everyMs: number;
            after?: "end" | "hang";
          };
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const tick = setInterval(() => {
            if (res.destroyed) return clearInterval(tick);
            const ev = __drip[i++];
            if (ev !== undefined) return void res.write(ev);
            clearInterval(tick);
            if (after !== "hang") res.end();
          }, everyMs);
          return;
        }
        if (typeof out === "object" && out !== null && "__sse" in out) {
          const { __sse, after } = out as { __sse: string; after?: "end" | "hang" | "destroy" };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(__sse);
          if (after === "destroy") setTimeout(() => req.socket.destroy(), 20);
          else if (after !== "hang") res.end();
          return;
        }
        if (typeof out === "object" && out !== null && "__status" in out) {
          return json((out as { __status: number }).__status, { error: "server error" });
        }
        return json(200, out);
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const ref = { provider: "ollama", model: "tiny:1b" } as const;
const chats = () => hits["/v1/chat/completions"] ?? 0;
const readCache = async () => JSON.parse(await readFile(join(cache, "fitness.json"), "utf8"));
const fit = (role: Parameters<typeof assertRoleFit>[1]) =>
  assertRoleFit(ref, role, cache, { baseUrl: base });

describe("probeOllama", () => {
  test("unreachable_server_message", async () => {
    await expect(probeOllama("http://127.0.0.1:1")).rejects.toMatchObject({
      code: "ollama_unreachable",
      message: "Ollama is not reachable at http://127.0.0.1:1",
      hint: "Start it with: ollama serve",
    });
  });
  test("returns version", async () => {
    mock.version = "0.9.0";
    await expect(probeOllama(base)).resolves.toEqual({ version: "0.9.0" });
  });
  test("MIN_OLLAMA_VERSION is a plain x.y.z", () => {
    expect(MIN_OLLAMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test("too old is rejected", async () => {
    mock.version = "0.3.0";
    await expect(probeOllama(base)).rejects.toMatchObject({ code: "ollama_too_old" });
  });
  test("version compare is numeric per component (0.10.0 > 0.9.0, 0.6.10 > 0.6.4)", async () => {
    for (const v of ["0.10.0", "0.40.14", "1.0.0"]) {
      mock.version = v;
      await expect(probeOllama(base)).resolves.toEqual({ version: v });
    }
  });
  test("pre-release suffix is ignored (rc of the minimum counts as the minimum)", async () => {
    mock.version = `${MIN_OLLAMA_VERSION}-rc1`;
    await expect(probeOllama(base)).resolves.toBeTruthy();
    mock.version = "0.3.0-rc1";
    await expect(probeOllama(base)).rejects.toMatchObject({ code: "ollama_too_old" });
  });
  test("garbage version fails closed", async () => {
    mock.version = "banana";
    await expect(probeOllama(base)).rejects.toMatchObject({ code: "provider_bad_response" });
  });
});

describe("getModelInfo", () => {
  test("returns capabilities, context length and digest", async () => {
    await expect(getModelInfo(base, "tiny:1b")).resolves.toEqual({
      capabilities: ["completion", "tools"],
      contextLength: 8192,
      digest: "sha256:abc",
    });
  });
  test("model not pulled gives pull hint", async () => {
    mock.models = [{ name: "other:1b", digest: "x" }];
    await expect(getModelInfo(base, "tiny:1b")).rejects.toMatchObject({
      code: "model_not_pulled",
      hint: expect.stringContaining("ollama pull tiny:1b"),
    });
  });
  test("non-2xx from show fails closed", async () => {
    mock.showStatus = 500;
    await expect(getModelInfo(base, "tiny:1b")).rejects.toMatchObject({
      code: "provider_bad_response",
    });
  });
  test("unparseable tags fails closed", async () => {
    mock.tagsBody = "not json";
    await expect(getModelInfo(base, "tiny:1b")).rejects.toMatchObject({
      code: "provider_bad_response",
    });
  });
});

describe("normalizeOllamaHost", () => {
  test("defaults, scheme, trailing slash and default port", () => {
    expect(normalizeOllamaHost(undefined)).toBe("http://localhost:11434");
    expect(normalizeOllamaHost("")).toBe("http://localhost:11434");
    expect(normalizeOllamaHost("0.0.0.0")).toBe("http://0.0.0.0:11434");
    expect(normalizeOllamaHost("myhost")).toBe("http://myhost:11434");
    expect(normalizeOllamaHost("myhost:1234")).toBe("http://myhost:1234");
    expect(normalizeOllamaHost("http://myhost")).toBe("http://myhost");
    expect(normalizeOllamaHost("https://x.example/")).toBe("https://x.example");
    expect(normalizeOllamaHost("http://a:1///")).toBe("http://a:1");
  });
  test("scheme-less host with a path is rejected", () => {
    expect(() => normalizeOllamaHost("myhost/api")).toThrowError(
      expect.objectContaining({ code: "ollama_host_invalid" }),
    );
    expect(() => normalizeOllamaHost("myhost:1234/api")).toThrowError(
      expect.objectContaining({ code: "ollama_host_invalid" }),
    );
  });
  test("IPv6 forms", () => {
    expect(normalizeOllamaHost("[::1]")).toBe("http://[::1]:11434");
    expect(normalizeOllamaHost("[::1]:1234")).toBe("http://[::1]:1234");
    expect(normalizeOllamaHost("::1")).toBe("http://[::1]:11434");
    expect(normalizeOllamaHost("http://[::1]")).toBe("http://[::1]");
  });
});

describe("ollamaChatTimeoutMs", () => {
  test("unset or blank is the 900s default", () => {
    expect(OLLAMA_TIMEOUT_ENV).toBe("REWIRE_OLLAMA_TIMEOUT_S");
    expect(ollamaChatTimeoutMs({})).toBe(900_000);
    expect(ollamaChatTimeoutMs({ REWIRE_OLLAMA_TIMEOUT_S: "  " })).toBe(900_000);
  });
  test("whole seconds from 1 to 86400", () => {
    expect(ollamaChatTimeoutMs({ REWIRE_OLLAMA_TIMEOUT_S: "900" })).toBe(900_000);
    expect(ollamaChatTimeoutMs({ REWIRE_OLLAMA_TIMEOUT_S: " 1 " })).toBe(1_000);
    expect(ollamaChatTimeoutMs({ REWIRE_OLLAMA_TIMEOUT_S: "86400" })).toBe(86_400_000);
  });
  test.each(["0", "-5", "1.5", "15m", "86401", "abc", "1e3"])("%j is refused", (v) => {
    expect(() => ollamaChatTimeoutMs({ REWIRE_OLLAMA_TIMEOUT_S: v })).toThrow(
      expect.objectContaining({ code: "ollama_timeout_invalid" }),
    );
  });
});

describe("resolveOllamaTimeout", () => {
  const toml = { ollama: { timeoutS: 1200 } };
  test("env beats models.toml beats the default, and says which", () => {
    expect(resolveOllamaTimeout({ REWIRE_OLLAMA_TIMEOUT_S: "60" }, toml)).toEqual({
      ms: 60_000,
      source: "env",
    });
    expect(resolveOllamaTimeout({}, toml)).toEqual({ ms: 1_200_000, source: "models.toml" });
    expect(resolveOllamaTimeout({ REWIRE_OLLAMA_TIMEOUT_S: " " }, toml)).toEqual({
      ms: 1_200_000,
      source: "models.toml",
    });
    expect(resolveOllamaTimeout({})).toEqual({ ms: 900_000, source: "default" });
    expect(resolveOllamaTimeout({}, {})).toEqual({ ms: 900_000, source: "default" });
  });
  test("an invalid env value is refused even when models.toml sets one", () => {
    expect(() => resolveOllamaTimeout({ REWIRE_OLLAMA_TIMEOUT_S: "15m" }, toml)).toThrow(
      expect.objectContaining({ code: "ollama_timeout_invalid" }),
    );
  });
  test("createProvider takes models.toml's [providers.ollama] timeout_s", async () => {
    mock.chat = () => "hang";
    const p = createProvider(ref, { OLLAMA_HOST: base }, { ollama: { timeoutS: 1 } });
    const err = await p
      .chat({ model: "tiny:1b", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after 1s/);
    expect(err.message).toMatch(/models\.toml/);
  });
});

const tmo = (ms: number, source: OllamaTimeout["source"] = "env"): OllamaTimeout => ({
  ms,
  source,
});

describe("OllamaProvider", () => {
  test("sends max_tokens (the field Ollama's OpenAI compat honors), not max_completion_tokens", async () => {
    const p = new OllamaProvider(base);
    const r = await p.chat({
      model: "tiny:1b",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 77,
    });
    expect(r.message.text).toContain("ok");
    expect(chatBodies[0]).toMatchObject({ max_tokens: 77 });
    expect(chatBodies[0]).not.toHaveProperty("max_completion_tokens");
  });
  test("createProvider honors OLLAMA_HOST without a scheme", async () => {
    const hostPort = base.replace("http://", "");
    const p = createProvider(ref, { OLLAMA_HOST: hostPort });
    await p.chat({ model: "tiny:1b", system: "s", messages: [], maxTokens: 5 });
    expect(chats()).toBe(1);
  });
  test("invalid tool-call arguments fail closed with provider_bad_tool_args", async () => {
    mock.chat = () => ({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{ id: "c", type: "function", function: { name: "echo", arguments: "{" } }],
          },
        },
      ],
    });
    const p = new OllamaProvider(base);
    await expect(
      p.chat({ model: "tiny:1b", system: "s", messages: [], maxTokens: 5 }),
    ).rejects.toMatchObject({
      code: "provider_bad_tool_args",
      message: expect.stringContaining("ollama"),
    });
  });
  test("connection failure maps to ollama_unreachable", async () => {
    const p = new OllamaProvider("http://127.0.0.1:1");
    await expect(
      p.chat({ model: "m", system: "s", messages: [], maxTokens: 5 }),
    ).rejects.toMatchObject({ code: "ollama_unreachable" });
  });
  test("the reply timeout comes from the constructor and the error names the variable", async () => {
    mock.chat = () => "hang";
    const p = new OllamaProvider(base, tmo(100));
    const err = await p
      .chat({ model: "m", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after 100ms/);
    expect(err.message).toMatch(/REWIRE_OLLAMA_TIMEOUT_S/);
    expect(err.hint).toMatch(/REWIRE_OLLAMA_TIMEOUT_S/);
  });
  test("a non-streamed reply keeps one total timeout, even while the server is working", async () => {
    mock.chat = () => ({ __delayMs: 600 });
    const p = new OllamaProvider(base, tmo(200));
    const t0 = Date.now();
    const err = await p
      .chat({ model: "m", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after 200ms/);
    expect(Date.now() - t0).toBeLessThan(550);
  });
  test("on the default, the hint says the variable is not set in this process", async () => {
    mock.chat = () => "hang";
    const p = new OllamaProvider(base, tmo(100, "default"));
    const err = await p
      .chat({ model: "m", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/default/);
    expect(err.hint).toMatch(/retry, or open a new terminal/);
    expect(err.hint).toMatch(/REWIRE_OLLAMA_TIMEOUT_S is not set in this process's environment/);
    expect(err.hint).toMatch(/or set REWIRE_OLLAMA_TIMEOUT_S or \[providers\.ollama\] timeout_s/);
    expect(err.hint).toMatch(/\[providers\.ollama\] timeout_s/);
  });
  test("a slow reply within the rewire timeout is not cut by Node fetch's headers timeout", async () => {
    // Node's global fetch gives up after 300 s without response headers, below a
    // REWIRE_OLLAMA_TIMEOUT_S of 900. Shrink that default to 1 s to stand in for it (undici
    // checks timeouts on a coarse timer, so a shorter one is not enforced).
    const prev = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ headersTimeout: 1000, bodyTimeout: 1000 }));
    try {
      mock.chat = () => ({ __delayMs: 2500 });
      const p = new OllamaProvider(base, tmo(10_000));
      const r = await p.chat({ model: "m", system: "s", messages: [], maxTokens: 5 });
      expect(r.message.text).toContain("ok");
    } finally {
      setGlobalDispatcher(prev);
    }
  }, 15_000);
  test("createProvider takes the reply timeout from REWIRE_OLLAMA_TIMEOUT_S", async () => {
    mock.chat = () => "hang";
    const p = createProvider(ref, { OLLAMA_HOST: base, REWIRE_OLLAMA_TIMEOUT_S: "1" });
    const t0 = Date.now();
    const err = await p
      .chat({ model: "tiny:1b", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after 1s/);
    expect(err.message).toMatch(/REWIRE_OLLAMA_TIMEOUT_S/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  test("a dropped request while Ollama still answers is not reported as unreachable", async () => {
    mock.chat = () => "destroy";
    const p = new OllamaProvider(base);
    const err = await p
      .chat({ model: "m", system: "s", messages: [], maxTokens: 5 })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_request_dropped" });
    expect(err.message).toMatch(/dropped the chat request after \d+s/);
    expect(err.message).not.toMatch(/not reachable/);
    expect(err.hint).toMatch(/one request at a time/);
  });
  test("caller abort maps to provider_aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new OllamaProvider(base);
    await expect(
      p.chat({ model: "m", system: "s", messages: [], maxTokens: 5, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "provider_aborted" });
  });
});

describe("OllamaProvider streaming (onDelta)", () => {
  const usage = { prompt_tokens: 4, completion_tokens: 5 };
  const req = {
    model: "tiny:1b",
    system: "s",
    messages: [{ role: "user" as const, content: "hi" }],
    maxTokens: 5,
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  };
  test.each([
    {
      name: "text only",
      json: { choices: [{ finish_reason: "stop", message: { content: "Hi there" } }], usage },
      chunks: { text: ["Hi", " there"], finish: "stop", usage },
    },
    {
      name: "text plus tool calls",
      json: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "ok",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "echo", arguments: '{"v":1}' } },
                { id: "c2", type: "function", function: { name: "echo", arguments: '{"v":2}' } },
              ],
            },
          },
        ],
        usage,
      },
      chunks: {
        text: ["o", "k"],
        toolCalls: [
          { id: "c1", name: "echo", argPieces: ['{"v":', "1}"] },
          { id: "c2", name: "echo", argPieces: ['{"v":2}'] },
        ],
        finish: "tool_calls",
        usage,
      },
    },
  ])("$name: streamed equals non-streamed, and only the streamed body has stream", async (c) => {
    mock.chat = (b) => (b.stream ? { __sse: openaiSSE(openaiChunks(c.chunks)) } : c.json);
    const p = new OllamaProvider(base);
    const plain = await p.chat(req);
    const deltas: string[] = [];
    const streamed = await p.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(streamed).toEqual(plain);
    expect(deltas.join("")).toBe(plain.message.text);
    expect(chatBodies[0]).not.toHaveProperty("stream");
    expect(chatBodies[0]).not.toHaveProperty("stream_options");
    expect(chatBodies[1]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
  const partial = () =>
    openaiSSE(openaiChunks({ text: ["par", "tial"], finish: "stop" }).slice(0, 3), false);
  const events = (text: string[]) =>
    openaiChunks({ text, finish: "stop", usage }).map((c) => `data: ${JSON.stringify(c)}\n\n`);
  test("the idle timeout is 120s", () => {
    expect(OLLAMA_IDLE_TIMEOUT_MS).toBe(120_000);
  });
  test("a stream that keeps sending outlives the reply timeout", async () => {
    const text = Array.from({ length: 12 }, (_, i) => `w${i} `);
    mock.chat = () => ({ __drip: [...events(text), "data: [DONE]\n\n"], everyMs: 50 });
    const p = new OllamaProvider(base, tmo(250), { idleTimeoutMs: 200 });
    const t0 = Date.now();
    const deltas: string[] = [];
    const r = await p.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(r.message.text).toBe(text.join(""));
    expect(deltas).toEqual(text);
  });
  test("a stream that goes silent after the first chunk fails on the idle timeout", async () => {
    mock.chat = () => ({ __drip: events(["par", "tial"]).slice(0, 3), everyMs: 20, after: "hang" });
    const p = new OllamaProvider(base, tmo(5_000), { idleTimeoutMs: 200 });
    const t0 = Date.now();
    const deltas: string[] = [];
    const err = await p.chat({ ...req, onDelta: (d) => deltas.push(d) }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/no output for 200ms/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(deltas).toEqual(["par", "tial"]);
  });
  test("silence before the first chunk, past the idle limit but within the reply timeout, is fine", async () => {
    // The whole reply arrives in one write after 400 ms: longer than the 100 ms idle limit, within
    // the 2 s reply timeout. Idle applies only once the reply has started.
    mock.chat = () => ({ __drip: [`${events(["ok"]).join("")}data: [DONE]\n\n`], everyMs: 400 });
    const p = new OllamaProvider(base, tmo(2_000), { idleTimeoutMs: 100 });
    const r = await p.chat({ ...req, onDelta: () => {} });
    expect(r.message.text).toBe("ok");
  });
  test("thinking-only and tool-call-only chunks reset the idle timer", async () => {
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
    const thinking = Array.from({ length: 6 }, () => chunk({ reasoning: "hmm" }));
    const tool = [
      chunk({
        tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "echo" } }],
      }),
      ...Array.from({ length: 5 }, () =>
        chunk({ tool_calls: [{ index: 0, function: { arguments: " " } }] }),
      ),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
    ];
    // 13 chunks 50 ms apart (650 ms, over three idle limits), none with text until the last.
    mock.chat = () => ({
      __drip: [...thinking, ...tool, chunk({ content: "done" }, "tool_calls"), "data: [DONE]\n\n"],
      everyMs: 50,
    });
    const p = new OllamaProvider(base, tmo(5_000), { idleTimeoutMs: 200 });
    const r = await p.chat({ ...req, onDelta: () => {} });
    expect(r.message.text).toBe("done");
    expect(r.message.toolCalls.map((c) => c.name)).toEqual(["echo"]);
  });
  test("no first chunk within the reply timeout is ollama_timeout with the first-chunk message", async () => {
    mock.chat = () => ({ __sse: "", after: "hang" });
    const p = new OllamaProvider(base, tmo(200), { idleTimeoutMs: 5_000 });
    const err = await p.chat({ ...req, onDelta: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/no output within 200ms/);
    expect(err.message).not.toMatch(/no output for/);
    expect(err.hint).toMatch(/REWIRE_OLLAMA_TIMEOUT_S/);
  });
  test("caller abort mid-stream still aborts while chunks flow", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`);
    mock.chat = () => ({ __drip: events(text), everyMs: 30 });
    const ac = new AbortController();
    const p = new OllamaProvider(base, tmo(5_000), { idleTimeoutMs: 5_000 });
    let n = 0;
    const err = await p
      .chat({
        ...req,
        signal: ac.signal,
        onDelta: () => {
          if (++n === 3) ac.abort();
        },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "provider_aborted" });
  });
  test("caller abort mid-stream is provider_aborted", async () => {
    mock.chat = () => ({ __sse: partial(), after: "hang" });
    const ac = new AbortController();
    const p = new OllamaProvider(base);
    const err = await p
      .chat({ ...req, signal: ac.signal, onDelta: () => ac.abort() })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "provider_aborted" });
  });
  test("a socket dropped mid-stream while Ollama answers is ollama_request_dropped", async () => {
    mock.chat = () => ({ __sse: partial(), after: "destroy" });
    const p = new OllamaProvider(base);
    const err = await p.chat({ ...req, onDelta: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_request_dropped" });
  });
  test("a clean close without a finish reason is ollama_request_dropped, not a partial reply", async () => {
    mock.chat = () => ({ __sse: partial(), after: "end" });
    const p = new OllamaProvider(base);
    const err = await p.chat({ ...req, onDelta: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_request_dropped" });
  });
  test("a malformed SSE JSON line is provider_error, not a dropped request", async () => {
    mock.chat = () => ({ __sse: `${partial()}data: {not json\n\n`, after: "end" });
    const p = new OllamaProvider(base);
    const err = await p.chat({ ...req, onDelta: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "provider_error" });
    expect(err.message).toMatch(/ollama/);
    expect(hits["/api/version"] ?? 0).toBe(0);
  });
  test("onFirstChunk fires once on a reasoning-only first chunk (qwen3 thinking), before text", async () => {
    const reasoning = {
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "", reasoning: "hmm" },
          finish_reason: null,
        },
      ],
    };
    mock.chat = (b) =>
      b.stream
        ? {
            __sse: openaiSSE([
              reasoning,
              ...openaiChunks({ text: ["o", "k"], finish: "stop", usage }),
            ]),
          }
        : {};
    const p = new OllamaProvider(base);
    const order: string[] = [];
    await p.chat({
      ...req,
      onFirstChunk: () => order.push("first"),
      onDelta: (d) => order.push(d),
    });
    expect(order).toEqual(["first", "o", "k"]);
  });
  test("an onDelta throw propagates as provider_stream_callback_failed, not dropped", async () => {
    mock.chat = (b) =>
      b.stream ? { __sse: openaiSSE(openaiChunks({ text: ["x"], finish: "stop" })) } : {};
    const p = new OllamaProvider(base);
    const err = await p
      .chat({
        ...req,
        onDelta: () => {
          throw new Error("render blew up");
        },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "provider_stream_callback_failed" });
    expect(err.message).toMatch(/render blew up/);
    expect(hits["/api/version"] ?? 0).toBe(0);
  });
});

describe("assertRoleFit", () => {
  test("rejects_model_without_tools_capability", async () => {
    mock.capabilities = ["completion"];
    await expect(fit("implementer")).rejects.toMatchObject({
      code: "model_unfit",
      message: "tiny:1b lacks tool calling, required for role implementer",
    });
    expect(chats()).toBe(0);
  });
  test("tool role passes and caches per digest:role", async () => {
    await fit("implementer");
    expect(chats()).toBe(2);
    const c = await readCache();
    expect(c["sha256:abc:implementer"]).toMatchObject({
      ok: true,
      testVersion: FITNESS_TEST_VERSION,
    });
    expect(typeof c["sha256:abc:implementer"].at).toBe("string");
  });
  test("fitness result cached per digest (second call makes no chat requests)", async () => {
    await fit("implementer");
    const before = chats();
    await fit("implementer");
    expect(chats()).toBe(before);
  });
  test("an empty model digest is refused, never cached under a shared key (row 39)", async () => {
    mock.models = [{ name: "tiny:1b", digest: "" }];
    await expect(fit("reviewer")).rejects.toBeDefined();
    expect(chats()).toBe(0);
  });
  test("the smoke test leaves room for reasoning models: 4096 output tokens (row 42)", async () => {
    await fit("implementer");
    expect(chatBodies.length).toBe(2);
    for (const b of chatBodies) expect(b.max_tokens ?? b.max_completion_tokens).toBe(4096);
    expect(FITNESS_TEST_VERSION).toBeGreaterThanOrEqual(2);
  });
  test("different digest re-tests", async () => {
    await fit("reviewer");
    mock.models = [{ name: "tiny:1b", digest: "sha256:new" }];
    const before = chats();
    await fit("reviewer");
    expect(chats()).toBeGreaterThan(before);
  });
  test("reviewer role allowed without tools if structured smoke passes", async () => {
    mock.capabilities = ["completion"];
    await fit("reviewer");
    expect(chats()).toBe(1);
    expect(chatBodies[0]).not.toHaveProperty("tools");
  });
  test("structured failure is model_unfit, cached, and re-thrown without chat calls", async () => {
    mock.chat = () => ({
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true,"n":4}' } }],
    });
    await expect(fit("reviewer")).rejects.toMatchObject({
      code: "model_unfit",
      message: expect.stringMatching(/tiny:1b.*reviewer.*structured/s),
    });
    const before = chats();
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "model_unfit" });
    expect(chats()).toBe(before);
    expect((await readCache())["sha256:abc:reviewer"].ok).toBe(false);
  });
  test("tool step returning the wrong arg is model_unfit and cached as false", async () => {
    mock.chat = (b) => (b.tools ? toolCall("pong") : structuredOk());
    await expect(fit("implementer")).rejects.toMatchObject({
      code: "model_unfit",
      message: expect.stringMatching(/tool/),
    });
    const c = await readCache();
    expect(c["sha256:abc:implementer"]).toMatchObject({ ok: false });
    const before = chats();
    await expect(fit("implementer")).rejects.toMatchObject({ code: "model_unfit" });
    expect(chats()).toBe(before);
  });
  test("tool step with no tool call is model_unfit", async () => {
    mock.chat = (b) => (b.tools ? structuredOk() : structuredOk());
    await expect(fit("test-writer")).rejects.toMatchObject({ code: "model_unfit" });
  });
  test("unparseable cache file triggers a re-test (never a pass)", async () => {
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "fitness.json"), "{not json");
    await fit("reviewer");
    expect(chats()).toBe(1);
    expect((await readCache())["sha256:abc:reviewer"].ok).toBe(true);
  });
  test("schema-invalid cache triggers a re-test", async () => {
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "fitness.json"),
      JSON.stringify({ "sha256:abc:reviewer": { ok: "yes" } }),
    );
    await fit("reviewer");
    expect(chats()).toBe(1);
  });
  test("testVersion mismatch triggers a re-test", async () => {
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "fitness.json"),
      JSON.stringify({
        "sha256:abc:reviewer": {
          ok: false,
          reason: "old",
          testVersion: FITNESS_TEST_VERSION + 1,
          at: new Date().toISOString(),
        },
      }),
    );
    await fit("reviewer");
    expect(chats()).toBe(1);
    expect((await readCache())["sha256:abc:reviewer"].testVersion).toBe(FITNESS_TEST_VERSION);
  });
  test("a transient dropped request during the smoke test is not cached", async () => {
    mock.chat = () => "destroy";
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "ollama_request_dropped" });
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
  });
  test("5xx on the structured step is not cached and the next call re-runs it", async () => {
    mock.chat = () => ({ __status: 500 });
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "provider_error" });
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
    mock.chat = goodChat;
    await fit("reviewer");
    expect(chats()).toBe(2);
    expect((await readCache())["sha256:abc:reviewer"].ok).toBe(true);
  });
  test("the smoke test's provider takes the resolved ollama timeout", async () => {
    mock.chat = () => "hang";
    const err = await assertRoleFit(ref, "reviewer", cache, {
      baseUrl: base,
      ollamaTimeout: { ms: 150, source: "models.toml" },
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after 150ms/);
    expect(err.message).toMatch(/models\.toml/);
  });
  test("chat timeout is not cached and has a distinct message", async () => {
    mock.chat = () => "hang";
    const err = await assertRoleFit(ref, "reviewer", cache, {
      baseUrl: base,
      chatTimeoutMs: 100,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "ollama_timeout" });
    expect(err.message).toMatch(/timed out after/);
    expect(err.message).not.toMatch(/not reachable/);
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
  });
  test("malformed tool args from the model are a cached model failure", async () => {
    mock.chat = (b) =>
      b.tools
        ? {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    { id: "c", type: "function", function: { name: "echo", arguments: "{" } },
                  ],
                },
              },
            ],
          }
        : structuredOk();
    await expect(fit("implementer")).rejects.toMatchObject({ code: "model_unfit" });
    expect((await readCache())["sha256:abc:implementer"].ok).toBe(false);
  });
  test("a chat response with no choices is provider_bad_response, not cached, re-run next call", async () => {
    mock.chat = () => ({ choices: [] });
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "provider_bad_response" });
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
    mock.chat = goodChat;
    await fit("reviewer");
    expect(chats()).toBe(2);
  });
  test("an unparseable chat body is not cached", async () => {
    mock.chat = () => "<html>";
    await expect(fit("reviewer")).rejects.toBeTruthy();
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
  });
  test("cached failure rethrow says when it was cached and how to clear it", async () => {
    mock.chat = () => ({
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true,"n":4}' } }],
    });
    await fit("reviewer").catch(() => {});
    const err = await fit("reviewer").catch((e) => e);
    expect(err).toMatchObject({ code: "model_unfit" });
    expect(err.message).toMatch(/\(cached \d{4}-\d{2}-\d{2}T/);
    expect(err.hint).toContain(join(cache, "fitness.json"));
    expect(err.hint).toContain("to re-test");
  });
  test("non-ollama ref returns immediately without touching cache or network", async () => {
    await assertRoleFit({ provider: "openai", model: "gpt-5" }, "implementer", cache, {
      baseUrl: base,
    });
    expect(Object.keys(hits)).toHaveLength(0);
    await expect(readFile(join(cache, "fitness.json"), "utf8")).rejects.toThrow();
  });
  test("too-old server is refused before any model check", async () => {
    mock.version = "0.3.0";
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "ollama_too_old" });
  });
});
