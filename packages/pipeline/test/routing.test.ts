import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { endpointConfig, type ModelRef, modelFamily, parseModelRef } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import {
  compactionLimitOverride,
  defaultCompactionConfig,
  loadModelsFile,
  MIN_ENDPOINT_CONTEXT_WINDOW,
  resolveRouting,
} from "../src/routing.js";

const refs = (...s: string[]) => s.map(parseModelRef);
const fam = (r: ReturnType<typeof parseModelRef>) => modelFamily(r);

test("routing picks cross-family reviewer when available", () => {
  const r = resolveRouting(
    refs("anthropic:claude-opus-5-5", "openai:gpt-5", "ollama:qwen2.5-coder:32b"),
  );
  expect(fam(r.reviewer)).not.toBe(fam(r.implementer));
  expect(r.independence).toBe("cross-family");
  expect(r.spec).toEqual(r.implementer);
  expect(r["test-writer"]).toEqual(r.implementer);
});

test("three families: verifier differs from implementer and reviewer", () => {
  const r = resolveRouting(
    refs("anthropic:claude-opus-5-5", "openai:gpt-5", "ollama:qwen2.5-coder:32b"),
  );
  expect(new Set([fam(r.implementer), fam(r.reviewer), fam(r.verifier)]).size).toBe(3);
});

test("two families: verifier differs from implementer (reuses reviewer family)", () => {
  const r = resolveRouting(refs("anthropic:claude-opus-5-5", "openai:gpt-5", "openai:gpt-5-mini"));
  expect(fam(r.verifier)).not.toBe(fam(r.implementer));
  expect(r.independence).toBe("cross-family");
});

test("single provider yields same-family", () => {
  const r = resolveRouting(refs("ollama:qwen2.5-coder:32b"));
  expect(r.independence).toBe("same-family");
  expect(r.reviewer).toEqual(r.implementer);
  expect(r.verifier).toEqual(r.implementer);
});

test("one family with several models is same-family", () => {
  const r = resolveRouting(refs("anthropic:a", "anthropic:b"));
  expect(r.independence).toBe("same-family");
});

test("empty available throws", () => {
  expect(() => resolveRouting([])).toThrow(/no models/i);
});

test("overrides win and independence is recomputed", () => {
  const avail = refs("anthropic:a", "openai:b");
  const r = resolveRouting(avail, { reviewer: parseModelRef("anthropic:a") });
  expect(r.reviewer).toEqual(parseModelRef("anthropic:a"));
  expect(r.independence).toBe("same-family");
  const r2 = resolveRouting(avail, { implementer: parseModelRef("openai:b") });
  expect(r2.implementer).toEqual(parseModelRef("openai:b"));
  expect(r2.independence).toBe("cross-family");
});

test("override not in available throws", () => {
  expect(() =>
    resolveRouting(refs("anthropic:a"), { reviewer: parseModelRef("openai:b") }),
  ).toThrow(/available/);
});

const file = (body: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), "rw-models-")), "models.toml");
  writeFileSync(p, body);
  return p;
};

test("loadModelsFile reads a good file", async () => {
  const m = await loadModelsFile(
    file(
      `available = ["anthropic:claude-opus-5-5", "ollama:qwen2.5-coder:32b"]\n[roles]\nverifier = "ollama:qwen2.5-coder:32b"\n`,
    ),
  );
  expect(m.available).toHaveLength(2);
  expect(m.overrides.verifier).toEqual({ provider: "ollama", model: "qwen2.5-coder:32b" });
});

test("loadModelsFile rejects unknown role, empty available, bad ref", async () => {
  await expect(
    loadModelsFile(file(`available = ["anthropic:a"]\n[roles]\nplanner = "anthropic:a"\n`)),
  ).rejects.toThrow(/planner/);
  await expect(loadModelsFile(file(`available = []\n`))).rejects.toThrow(/available/);
  await expect(loadModelsFile(file(`available = ["nope"]\n`))).rejects.toThrow(
    /model ref|provider/i,
  );
});

