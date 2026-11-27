import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRouting } from "@rewire/pipeline";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { DEFAULT_GEMINI_MODEL, discoverModels } from "../src/models.js";
import {
  createRoutedProviders,
  ollamaTimeoutOption,
  providerFactory,
  resolveModels,
  runCommand,
} from "../src/run.js";
import { chatCommand } from "../src/tui.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cloud-cli-")));
  dirs.push(d);
  return d;
};
const toml = (body: string): string => {
  const f = join(tmp(), "models.toml");
  writeFileSync(f, body);
  return f;
};

/** Every credential value in these tests carries this marker; doctor output must never hold it. */
const FAKE = "FAKESECRETzz9";
const down = async (): Promise<Response> => {
  throw new Error("down");
};

describe("discovery", () => {
  test("GEMINI_API_KEY adds gemini:<REWIRE_GEMINI_MODEL or the default>", async () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-2.5-pro");
    expect(await discoverModels({ GEMINI_API_KEY: FAKE }, down)).toEqual([
      { provider: "gemini", model: "gemini-2.5-pro" },
    ]);
    const r = await discoverModels(
      { ANTHROPIC_API_KEY: FAKE, GEMINI_API_KEY: FAKE, REWIRE_GEMINI_MODEL: "gemini-3-pro" },
      down,
    );
    expect(r).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "gemini", model: "gemini-3-pro" },
    ]);
    expect(JSON.stringify(r)).not.toContain(FAKE);
    await expect(
      discoverModels({ GEMINI_API_KEY: FAKE, REWIRE_GEMINI_MODEL: "bad model\x1b" }, down),
    ).rejects.toMatchObject({ code: "model_override_invalid" });
  });

  test("clouds, Azure and endpoints are never auto-detected", async () => {
    await expect(
      discoverModels(
        {
          GOOGLE_API_KEY: FAKE,
          AWS_ACCESS_KEY_ID: FAKE,
          AWS_SECRET_ACCESS_KEY: FAKE,
          AWS_REGION: "us-east-1",
          ANTHROPIC_VERTEX_PROJECT_ID: "p",
          ANTHROPIC_FOUNDRY_API_KEY: FAKE,
          AZURE_OPENAI_API_KEY: FAKE,
          AZURE_OPENAI_ENDPOINT: "https://r.openai.azure.com",
        },
        down,
      ),
    ).rejects.toMatchObject({ code: "no_models_available" });
  });

  test("the no_models_available hint names GEMINI_API_KEY and --models for clouds", async () => {
    const err = await discoverModels({}, down).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "no_models_available" });
    const hint = (err as { hint: string }).hint;
    expect(hint).toContain("GEMINI_API_KEY");
    expect(hint).toMatch(/--models <file>.*Bedrock.*Vertex.*Foundry.*Azure.*endpoint/);
  });
});

async function doctor(models: string, env: NodeJS.ProcessEnv): Promise<[number, string]> {
  const out: string[] = [];
  const code = await runDoctor(models, "darwin", {
    stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
    env: { PATH: "", ...env },
    cwd: tmp(),
    sandboxLookup: { sourceRoot: null, packageRoot: tmp() },
  } as Parameters<typeof runDoctor>[2]);
  return [code, out.join("")];
}

