import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertRoleFit,
  createProvider,
  FITNESS_TEST_VERSION,
  getModelInfo,
  MIN_OLLAMA_VERSION,
  normalizeOllamaHost,
  OllamaProvider,
  probeOllama,
} from "../src/index.js";

type Mock = {
  version: string;
  capabilities: string[];
  models: { name: string; digest: string }[];
  showStatus: number;
  tagsBody: string | null;
  /** Called for each chat request; returns the OpenAI-style body, or "destroy" to drop the socket. */
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
  test("caller abort maps to provider_aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new OllamaProvider(base);
    await expect(
      p.chat({ model: "m", system: "s", messages: [], maxTokens: 5, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "provider_aborted" });
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
  test("transient unreachable during smoke test is not cached", async () => {
    mock.chat = () => "destroy";
    await expect(fit("reviewer")).rejects.toMatchObject({ code: "ollama_unreachable" });
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