test("a bad ref keeps parseModelRef's hint: declare [endpoints.<name>]", async () => {
  const err = await loadModelsFile(file(`available = ["groq:llama-3.3-70b"]\n`)).catch(
    (e: unknown) => e,
  );
  expect(err).toMatchObject({ code: "models_file_invalid" });
  expect((err as Error).message).toMatch(/available\.0.*unknown provider/);
  expect((err as RewireError).hint).toMatch(/\[endpoints\.groq\] in models\.toml/);
  const role = await loadModelsFile(
    file(`available = ["anthropic:a"]\n[roles]\nreviewer = "nope:x"\n`),
  ).catch((e: unknown) => e);
  expect((role as RewireError).hint).toMatch(/\[endpoints\.nope\]/);
  const compaction = await loadModelsFile(
    file(`available = ["anthropic:a"]\n[compaction.models."nope:x"]\nlimit = 50000\n`),
  ).catch((e: unknown) => e);
  expect(compaction).toMatchObject({ code: "models_file_invalid" });
  expect((compaction as RewireError).hint).toMatch(/\[endpoints\.nope\]/);
});

test("loadModelsFile rejects a top-level typo like [role]", async () => {
  await expect(
    loadModelsFile(file(`available = ["anthropic:a"]\n[role]\nverifier = "anthropic:a"\n`)),
  ).rejects.toThrow(/role/);
});

describe("loadModelsFile [compaction]", () => {
  const base = `available = ["anthropic:a"]\n`;

  test("a file without [compaction] gets the defaults", async () => {
    const m = await loadModelsFile(file(base));
    expect(m.compaction).toEqual(defaultCompactionConfig());
    expect(defaultCompactionConfig()).toEqual({
      latencyBudgetS: 60,
      recentUserTokens: 20000,
      limits: {},
    });
  });

  test("reads budgets and per-model limits", async () => {
    const m = await loadModelsFile(
      file(
        `${base}[compaction]\nlatency_budget_s = 90\nrecent_user_tokens = 8000\n[compaction.models."ollama:qwen3.8:27b-mlx"]\nlimit = 32000\n[compaction.models."anthropic:claude-opus-5-5"]\nlimit = 150000\n`,
      ),
    );
    expect(m.compaction).toEqual({
      latencyBudgetS: 90,
      recentUserTokens: 8000,
      limits: { "ollama:qwen3.8:27b-mlx": 32000, "anthropic:claude-opus-5-5": 150000 },
    });
    expect(
      compactionLimitOverride(m.compaction, { provider: "ollama", model: "qwen3.8:27b-mlx" }),
    ).toBe(32000);
    expect(compactionLimitOverride(m.compaction, { provider: "ollama", model: "other" })).toBe(
      undefined,
    );
  });

  test("a partial [compaction] table keeps the other defaults", async () => {
    const m = await loadModelsFile(file(`${base}[compaction]\nlatency_budget_s = 5\n`));
    expect(m.compaction).toEqual({ latencyBudgetS: 5, recentUserTokens: 20000, limits: {} });
  });

  test.each([
    ["unknown key", `[compaction]\nlatency_budget = 60\n`, /latency_budget/],
    ["budget below 5", `[compaction]\nlatency_budget_s = 4\n`, /latency_budget_s/],
    ["budget above 3600", `[compaction]\nlatency_budget_s = 3601\n`, /latency_budget_s/],
    ["budget as a string", `[compaction]\nlatency_budget_s = "60"\n`, /latency_budget_s/],
    ["recent below 1000", `[compaction]\nrecent_user_tokens = 999\n`, /recent_user_tokens/],
    ["recent above 200000", `[compaction]\nrecent_user_tokens = 200001\n`, /recent_user_tokens/],
    ["recent not an integer", `[compaction]\nrecent_user_tokens = 1500.5\n`, /recent_user_tokens/],
    ["limit below 4096", `[compaction.models."anthropic:a"]\nlimit = 4095\n`, /limit/],
    ["limit not an integer", `[compaction.models."anthropic:a"]\nlimit = 5000.5\n`, /limit/],
    ["limit missing", `[compaction.models."anthropic:a"]\n`, /limit/],
    ["unknown model key", `[compaction.models."anthropic:a"]\nlimit = 5000\nmax = 1\n`, /max/],
    ["bad model ref", `[compaction.models."nope"]\nlimit = 5000\n`, /nope/],
    ["models not a table", `[compaction]\nmodels = 3\n`, /models/],
  ])("rejects %s with models_file_invalid", async (_name, body, why) => {
    const err = await loadModelsFile(file(`${base}${body}`)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RewireError);
    expect(err).toMatchObject({ code: "models_file_invalid" });
    expect((err as Error).message).toMatch(why);
  });
});