describe("doctor: one line per configured cloud provider and endpoint", () => {
  test("what each resolved, the env var names it found, never a value", async () => {
    const f = toml(
      `available = [
  "bedrock:anthropic.claude-opus-5-5",
  "vertex:claude-opus-5-5",
  "foundry:claude-opus-5-5",
  "azure:gpt-5-deploy",
  "gemini:gemini-2.5-pro",
  "groq:llama-3.3-70b",
  "corp:claude-opus-5-5",
  "local:qwen2.5-coder",
]
[providers.bedrock]
region = "us-west-2"
[providers.vertex]
project = "my-proj"
[providers.azure]
endpoint = "https://myres.openai.azure.com"
[endpoints.groq]
base_url = "https://api.groq.com/openai/v1"
api_key_env = "GROQ_API_KEY"
[endpoints.corp]
base_url = "https://llm.corp.example/v1"
api_key_env = "CORP_KEY"
family = "x"
[endpoints.local]
base_url = "http://127.0.0.1:8080/v1"
`,
    );
    const [, out] = await doctor(f, {
      AWS_ACCESS_KEY_ID: `AKIA${FAKE}`,
      AWS_SECRET_ACCESS_KEY: FAKE,
      AWS_REGION: "eu-central-1",
      GOOGLE_APPLICATION_CREDENTIALS: `/secret/${FAKE}.json`,
      ANTHROPIC_FOUNDRY_API_KEY: FAKE,
      ANTHROPIC_FOUNDRY_RESOURCE: "myfoundry",
      AZURE_OPENAI_API_KEY: FAKE,
      OPENAI_API_VERSION: "2024-10-21",
      GEMINI_API_KEY: FAKE,
      GROQ_API_KEY: FAKE,
      CORP_KEY: FAKE,
    });
    expect(out).not.toContain(FAKE);
    expect(out).toMatch(
      /^✓ bedrock region us-west-2 \(\[providers\.bedrock\] region\), auth AWS_ACCESS_KEY_ID \+ AWS_SECRET_ACCESS_KEY$/m,
    );
    expect(out).toMatch(
      /^✓ vertex project my-proj \(\[providers\.vertex\] project\), region global \(default\), auth Google application default credentials \(GOOGLE_APPLICATION_CREDENTIALS\)$/m,
    );
    expect(out).toMatch(
      /^✓ foundry resource myfoundry \(ANTHROPIC_FOUNDRY_RESOURCE\), key ANTHROPIC_FOUNDRY_API_KEY$/m,
    );
    expect(out).toMatch(
      /^✓ azure host myres\.openai\.azure\.com \(\[providers\.azure\] endpoint\), api version 2024-10-21 \(OPENAI_API_VERSION\), key AZURE_OPENAI_API_KEY$/m,
    );
    expect(out).toMatch(/^✓ gemini host generativelanguage\.googleapis\.com, key GEMINI_API_KEY$/m);
    expect(out).toMatch(/^✓ endpoint groq host api\.groq\.com, key GROQ_API_KEY$/m);
    expect(out).toMatch(
      /^✓ endpoint corp host llm\.corp\.example, key CORP_KEY, family "x" from models\.toml \(rewire would derive "claude" for corp:claude-opus-5-5\)$/m,
    );
    expect(out).toMatch(/^✓ endpoint local host 127\.0\.0\.1:8080, no key \(loopback\)$/m);
  });

  test("an Azure family override is shown with the family rewire would derive", async () => {
    const f = toml(
      `available = ["azure:DeepSeek-R1", "azure:prod"]
[providers.azure]
endpoint = "https://myres.openai.azure.com"
api_version = "2024-10-21"
family = "gpt"
`,
    );
    const [, out] = await doctor(f, { AZURE_OPENAI_API_KEY: FAKE });
    expect(out).not.toContain(FAKE);
    expect(out).toMatch(
      /^✓ azure host myres\.openai\.azure\.com \(\[providers\.azure\] endpoint\), api version 2024-10-21 \(\[providers\.azure\] api_version\), key AZURE_OPENAI_API_KEY, family "gpt" from models\.toml \(rewire would derive "deepseek" for azure:DeepSeek-R1\)$/m,
    );
    const [, same] = await doctor(
      toml(
        `available = ["azure:prod"]\n[providers.azure]\nendpoint = "https://myres.openai.azure.com"\napi_version = "v1"\nfamily = "gpt"\n`,
      ),
      { AZURE_OPENAI_API_KEY: FAKE },
    );
    expect(same).toMatch(/key AZURE_OPENAI_API_KEY, family "gpt" from models\.toml$/m);
  });

  test("env sources, bearer and profile auth, a family override that matches", async () => {
    const f = toml(
      `available = ["bedrock:anthropic.claude-opus-5-5", "vertex:claude-opus-5-5", "foundry:claude-x", "rt:openrouter/auto", "same:claude-opus-5-5"]
[endpoints.rt]
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OR_KEY"
family = "mixed"
[endpoints.same]
base_url = "https://same.example/v1"
api_key_env = "SAME_KEY"
family = "claude"
`,
    );
    const [, out] = await doctor(f, {
      AWS_DEFAULT_REGION: "ap-south-1",
      AWS_BEARER_TOKEN_BEDROCK: FAKE,
      ANTHROPIC_VERTEX_PROJECT_ID: "envproj",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_FOUNDRY_API_KEY: FAKE,
      ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example/anthropic",
      OR_KEY: FAKE,
      SAME_KEY: FAKE,
    });
    expect(out).not.toContain(FAKE);
    expect(out).toMatch(
      /^✓ bedrock region ap-south-1 \(AWS_DEFAULT_REGION\), auth AWS_BEARER_TOKEN_BEDROCK$/m,
    );
    expect(out).toMatch(
      /^✓ vertex project envproj \(ANTHROPIC_VERTEX_PROJECT_ID\), region us-east5 \(CLOUD_ML_REGION\), auth Google application default credentials$/m,
    );
    expect(out).toMatch(
      /^✓ foundry host foundry\.example \(ANTHROPIC_FOUNDRY_BASE_URL\), key ANTHROPIC_FOUNDRY_API_KEY$/m,
    );
    expect(out).toMatch(
      /^✓ endpoint rt host openrouter\.ai, key OR_KEY, family "mixed" from models\.toml \(rewire cannot derive one for rt:openrouter\/auto\)$/m,
    );
    expect(out).toMatch(
      /^✓ endpoint same host same\.example, key SAME_KEY, family "claude" from models\.toml$/m,
    );
    const [, profile] = await doctor(toml(`available = ["bedrock:anthropic.claude-opus-5-5"]\n`), {
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "work",
    });
    expect(profile).toMatch(/^✓ bedrock region us-east-1 \(AWS_REGION\), auth AWS_PROFILE$/m);
    expect(profile).not.toContain("work");
    const [, chain] = await doctor(toml(`available = ["bedrock:anthropic.claude-opus-5-5"]\n`), {
      AWS_REGION: "us-east-1",
    });
    expect(chain).toMatch(/^✓ bedrock .*auth the AWS default credential chain$/m);
  });

  test("Azure without an API version is flagged, naming the toml key and env var", async () => {
    const [code, out] = await doctor(
      toml(
        `available = ["azure:dep"]\n[providers.azure]\nendpoint = "https://myres.openai.azure.com"\n`,
      ),
      { AZURE_OPENAI_API_KEY: FAKE },
    );
    expect(code).toBe(1);
    expect(out).not.toContain(FAKE);
    expect(out).toMatch(
      /^✗ azure — no Azure OpenAI API version — set \[providers\.azure\] api_version in models\.toml, or OPENAI_API_VERSION/m,
    );
  });

  test("Azure lists every missing piece on its one line", async () => {
    const [code, out] = await doctor(toml(`available = ["azure:dep"]\n`), {});
    expect(code).toBe(1);
    const line = out.split("\n").find((l) => l.startsWith("✗ azure")) ?? "";
    expect(line).toContain("AZURE_OPENAI_API_KEY is not set");
    expect(line).toContain("no Azure OpenAI endpoint");
    expect(line).toContain("no Azure OpenAI API version");
    expect(line).toContain("OPENAI_API_VERSION");
  });

  test("a missing region, project or key is a failed line with the provider's hint", async () => {
    const f = toml(
      `available = ["bedrock:anthropic.claude-opus-5-5", "vertex:claude-opus-5-5", "gemini:gemini-2.5-pro", "groq:llama-3.3-70b"]
[endpoints.groq]
base_url = "https://api.groq.com/openai/v1"
api_key_env = "GROQ_API_KEY"
`,
    );
    const [code, out] = await doctor(f, {});
    expect(code).toBe(1);
    expect(out).toMatch(
      /^✗ bedrock — no AWS region for bedrock — set \[providers\.bedrock\] region/m,
    );
    expect(out).toMatch(
      /^✗ vertex — no Google Cloud project for vertex — set \[providers\.vertex\]/m,
    );
    expect(out).toMatch(/^✗ gemini — GEMINI_API_KEY is not set/m);
    expect(out).toMatch(/^✗ endpoint groq — GROQ_API_KEY is not set/m);
  });

  test("a [providers.*] table no model uses is still checked; first-party providers get no line", async () => {
    const [, out] = await doctor(
      toml(
        `available = ["anthropic:claude-opus-5-5"]\n[providers.bedrock]\nregion = "us-east-1"\n`,
      ),
      { ANTHROPIC_API_KEY: FAKE },
    );
    expect(out).toMatch(/^✓ bedrock region us-east-1/m);
    expect(out).not.toMatch(/^. anthropic/m);
    expect(out).not.toContain(FAKE);
  });

  test("values of an unusual shape are never echoed (a secret pasted into the wrong key)", async () => {
    const f = toml(
      `available = ["vertex:claude-opus-5-5", "azure:dep", "bedrock:anthropic.claude-opus-5-5", "foundry:claude-opus-5-5"]
[providers.vertex]
project = "Proj${FAKE}Q"
[providers.azure]
endpoint = "https://myres.openai.azure.com"
api_version = "v${FAKE}"
`,
    );
    const [, out] = await doctor(f, {
      AZURE_OPENAI_API_KEY: "k",
      AWS_REGION: `Us${FAKE}`,
      CLOUD_ML_REGION: `R${FAKE}`,
      ANTHROPIC_FOUNDRY_API_KEY: "k",
      ANTHROPIC_FOUNDRY_RESOURCE: `9${FAKE}`,
    });
    expect(out).not.toContain(FAKE);
    expect(out).toMatch(
      /^✓ vertex project \(set, unusual format\) \(\[providers\.vertex\] project\), region \(set, unusual format\) \(CLOUD_ML_REGION\)/m,
    );
    expect(out).toMatch(/api version \(set, unusual format\) \(\[providers\.azure\] api_version\)/);
    expect(out).toMatch(/^✓ bedrock region \(set, unusual format\) \(AWS_REGION\)/m);
    expect(out).toMatch(
      /^✓ foundry resource \(set, unusual format\) \(ANTHROPIC_FOUNDRY_RESOURCE\)/m,
    );
  });

  test("a failing table no model uses is a note, not a failure; a used one fails", async () => {
    const [, out] = await doctor(
      toml(
        `available = ["anthropic:claude-opus-5-5", "groq:llama-3.3-70b"]
[providers.bedrock]
region = "us-east-1"
[providers.azure]
endpoint = "https://myres.openai.azure.com"
[endpoints.spare]
base_url = "https://spare.example/v1"
api_key_env = "SPARE_KEY"
[endpoints.groq]
base_url = "https://api.groq.com/openai/v1"
api_key_env = "GROQ_API_KEY"
`,
      ),
      {},
    );
    expect(out).toMatch(/^✓ bedrock region us-east-1/m);
    expect(out).toMatch(/^! azure \(no model uses it\) — AZURE_OPENAI_API_KEY is not set/m);
    expect(out).toMatch(/^! endpoint spare \(no model uses it\) — SPARE_KEY is not set/m);
    expect(out).not.toMatch(/^✗ (azure|endpoint spare)/m);
    expect(out).toMatch(/^✗ endpoint groq — GROQ_API_KEY is not set/m);
  });

  test("an unused failing table leaves the exit code as it would be without it", async () => {
    const code = (body: string) =>
      runDoctor(toml(body), process.platform, {
        stdout: { write: () => true } as unknown as NodeJS.WritableStream,
        env: { ...process.env, GOOGLE_CLOUD_PROJECT: "", ANTHROPIC_VERTEX_PROJECT_ID: "" },
        cwd: tmp(),
      } as Parameters<typeof runDoctor>[2]);
    const baseline = await code(`available = ["anthropic:claude-opus-5-5"]\n`);
    const unused = await code(
      `available = ["anthropic:claude-opus-5-5"]\n[providers.vertex]\nregion = "us-east5"\n`,
    );
    const used = await code(
      `available = ["vertex:claude-opus-5-5"]\n[providers.vertex]\nregion = "us-east5"\n`,
    );
    expect(unused).toBe(baseline);
    expect(used).toBe(1);
  });

  test("an env value with a terminal escape is printed sanitized", async () => {
    const [, out] = await doctor(toml(`available = ["vertex:claude-opus-5-5"]\n`), {
      ANTHROPIC_VERTEX_PROJECT_ID: "p\x1b[2Jq",
    });
    expect(out).not.toContain("\x1b");
  });
});

