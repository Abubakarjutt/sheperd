import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { toAnthropicParams } from "../src/anthropic.js";
import { ClaudeCloudProvider, createClaudeCloudClient } from "../src/claude-cloud.js";
import { createProvider } from "../src/registry.js";
import { type ChatRequest, type ModelRef, parseModelRef } from "../src/types.js";
import { isLoopbackHost, isLoopbackUrl } from "../src/url.js";
import { contextWindow } from "../src/window.js";
import { anthropicEvents, anthropicSSE } from "./sse.js";

// Fake values only: no real credential is ever read or sent.
const AWS_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
  AWS_SECRET_ACCESS_KEY: "fakeSecretAccessKeyFakeSecretAccessKey00",
};
const FOUNDRY_KEY = "fakefoundrykey0123456789abcdef";

type Seen = { url: string; method: string; headers: Headers; body: Record<string, unknown> };

const usage = { input_tokens: 11, output_tokens: 7 };
const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "Hello world" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
};
const sse = anthropicSSE(
  anthropicEvents({
    blocks: [{ type: "text", pieces: ["Hel", "lo", " world"] }],
    stop: "end_turn",
    usage,
  }),
);

/** Records each request and replies with a message (or its stream when the body asks). */
function recordingFetch(reply?: () => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({
      url: String(input),
      method: String(init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body,
    });
    if (reply) return reply();
    if (body.stream) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

/** A google-auth-library AuthClient stand-in, so no Application Default Credentials are read. */
const fakeAuthClient = {
  projectId: null,
  getRequestHeaders: async () => new Headers({ authorization: "Bearer ya29.fake-token" }),
};

const req = (model: string): ChatRequest => ({
  model,
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 9,
  tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
});
const wire = (r: ChatRequest) => JSON.parse(JSON.stringify(toAnthropicParams(r)));

async function both(provider: ClaudeCloudProvider, r: ChatRequest) {
  const plain = await provider.chat(r);
  const deltas: string[] = [];
  const streamed = await provider.chat({ ...r, onDelta: (d) => deltas.push(d) });
  expect(streamed).toEqual(plain);
  expect(plain.message.text).toBe("Hello world");
  expect(deltas).toEqual(["Hel", "lo", " world"]);
}

describe("Claude on Amazon Bedrock (Mantle)", () => {
  test("non-streamed and streamed requests: Mantle host, SigV4, the toAnthropicParams body", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider("bedrock", {}, AWS_ENV, { fetch: f.fetch });
    const r = req("anthropic.claude-opus-5-5");
    await both(p, r);
    expect(f.seen).toHaveLength(2);
    for (const s of f.seen) {
      expect(s.url).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
      expect(s.method).toBe("POST");
      expect(s.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
      expect(s.headers.has("x-amz-date")).toBe(true);
      expect(s.headers.has("x-api-key")).toBe(false);
    }
    expect(f.seen[0]?.body).toEqual(wire(r));
    expect(f.seen[1]?.body).toEqual({ ...wire(r), stream: true });
  });
  test("[providers.bedrock] region wins over AWS_REGION; AWS_DEFAULT_REGION is the fallback", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider("bedrock", { bedrock: { region: "eu-west-1" } }, AWS_ENV, {
      fetch: f.fetch,
    });
    await p.chat(req("anthropic.claude-opus-5-5"));
    expect(f.seen[0]?.url).toBe("https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages");
    const g = recordingFetch();
    const { AWS_REGION: _r, ...noRegion } = AWS_ENV;
    const q = new ClaudeCloudProvider(
      "bedrock",
      {},
      { ...noRegion, AWS_DEFAULT_REGION: "ap-south-1" },
      { fetch: g.fetch },
    );
    await q.chat(req("anthropic.claude-opus-5-5"));
    expect(g.seen[0]?.url).toBe("https://bedrock-mantle.ap-south-1.api.aws/anthropic/v1/messages");
  });
  test("a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK) is sent as Bearer, not signed", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider(
      "bedrock",
      {},
      { AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "fake-bedrock-api-key-123456" },
      { fetch: f.fetch },
    );
    await p.chat(req("anthropic.claude-opus-5-5"));
    expect(f.seen[0]?.headers.get("authorization")).toMatch(/^Bearer /);
  });
  test("no region anywhere: provider_auth_missing at creation, naming the toml key and env vars", () => {
    const { AWS_REGION: _r, ...noRegion } = AWS_ENV;
    expect(() =>
      createProvider(parseModelRef("bedrock:anthropic.claude-opus-5-5"), noRegion),
    ).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        hint: expect.stringMatching(
          /\[providers\.bedrock\] region.*AWS_REGION.*AWS_DEFAULT_REGION/,
        ),
      }),
    );
  });
  test("an SDK error echoing the secret or bearer token is redacted", async () => {
    const token = "fake-bedrock-api-key-123456";
    const f = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "x", message: `bad token ${token}` } }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const p = new ClaudeCloudProvider(
      "bedrock",
      {},
      { AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: token },
      { fetch: f.fetch },
    );
    const err = await p.chat(req("anthropic.claude-opus-5-5")).catch((e) => e);
    expect(err.code).toBe("provider_error");
    expect(err.message).toMatch(/^bedrock request failed/);
    expect(err.message).not.toContain(token);
    expect(err.message).toContain("[redacted]");

    const g = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "x", message: `sig for ${AWS_ENV.AWS_SECRET_ACCESS_KEY}` },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );
    const q = new ClaudeCloudProvider("bedrock", {}, AWS_ENV, { fetch: g.fetch });
    const e2 = await q.chat(req("anthropic.claude-opus-5-5")).catch((e) => e);
    expect(e2.message).not.toContain(AWS_ENV.AWS_SECRET_ACCESS_KEY);
    expect(e2.message).toContain("[redacted]");
  });
});