describe("loadModelsFile [web]", () => {
  const base = `available = ["anthropic:a"]\n`;

  test("a file without [web] gets the defaults (auto-selected search, 5 results)", async () => {
    const m = await loadModelsFile(file(base));
    expect(m.web).toEqual({ maxResults: 5 });
  });

  test("reads search, searxng_url and max_results", async () => {
    const m = await loadModelsFile(
      file(
        `${base}[web]\nsearch = "searxng"\nsearxng_url = "http://127.0.0.1:8888"\nmax_results = 10\n`,
      ),
    );
    expect(m.web).toEqual({
      search: "searxng",
      searxngUrl: "http://127.0.0.1:8888",
      maxResults: 10,
    });
    const t = await loadModelsFile(file(`${base}[web]\nsearch = "tavily"\n`));
    expect(t.web).toEqual({ search: "tavily", maxResults: 5 });
    const h = await loadModelsFile(
      file(`${base}[web]\nsearxng_url = "https://searx.example/sub"\nmax_results = 1\n`),
    );
    expect(h.web).toEqual({ searxngUrl: "https://searx.example/sub", maxResults: 1 });
  });

  test.each([
    ["an unknown backend", `[web]\nsearch = "google"\n`, /web\.search/],
    ["an unknown key", `[web]\nsearch_url = "x"\n`, /search_url/],
    ["max_results 0", `[web]\nmax_results = 0\n`, /web\.max_results/],
    ["max_results 11", `[web]\nmax_results = 11\n`, /web\.max_results/],
    ["max_results not an integer", `[web]\nmax_results = 2.5\n`, /web\.max_results/],
    ["searxng without a url", `[web]\nsearch = "searxng"\n`, /web\.searxng_url/],
    ["an http searxng_url off loopback", `[web]\nsearxng_url = "http://searx.example"\n`, /https/],
    ["a searxng_url with a query", `[web]\nsearxng_url = "https://s.example/?k=1"\n`, /query/],
    ["a searxng_url that is not a url", `[web]\nsearxng_url = "searx"\n`, /searxng_url/],
    ["web not a table", `web = 3\n`, /web/],
  ])("rejects %s with models_file_invalid", async (_name, body, why) => {
    const err = await loadModelsFile(file(`${base}${body}`)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RewireError);
    expect(err).toMatchObject({ code: "models_file_invalid" });
    expect((err as Error).message).toMatch(why);
  });
});