describe("chat and run resolve an endpoint from models.toml", () => {
  test("the provider for an endpoint ref sends to its base_url with its key", async () => {
    const f = toml(
      `available = ["groq:llama-3.3-70b"]
[endpoints.groq]
base_url = "https://api.groq.com/openai/v1"
api_key_env = "GROQ_API_KEY"
`,
    );
    const env = { GROQ_API_KEY: FAKE };
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, auth: req.headers.get("authorization") });
      return new Response(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          created: 0,
          model: "llama-3.3-70b",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "hi" },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    // The same two calls `rewire run` and `rewire chat` make.
    const models = await resolveModels(f, tmp(), env, undefined);
    const ref = models.available[0];
    expect(ref).toEqual({ provider: "groq", model: "llama-3.3-70b" });
    const provider = providerFactory(env, undefined, models.providers)(ref as never);
    const reply = await provider.chat({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 16,
    });
    expect(reply.message.text).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0]?.auth).toBe(`Bearer ${FAKE}`);
  });
});

describe("a misconfigured provider for any routed role fails before anything is billed", () => {
  /**
   * anthropic writes and openai verifies (the chat and its compaction verifier work); only the
   * Azure reviewer, which a chat uses once a run reaches review, has no API version.
   */
  const body = `available = ["anthropic:claude-opus-5-5", "azure:gpt-5-deploy", "openai:gpt-5"]
[roles]
reviewer = "azure:gpt-5-deploy"
verifier = "openai:gpt-5"
[providers.azure]
endpoint = "https://myres.openai.azure.com"
`;
  const env = {
    ANTHROPIC_API_KEY: `sk-ant-${FAKE}`,
    OPENAI_API_KEY: `sk-${FAKE}`,
    AZURE_OPENAI_API_KEY: FAKE,
    PATH: process.env.PATH ?? "",
  };
  const sink = (to: string[]) =>
    ({
      write: (s: string) => {
        to.push(String(s));
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const recordFetch = () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 500 });
    });
    return calls;
  };

  test("rewire run: provider_auth_missing before the pipeline starts or any provider call", async () => {
    const calls = recordFetch();
    const repo = tmp();
    const out: string[] = [];
    await expect(
      runCommand(
        { task: "do thing", repo, models: toml(body), headless: true },
        {
          stdout: sink(out),
          stderr: sink(out),
          stdin: process.stdin,
          env,
          cwd: repo,
        } as Parameters<typeof runCommand>[1],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "provider_auth_missing",
      hint: expect.stringContaining("api_version"),
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(repo, ".rewire"))).toBe(false);
    expect(out.join("")).not.toContain(FAKE);
  });

  test("rewire chat: provider_auth_missing before the UI starts or any provider call", async () => {
    const calls = recordFetch();
    const repo = tmp();
    const tty = { isTTY: true, write: () => true };
    await expect(
      chatCommand({ repo, models: toml(body) }, {
        stdin: tty,
        stdout: tty,
        stderr: tty,
        env,
        cwd: repo,
        onSigint: () => () => {},
        exit: () => {
          throw new Error("exit");
        },
      } as unknown as Parameters<typeof chatCommand>[1]),
    ).rejects.toMatchObject({ code: "provider_auth_missing" });
    expect(calls).toEqual([]);
  });

  test("createRoutedProviders creates each distinct routed ref once, and nothing else", async () => {
    const models = await resolveModels(
      toml(`available = ["anthropic:a", "openai:b", "ollama:llama3.1"]\n`),
      tmp(),
      {},
      undefined,
    );
    const routing = resolveRouting(models.available, models.overrides);
    const made: string[] = [];
    createRoutedProviders(routing, (ref) => {
      made.push(`${ref.provider}:${ref.model}`);
      return { chat: async () => Promise.reject(new Error("never called")) };
    });
    expect(made.sort()).toEqual(["anthropic:a", "ollama:llama3.1", "openai:b"]);
  });
});