describe("Claude on Google Vertex AI", () => {
  const settings = { vertex: { project: "my-proj" } };
  test("non-streamed and streamed requests: rawPredict / streamRawPredict, OAuth Bearer, model moved into the URL", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider(
      "vertex",
      settings,
      {},
      {
        fetch: f.fetch,
        vertexAuthClient: fakeAuthClient,
      },
    );
    const r = req("claude-opus-5-5");
    await both(p, r);
    const base =
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-opus-5-5";
    expect(f.seen.map((s) => s.url)).toEqual([`${base}:rawPredict`, `${base}:streamRawPredict`]);
    const { model: _m, ...rest } = wire(r);
    for (const s of f.seen) {
      expect(s.method).toBe("POST");
      expect(s.headers.get("authorization")).toMatch(/^Bearer /);
      expect(s.headers.has("x-api-key")).toBe(false);
      expect(s.body.anthropic_version).toEqual(expect.any(String));
    }
    const { anthropic_version: _v0, ...b0 } = f.seen[0]?.body ?? {};
    const { anthropic_version: _v1, ...b1 } = f.seen[1]?.body ?? {};
    expect(b0).toEqual(rest);
    expect(b1).toEqual({ ...rest, stream: true });
  });
  test("region from [providers.vertex] region, then CLOUD_ML_REGION; project from env", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider(
      "vertex",
      { vertex: { region: "us-east5" } },
      { ANTHROPIC_VERTEX_PROJECT_ID: "env-proj", CLOUD_ML_REGION: "europe-west1" },
      { fetch: f.fetch, vertexAuthClient: fakeAuthClient },
    );
    await p.chat(req("claude-opus-4@20250514"));
    expect(f.seen[0]?.url).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/env-proj/locations/us-east5/publishers/anthropic/models/claude-opus-4@20250514:rawPredict",
    );
    const g = recordingFetch();
    const q = new ClaudeCloudProvider(
      "vertex",
      {},
      { GOOGLE_CLOUD_PROJECT: "gc-proj", CLOUD_ML_REGION: "europe-west1" },
      { fetch: g.fetch, vertexAuthClient: fakeAuthClient },
    );
    await q.chat(req("claude-opus-5-5"));
    expect(g.seen[0]?.url).toMatch(
      /^https:\/\/europe-west1-aiplatform\.googleapis\.com\/v1\/projects\/gc-proj\/locations\/europe-west1\//,
    );
  });
  test("no project anywhere: provider_auth_missing at creation, naming the toml key and env vars", () => {
    expect(() => createProvider(parseModelRef("vertex:claude-opus-5-5"), {})).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        hint: expect.stringMatching(
          /\[providers\.vertex\] project.*ANTHROPIC_VERTEX_PROJECT_ID.*GOOGLE_CLOUD_PROJECT/,
        ),
      }),
    );
  });
});