describe("loadModelsFile [providers] and [endpoints]", () => {
  test("reads provider settings and endpoints, and registers the endpoints", async () => {
    const m = await loadModelsFile(
      file(
        [
          `available = ["bedrock:anthropic.claude-opus-5-5", "openrouter:anthropic/claude-opus-5-5", "local:qwen3:32b"]`,
          `[roles]`,
          `reviewer = "local:qwen3:32b"`,
          `[providers.bedrock]`,
          `region = "us-east-1"`,
          `[providers.vertex]`,
          `project = "my-proj"`,
          `region = "global"`,
          `[providers.foundry]`,
          `resource = "my-res"`,
          `base_url = "https://my-res.services.ai.azure.com/anthropic"`,
          `[providers.azure]`,
          `endpoint = "https://my.openai.azure.com"`,
          `api_version = "2025-04-01-preview"`,
          `[providers.ollama]`,
          `timeout_s = 1800`,
          `[endpoints.openrouter]`,
          `base_url = "https://openrouter.ai/api/v1"`,
          `api_key_env = "OPENROUTER_API_KEY"`,
          `max_tokens_field = "max_completion_tokens"`,
          `[endpoints.local]`,
          `base_url = "http://127.0.0.1:8080/v1"`,
          `family = "qwen"`,
          `context_window = 65536`,
          `[compaction.models."local:qwen3:32b"]`,
          `limit = 32000`,
          ``,
        ].join("\n"),
      ),
    );
    expect(m.providers).toEqual({
      bedrock: { region: "us-east-1" },
      vertex: { project: "my-proj", region: "global" },
      foundry: { resource: "my-res", baseUrl: "https://my-res.services.ai.azure.com/anthropic" },
      azure: { endpoint: "https://my.openai.azure.com", apiVersion: "2025-04-01-preview" },
      ollama: { timeoutS: 1800 },
    });
    expect(m.endpoints).toEqual({
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        maxTokensField: "max_completion_tokens",
      },
      local: { baseUrl: "http://127.0.0.1:8080/v1", family: "qwen", contextWindow: 65536 },
    });
    expect(m.available[1]).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-5-5" });
    expect(m.overrides.reviewer).toEqual({ provider: "local", model: "qwen3:32b" });
    expect(m.compaction.limits).toEqual({ "local:qwen3:32b": 32000 });
    expect(parseModelRef("openrouter:x")).toEqual({ provider: "openrouter", model: "x" });
    expect(endpointConfig("local")?.family).toBe("qwen");
  });

  test("an OpenRouter Claude cannot review a Bedrock Claude implementer", async () => {
    const m = await loadModelsFile(
      file(
        `available = ["bedrock:anthropic.claude-opus-5-5", "or2:anthropic/claude-opus-5-5", "openai:gpt-5"]\n[endpoints.or2]\nbase_url = "https://openrouter.ai/api/v1"\napi_key_env = "OPENROUTER_API_KEY"\n`,
      ),
    );
    const r = resolveRouting(m.available);
    expect(r.reviewer).toEqual({ provider: "openai", model: "gpt-5" });
    expect(modelFamily(m.available[1] as ModelRef)).toBe("claude");
  });

  test("a file without the new tables has neither field", async () => {
    const m = await loadModelsFile(file(`available = ["anthropic:a"]\n`));
    expect(m.providers).toBeUndefined();
    expect(m.endpoints).toBeUndefined();
  });

  test.each([
    ["unknown provider table", `[providers.aws]\nregion = "x"\n`, /aws/],
    ["unknown provider key", `[providers.bedrock]\nprofile = "x"\n`, /profile/],
    ["unknown ollama key", `[providers.ollama]\nhost = "x"\n`, /host/],
    ["ollama timeout_s of 0", `[providers.ollama]\ntimeout_s = 0\n`, /timeout_s/],
    ["ollama timeout_s over a day", `[providers.ollama]\ntimeout_s = 86401\n`, /timeout_s/],
    ["fractional ollama timeout_s", `[providers.ollama]\ntimeout_s = 1.5\n`, /timeout_s/],
    ["ollama timeout_s as a string", `[providers.ollama]\ntimeout_s = "900"\n`, /timeout_s/],
    [
      "unknown endpoint key",
      `[endpoints.e1]\nbase_url = "https://x.example"\napi_key_env = "K"\nkey = "sk"\n`,
      /key/,
    ],
    [
      "bad endpoint name",
      `[endpoints.Bad_Name]\nbase_url = "https://x.example"\napi_key_env = "K"\n`,
      /Bad_Name/,
    ],
    [
      "name colliding with openai",
      `[endpoints.openai]\nbase_url = "https://x.example"\napi_key_env = "K"\n`,
      /openai/,
    ],
    [
      "name colliding with gemini",
      `[endpoints.gemini]\nbase_url = "https://x.example"\napi_key_env = "K"\n`,
      /gemini/,
    ],
    [
      "http non-loopback base_url",
      `[endpoints.e2]\nbase_url = "http://api.example.com/v1"\napi_key_env = "K"\n`,
      /base_url/,
    ],
    [
      "base_url not a url",
      `[endpoints.e3]\nbase_url = "api.example.com"\napi_key_env = "K"\n`,
      /base_url/,
    ],
    [
      "missing api_key_env off loopback",
      `[endpoints.e4]\nbase_url = "https://x.example"\n`,
      /api_key_env/,
    ],
    [
      "api_key_env holding a key",
      `[endpoints.e5]\nbase_url = "https://x.example"\napi_key_env = "sk-abc def"\n`,
      /api_key_env/,
    ],
    [
      "context_window below 4096",
      `[endpoints.e6]\nbase_url = "https://x.example"\napi_key_env = "K"\ncontext_window = 4095\n`,
      /context_window/,
    ],
    [
      "bad max_tokens_field",
      `[endpoints.e7]\nbase_url = "https://x.example"\napi_key_env = "K"\nmax_tokens_field = "max"\n`,
      /max_tokens_field/,
    ],
    [
      "http azure endpoint",
      `[providers.azure]\nendpoint = "http://my.openai.azure.com"\n`,
      /endpoint/,
    ],
    [
      "base_url with userinfo",
      `[endpoints.e8]\nbase_url = "https://sk-secret@x.example/v1"\napi_key_env = "K"\n`,
      /base_url/,
    ],
    [
      "base_url with user and password",
      `[endpoints.e9]\nbase_url = "https://u:p@x.example/v1"\napi_key_env = "K"\n`,
      /base_url/,
    ],
    [
      "base_url with a query",
      `[endpoints.e10]\nbase_url = "https://x.example/v1?api_key=sk-secret"\napi_key_env = "K"\n`,
      /base_url/,
    ],
    [
      "azure endpoint with userinfo",
      `[providers.azure]\nendpoint = "https://k@my.openai.azure.com"\n`,
      /endpoint/,
    ],
  ])("rejects %s with models_file_invalid", async (_name, body, why) => {
    const err = await loadModelsFile(file(`available = ["anthropic:a"]\n${body}`)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RewireError);
    expect(err).toMatchObject({ code: "models_file_invalid" });
    expect((err as Error).message).toMatch(why);
  });

  test("[providers.foundry] base_url and [providers.azure] endpoint take loopback http, as their env forms do", async () => {
    const m = await loadModelsFile(
      file(
        `available = ["anthropic:a"]\n[providers.foundry]\nbase_url = "http://localhost:8080/anthropic"\n[providers.azure]\nendpoint = "http://127.0.0.1:9000"\n`,
      ),
    );
    expect(m.providers?.foundry?.baseUrl).toBe("http://localhost:8080/anthropic");
    expect(m.providers?.azure?.endpoint).toBe("http://127.0.0.1:9000");
  });

  test("loopback http needs no api_key_env", async () => {
    for (const [name, url] of [
      ["lo1", "http://localhost:11434/v1"],
      ["lo2", "http://127.0.0.1:8080/v1"],
      ["lo3", "http://[::1]:8080/v1"],
    ] as const) {
      const m = await loadModelsFile(
        file(`available = ["${name}:m"]\n[endpoints.${name}]\nbase_url = "${url}"\n`),
      );
      expect(m.endpoints?.[name]).toEqual({ baseUrl: url });
    }
  });

  test("a file whose refs fail leaves no endpoint registered", async () => {
    const err = await loadModelsFile(
      file(
        `available = ["leak:m", "nope:x"]\n[endpoints.leak]\nbase_url = "https://x.example"\napi_key_env = "K"\n`,
      ),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "models_file_invalid" });
    expect(() => parseModelRef("leak:m")).toThrowError(
      expect.objectContaining({ code: "model_ref_invalid" }),
    );
  });

  test("an endpoint ref without the endpoint table is refused", async () => {
    await expect(loadModelsFile(file(`available = ["groq:llama-3.3-70b"]\n`))).rejects.toThrow(
      /groq/,
    );
  });
});

