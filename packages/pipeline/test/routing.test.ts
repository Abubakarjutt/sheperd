import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { modelFamily, parseModelRef } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import {
  compactionLimitOverride,
  DEFAULT_COMPACTION_CONFIG,
  loadModelsFile,
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

test("loadModelsFile rejects a top-level typo like [role]", async () => {
  await expect(
    loadModelsFile(file(`available = ["anthropic:a"]\n[role]\nverifier = "anthropic:a"\n`)),
  ).rejects.toThrow(/role/);
});

describe("loadModelsFile [compaction]", () => {
  const base = `available = ["anthropic:a"]\n`;

  test("a file without [compaction] gets the defaults", async () => {
    const m = await loadModelsFile(file(base));
    expect(m.compaction).toEqual(DEFAULT_COMPACTION_CONFIG);
    expect(DEFAULT_COMPACTION_CONFIG).toEqual({
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