describe("Claude on Microsoft Foundry", () => {
  const env = { ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY };
  test("non-streamed and streamed requests: the resource host, the Foundry key header, the toAnthropicParams body", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider("foundry", { foundry: { resource: "my-res" } }, env, {
      fetch: f.fetch,
    });
    const r = req("claude-opus-5-5");
    await both(p, r);
    for (const s of f.seen) {
      expect(s.url).toBe("https://my-res.services.ai.azure.com/anthropic/v1/messages");
      expect(s.method).toBe("POST");
      expect(s.headers.has("x-api-key")).toBe(true);
      expect(s.headers.has("authorization")).toBe(false);
    }
    expect(f.seen[0]?.body).toEqual(wire(r));
    expect(f.seen[1]?.body).toEqual({ ...wire(r), stream: true });
  });
  test("a base URL from [providers.foundry] base_url or ANTHROPIC_FOUNDRY_BASE_URL; the toml wins", async () => {
    const f = recordingFetch();
    const p = new ClaudeCloudProvider(
      "foundry",
      { foundry: { baseUrl: "https://gw.example.com/anthropic/" } },
      { ...env, ANTHROPIC_FOUNDRY_RESOURCE: "env-res" },
      { fetch: f.fetch },
    );
    await p.chat(req("claude-opus-5-5"));
    expect(f.seen[0]?.url).toBe("https://gw.example.com/anthropic/v1/messages");
    const g = recordingFetch();
    const q = new ClaudeCloudProvider(
      "foundry",
      {},
      { ...env, ANTHROPIC_FOUNDRY_BASE_URL: "https://other.example.com/anthropic/" },
      { fetch: g.fetch },
    );
    await q.chat(req("claude-opus-5-5"));
    expect(g.seen[0]?.url).toBe("https://other.example.com/anthropic/v1/messages");
  });
  test("no key, or no resource or base URL: provider_auth_missing at creation", () => {
    const ref = parseModelRef("foundry:claude-opus-5-5");
    expect(() =>
      createProvider(ref, { ANTHROPIC_FOUNDRY_RESOURCE: "r" }, { foundry: { resource: "r" } }),
    ).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        message: expect.stringContaining("ANTHROPIC_FOUNDRY_API_KEY"),
      }),
    );
    expect(() => createProvider(ref, env)).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        hint: expect.stringMatching(
          /\[providers\.foundry\] resource.*ANTHROPIC_FOUNDRY_RESOURCE.*ANTHROPIC_FOUNDRY_BASE_URL/,
        ),
      }),
    );
  });
  test("an SDK error echoing the key is redacted", async () => {
    const f = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "auth", message: `key ${FOUNDRY_KEY}` } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const p = new ClaudeCloudProvider("foundry", { foundry: { resource: "r" } }, env, {
      fetch: f.fetch,
    });
    const err = await p.chat(req("claude-opus-5-5")).catch((e) => e);
    expect(err.code).toBe("provider_error");
    expect(err.message).toMatch(/^foundry request failed/);
    expect(err.message).not.toContain(FOUNDRY_KEY);
    expect(err.message).toContain("[redacted]");
  });
});