describe("loadModelsFile: refs checked at load, one file's endpoints at a time", () => {
  test.each([
    [
      "a non-Claude bedrock ref",
      `available = ["anthropic:a", "bedrock:meta.llama3"]\n`,
      /available\.1/,
    ],
    [
      "a non-Claude vertex role",
      `available = ["anthropic:a"]\n[roles]\nreviewer = "vertex:gemini-2.5-pro"\n`,
      /roles\.reviewer/,
    ],
    [
      "an endpoint router id without family",
      `available = ["anthropic:a", "rt:openrouter/auto"]\n[endpoints.rt]\nbase_url = "https://openrouter.ai/api/v1"\napi_key_env = "K"\n`,
      /available\.1.*family/,
    ],
  ])("rejects %s with models_file_invalid and its path", async (_name, body, why) => {
    const err = await loadModelsFile(file(body)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "models_file_invalid" });
    expect((err as Error).message).toMatch(why);
  });

  test("a router id with an explicit family loads", async () => {
    const m = await loadModelsFile(
      file(
        `available = ["rt2:openrouter/auto"]\n[endpoints.rt2]\nbase_url = "https://openrouter.ai/api/v1"\napi_key_env = "K"\nfamily = "mixed"\n`,
      ),
    );
    expect(modelFamily(m.available[0] as ModelRef)).toBe("mixed");
  });

  test("a later load replaces the earlier file's endpoints; a failed load keeps them", async () => {
    await loadModelsFile(
      file(
        `available = ["fa:m"]\n[endpoints.fa]\nbase_url = "https://a.example/v1"\napi_key_env = "K"\n`,
      ),
    );
    expect(endpointConfig("fa")?.baseUrl).toBe("https://a.example/v1");
    const bad = await loadModelsFile(
      file(
        `available = ["fb:m", "nope:x"]\n[endpoints.fb]\nbase_url = "https://b.example/v1"\napi_key_env = "K"\n`,
      ),
    ).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: "models_file_invalid" });
    expect(endpointConfig("fa")?.baseUrl).toBe("https://a.example/v1");
    expect(endpointConfig("fb")).toBeUndefined();
    await expect(loadModelsFile(file(`available = ["fa:m"]\n`))).rejects.toMatchObject({
      code: "models_file_invalid",
    });
    await loadModelsFile(file(`available = ["anthropic:a"]\n`));
    expect(endpointConfig("fa")).toBeUndefined();
    expect(() => parseModelRef("fa:m")).toThrowError(
      expect.objectContaining({ code: "model_ref_invalid" }),
    );
  });

  test("the endpoint window minimum is its own constant", () => {
    expect(MIN_ENDPOINT_CONTEXT_WINDOW).toBe(4096);
  });
});