describe("doctor: the Ollama reply timeout and its source", () => {
  const withOllama = async (run: (host: string) => Promise<void>): Promise<void> => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === "/api/version" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.9.0" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  };
  test.each([
    ["default", `available = ["ollama:m"]\n`, {}, "900s (default)"],
    [
      "models.toml",
      `available = ["ollama:m"]\n[providers.ollama]\ntimeout_s = 1800\n`,
      {},
      "1800s (models.toml)",
    ],
    [
      "env over models.toml",
      `available = ["ollama:m"]\n[providers.ollama]\ntimeout_s = 1800\n`,
      { REWIRE_OLLAMA_TIMEOUT_S: "600" },
      "600s (env)",
    ],
  ])("%s", async (_name, body, env, shown) => {
    await withOllama(async (host) => {
      const [, out] = await doctor(toml(body), { OLLAMA_HOST: host, ...env });
      expect(out).toContain(`✓ ollama 0.9.0 at ${host}, reply timeout ${shown}\n`);
    });
  });
});

describe("ollamaTimeoutOption", () => {
  const ollama = { provider: "ollama", model: "m" } as const;
  const other = { provider: "anthropic", model: "a" } as const;
  test("resolves only when a ref is an Ollama model, with the toml settings", () => {
    expect(ollamaTimeoutOption([other], {}, { ollama: { timeoutS: 60 } })).toEqual({});
    expect(ollamaTimeoutOption([other, ollama], {}, { ollama: { timeoutS: 60 } })).toEqual({
      ollamaTimeout: { ms: 60_000, source: "models.toml" },
    });
    expect(ollamaTimeoutOption([ollama], { REWIRE_OLLAMA_TIMEOUT_S: "5" })).toEqual({
      ollamaTimeout: { ms: 5_000, source: "env" },
    });
  });
  test("an invalid variable is left to the provider to refuse", () => {
    expect(ollamaTimeoutOption([ollama], { REWIRE_OLLAMA_TIMEOUT_S: "15m" })).toEqual({});
  });
});