describe("createProvider and createClaudeCloudClient", () => {
  test("the three names are registered and take [providers.*] settings", () => {
    expect(
      createProvider(parseModelRef("bedrock:anthropic.claude-opus-5-5"), { AWS_REGION: "x" }),
    ).toBeInstanceOf(ClaudeCloudProvider);
    expect(
      createProvider(parseModelRef("vertex:claude-opus-5-5"), {}, { vertex: { project: "p" } }),
    ).toBeInstanceOf(ClaudeCloudProvider);
    expect(
      createProvider(parseModelRef("foundry:claude-opus-5-5"), env(), {
        foundry: { resource: "r" },
      }),
    ).toBeInstanceOf(ClaudeCloudProvider);
    function env() {
      return { ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY };
    }
  });
  test("createClaudeCloudClient returns a client with the messages surface", async () => {
    const f = recordingFetch();
    const client = await createClaudeCloudClient(
      "foundry",
      { foundry: { resource: "r" } },
      { ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY },
      f.fetch,
    );
    expect(typeof client.messages.create).toBe("function");
    expect(typeof client.messages.stream).toBe("function");
    await expect(createClaudeCloudClient("bedrock", {}, {}, f.fetch)).rejects.toMatchObject({
      code: "provider_auth_missing",
    });
  });
});

