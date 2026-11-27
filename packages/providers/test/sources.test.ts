import { describe, expect, test } from "vitest";
import { resolveClaudeCloud } from "../src/claude-cloud.js";
import { azureSettings, geminiKey } from "../src/openai-compatible.js";
import { firstSet } from "../src/sources.js";

describe("value sources: each resolved value names where it came from", () => {
  test("firstSet takes the first non-blank value in order", () => {
    expect(
      firstSet([
        ["a", undefined],
        ["b", "  "],
        ["c", " x "],
        ["d", "y"],
      ]),
    ).toEqual({
      value: "x",
      source: "c",
    });
    expect(firstSet([["a", undefined]])).toBeUndefined();
  });

  test("bedrock region: toml, then AWS_REGION, then AWS_DEFAULT_REGION; a base URL override", () => {
    const env = { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "eu-west-1" };
    expect(
      resolveClaudeCloud("bedrock", { bedrock: { region: "us-west-2" } }, env).sources,
    ).toEqual({ region: "[providers.bedrock] region" });
    expect(resolveClaudeCloud("bedrock", {}, env).sources).toEqual({ region: "AWS_REGION" });
    expect(
      resolveClaudeCloud(
        "bedrock",
        {},
        {
          AWS_DEFAULT_REGION: "eu-west-1",
          ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "http://127.0.0.1:9/anthropic",
        },
      ).sources,
    ).toEqual({ region: "AWS_DEFAULT_REGION", baseUrl: "ANTHROPIC_BEDROCK_MANTLE_BASE_URL" });
  });

  test("vertex project and region, with the global default", () => {
    expect(
      resolveClaudeCloud(
        "vertex",
        {},
        { GOOGLE_CLOUD_PROJECT: "p-123", CLOUD_ML_REGION: "us-east5" },
      ).sources,
    ).toEqual({ project: "GOOGLE_CLOUD_PROJECT", region: "CLOUD_ML_REGION" });
    expect(
      resolveClaudeCloud(
        "vertex",
        { vertex: { project: "p-123" } },
        { ANTHROPIC_VERTEX_PROJECT_ID: "other" },
      ).sources,
    ).toEqual({ project: "[providers.vertex] project", region: "default" });
  });

  test("foundry: toml base_url, env base URL, toml or env resource", () => {
    const key = { ANTHROPIC_FOUNDRY_API_KEY: "k" };
    const src = (s: Parameters<typeof resolveClaudeCloud>[1], env: NodeJS.ProcessEnv) =>
      resolveClaudeCloud("foundry", s, { ...key, ...env }).sources;
    expect(src({ foundry: { baseUrl: "https://f.example/anthropic" } }, {})).toEqual({
      baseUrl: "[providers.foundry] base_url",
    });
    expect(src({}, { ANTHROPIC_FOUNDRY_BASE_URL: "https://f.example/anthropic" })).toEqual({
      baseUrl: "ANTHROPIC_FOUNDRY_BASE_URL",
    });
    expect(
      src({ foundry: { resource: "r" } }, { ANTHROPIC_FOUNDRY_BASE_URL: "https://f.example/a" }),
    ).toEqual({ resource: "[providers.foundry] resource" });
    expect(src({}, { ANTHROPIC_FOUNDRY_RESOURCE: "r" })).toEqual({
      resource: "ANTHROPIC_FOUNDRY_RESOURCE",
    });
  });

  test("azure endpoint and API version, gemini key", () => {
    const a = azureSettings(
      { azure: { endpoint: "https://r.openai.azure.com" } },
      { AZURE_OPENAI_ENDPOINT: "https://o.openai.azure.com", OPENAI_API_VERSION: "2024-10-21" },
    );
    expect(a.endpoint?.source).toBe("[providers.azure] endpoint");
    expect(a.apiVersion).toEqual({ value: "2024-10-21", source: "OPENAI_API_VERSION" });
    expect(a.apiKey).toBeUndefined();
    expect(geminiKey({ GOOGLE_API_KEY: "g" })?.source).toBe("GOOGLE_API_KEY");
    expect(geminiKey({ GEMINI_API_KEY: "a", GOOGLE_API_KEY: "g" })?.source).toBe("GEMINI_API_KEY");
  });
});