describe("Gemma and Azure deployments of other vendors are not independent", () => {
  test("gemini:gemma and ollama:gemma are one family", () => {
    const r = resolveRouting(refs("gemini:gemma-3-27b-it", "ollama:gemma3:27b"));
    expect(r.independence).toBe("same-family");
  });
  test("azure:DeepSeek-R1 and ollama:deepseek-r1 are one family", () => {
    const r = resolveRouting(refs("azure:DeepSeek-R1", "ollama:deepseek-r1:70b"));
    expect(r.independence).toBe("same-family");
  });
  test("[providers.azure] family loads, is registered, and a later file without it clears it", async () => {
    const m = await loadModelsFile(
      file(
        `available = ["azure:prod", "ollama:llama3.1"]\n[providers.azure]\nendpoint = "https://my.openai.azure.com"\nfamily = "llama"\n`,
      ),
    );
    expect(m.providers?.azure).toEqual({
      endpoint: "https://my.openai.azure.com",
      family: "llama",
    });
    expect(fam(parseModelRef("azure:prod"))).toBe("llama");
    expect(resolveRouting(m.available).independence).toBe("same-family");
    // A failed load keeps the previous file's override.
    await expect(
      loadModelsFile(
        file(`available = ["azure:prod"]\n[providers.azure]\nfamily = "Bad Family"\n`),
      ),
    ).rejects.toMatchObject({ code: "models_file_invalid" });
    expect(fam(parseModelRef("azure:prod"))).toBe("llama");
    await loadModelsFile(file(`available = ["azure:prod"]\n`));
    expect(fam(parseModelRef("azure:prod"))).toBe("gpt");
  });
});