describe("contextWindow for Claude on the clouds uses the anthropic table", () => {
  test.each<[string, number]>([
    ["bedrock:anthropic.claude-opus-5-5", 200_000],
    ["bedrock:anthropic.claude-sonnet-4-5-20250929-v1:0", 200_000],
    ["bedrock:us.anthropic.claude-opus-5-5", 200_000],
    ["vertex:claude-opus-5-5", 200_000],
    ["vertex:claude-opus-4@20250514", 200_000],
    ["foundry:claude-sonnet-4-5", 200_000],
  ])("%s", async (s, window) => {
    const ref: ModelRef = parseModelRef(s);
    await expect(contextWindow(ref)).resolves.toEqual({
      window,
      source: "table",
      provisional: true,
    });
  });
  test("a Foundry deployment name outside the table gets the default", async () => {
    await expect(contextWindow(parseModelRef("foundry:prod-claude"))).resolves.toMatchObject({
      source: "default",
    });
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cloud-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SDK base-URL overrides come only from the env rewire passes, https or loopback http", () => {
  test("bedrock: ANTHROPIC_BEDROCK_MANTLE_BASE_URL from env is used; process.env's is ignored", async () => {
    vi.stubEnv("ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "https://process-env.example.com/anthropic");
    const f = recordingFetch();
    await new ClaudeCloudProvider("bedrock", {}, AWS_ENV, { fetch: f.fetch }).chat(
      req("anthropic.claude-opus-5-5"),
    );
    expect(f.seen[0]?.url).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
    const g = recordingFetch();
    await new ClaudeCloudProvider(
      "bedrock",
      {},
      { ...AWS_ENV, ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "http://127.0.0.1:9/anthropic" },
      { fetch: g.fetch },
    ).chat(req("anthropic.claude-opus-5-5"));
    expect(g.seen[0]?.url).toBe("http://127.0.0.1:9/anthropic/v1/messages");
  });
  test("vertex: ANTHROPIC_VERTEX_BASE_URL from env is used; process.env's is ignored", async () => {
    vi.stubEnv("ANTHROPIC_VERTEX_BASE_URL", "https://process-env.example.com/v1");
    const f = recordingFetch();
    await new ClaudeCloudProvider(
      "vertex",
      { vertex: { project: "p" } },
      {},
      {
        fetch: f.fetch,
        vertexAuthClient: fakeAuthClient,
      },
    ).chat(req("claude-opus-5-5"));
    expect(f.seen[0]?.url).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/p\//);
    const g = recordingFetch();
    await new ClaudeCloudProvider(
      "vertex",
      { vertex: { project: "p" } },
      { ANTHROPIC_VERTEX_BASE_URL: "https://gw.example.com/v1" },
      { fetch: g.fetch, vertexAuthClient: fakeAuthClient },
    ).chat(req("claude-opus-5-5"));
    expect(g.seen[0]?.url).toMatch(/^https:\/\/gw\.example\.com\/v1\/projects\/p\//);
  });
  test.each([
    ["bedrock", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", AWS_ENV, "bedrock:anthropic.claude-opus-5-5"],
    [
      "vertex",
      "ANTHROPIC_VERTEX_BASE_URL",
      { GOOGLE_CLOUD_PROJECT: "p" },
      "vertex:claude-opus-5-5",
    ],
    [
      "foundry",
      "ANTHROPIC_FOUNDRY_BASE_URL",
      { ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY },
      "foundry:claude-opus-5-5",
    ],
  ])(
    "%s: a plain-http, credentialed or relative %s is refused at creation",
    (_p, name, env, ref) => {
      for (const bad of [
        "http://gw.example.com/anthropic",
        "https://user:pw@gw.example.com/",
        "https://gw.example.com/?key=x",
        "not a url",
      ]) {
        expect(() => createProvider(parseModelRef(ref), { ...env, [name]: bad })).toThrowError(
          expect.objectContaining({
            code: "provider_auth_missing",
            hint: expect.stringContaining(name),
          }),
        );
      }
    },
  );
  test("the shared loopback check", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["127.0.0.1.evil.com", "localhost.example", "10.0.0.1", "::1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
    expect(isLoopbackUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isLoopbackUrl("https://localhost/v1")).toBe(true);
    expect(isLoopbackUrl("https://api.groq.com/openai/v1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("Vertex: Google credential errors are never unhandled", () => {
  test("an aborted first chat with broken ADC leaves no unhandled rejection; the next chat says provider_auth_missing", async () => {
    // A credential file that does not exist: google-auth-library fails at once, reading nothing.
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", join(tmp(), "missing.json"));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = recordingFetch();
      const p = new ClaudeCloudProvider(
        "vertex",
        { vertex: { project: "p" } },
        {},
        {
          fetch: f.fetch,
        },
      );
      const ac = new AbortController();
      ac.abort();
      const first = await p.chat({ ...req("claude-opus-5-5"), signal: ac.signal }).catch((e) => e);
      expect(["provider_aborted", "provider_auth_missing"]).toContain(first.code);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      const second = await p.chat(req("claude-opus-5-5")).catch((e) => e);
      expect(second).toMatchObject({
        code: "provider_auth_missing",
        hint: expect.stringMatching(/GOOGLE_APPLICATION_CREDENTIALS|gcloud/),
      });
      expect(f.seen).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Bedrock: the AWS shared-config chain and AWS_PROFILE (fake files in a temp dir)", () => {
  /** Points the AWS chain at fake shared files and clears every other credential source. */
  function fakeAwsFiles(): void {
    const d = tmp();
    const creds = join(d, "credentials");
    const config = join(d, "config");
    writeFileSync(
      creds,
      [
        "[default]",
        "aws_access_key_id = AKIAFAKEDEFAULTPROF1",
        "aws_secret_access_key = fakeDefaultSecretFakeDefaultSecret000000",
        "[work]",
        "aws_access_key_id = AKIAFAKEWORKPROFILE1",
        "aws_secret_access_key = fakeWorkSecretFakeWorkSecretFakeWork0000",
        "",
      ].join("\n"),
    );
    writeFileSync(config, "[default]\nregion = us-east-1\n[profile work]\nregion = us-east-1\n");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", creds);
    vi.stubEnv("AWS_CONFIG_FILE", config);
    vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    ]) {
      vi.stubEnv(name, undefined);
    }
  }
  const credentialOf = (s: Seen | undefined) =>
    /Credential=([A-Z0-9]+)\//.exec(s?.headers.get("authorization") ?? "")?.[1];

  test("no keys in env: the default chain signs with the shared credentials file", async () => {
    fakeAwsFiles();
    const f = recordingFetch();
    await new ClaudeCloudProvider(
      "bedrock",
      {},
      { AWS_REGION: "us-east-1" },
      {
        fetch: f.fetch,
      },
    ).chat(req("anthropic.claude-opus-5-5"));
    expect(credentialOf(f.seen[0])).toBe("AKIAFAKEDEFAULTPROF1");
  });
  test("AWS_PROFILE from the env rewire passes selects that profile", async () => {
    fakeAwsFiles();
    const f = recordingFetch();
    await new ClaudeCloudProvider(
      "bedrock",
      {},
      { AWS_REGION: "us-east-1", AWS_PROFILE: "work" },
      { fetch: f.fetch },
    ).chat(req("anthropic.claude-opus-5-5"));
    expect(credentialOf(f.seen[0])).toBe("AKIAFAKEWORKPROFILE1");
  });
});
