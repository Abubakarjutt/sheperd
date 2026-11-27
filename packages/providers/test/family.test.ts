import { RewireError } from "@rewire/core";
import { describe, expect, test } from "vitest";
import {
  endpointConfig,
  isEndpointName,
  modelFamily,
  parseModelRef,
  registerEndpoints,
} from "../src/index.js";

describe("modelFamily", () => {
  test("families", () => {
    expect(modelFamily({ provider: "ollama", model: "qwen2.5-coder:7b" })).toBe("qwen");
    expect(modelFamily({ provider: "ollama", model: "llama3.1" })).toBe("llama");
    expect(modelFamily({ provider: "ollama", model: "gpt-oss:20b" })).toBe("gpt");
    expect(modelFamily({ provider: "anthropic", model: "claude-opus-5-5" })).toBe("claude");
    expect(modelFamily({ provider: "openai", model: "gpt-5" })).toBe("gpt");
    expect(modelFamily({ provider: "faux", model: "a" })).toBe("faux-a");
  });
  test("lineage aliases: code/reasoning variants share their base family (row 96)", () => {
    const fam = (model: string) => modelFamily({ provider: "ollama", model });
    expect(fam("codellama:13b")).toBe("llama");
    expect(fam("llava:7b")).toBe("llama");
    expect(fam("qwq:32b")).toBe("qwen");
    expect(fam("codeqwen:7b")).toBe("qwen");
    expect(fam("codegemma:7b")).toBe("gemma");
    expect(fam("deepseek-r1:14b")).toBe("deepseek");
  });
  test("ollama registry/namespace prefixes are stripped", () => {
    expect(
      modelFamily({ provider: "ollama", model: "hf.co/Qwen/Qwen2.5-Coder-7B-GGUF:Q4_K_M" }),
    ).toBe("qwen");
    expect(modelFamily({ provider: "ollama", model: "library/llama3.1" })).toBe("llama");
    expect(modelFamily({ provider: "ollama", model: "registry.example.com/me/gpt-oss:20b" })).toBe(
      "gpt",
    );
  });
  test("unknown provider throws", () => {
    expect(() =>
      modelFamily({ provider: "mystery", model: "x" } as unknown as Parameters<
        typeof modelFamily
      >[0]),
    ).toThrow(RewireError);
  });
  test("empty model throws", () => {
    expect(() => modelFamily({ provider: "openai", model: "" })).toThrow(RewireError);
  });
});

describe("parseModelRef", () => {
  test("splits on first colon", () => {
    expect(parseModelRef("ollama:qwen2.5-coder:7b")).toEqual({
      provider: "ollama",
      model: "qwen2.5-coder:7b",
    });
  });
  test("rejects unknown provider and missing model", () => {
    expect(() => parseModelRef("nope:x")).toThrow(RewireError);
    expect(() => parseModelRef("openai")).toThrow(RewireError);
    expect(() => parseModelRef("openai:")).toThrow(RewireError);
  });
});

describe("cloud providers and endpoints", () => {
  test("bedrock, vertex and foundry are claude; a non-Claude model there is refused", () => {
    expect(modelFamily(parseModelRef("bedrock:anthropic.claude-opus-5-5"))).toBe("claude");
    expect(modelFamily(parseModelRef("vertex:claude-opus-5-5@20261101"))).toBe("claude");
    expect(modelFamily(parseModelRef("foundry:claude-opus-5-5"))).toBe("claude");
    for (const ref of ["bedrock:anthropic.llama3", "vertex:gemini-2.5-pro", "foundry:my-deploy"]) {
      expect(() => modelFamily(parseModelRef(ref))).toThrowError(
        expect.objectContaining({ code: "model_ref_invalid" }),
      );
    }
  });
  test("azure is gpt and gemini is gemini", () => {
    expect(modelFamily(parseModelRef("azure:my-gpt-deployment"))).toBe("gpt");
    expect(modelFamily(parseModelRef("gemini:gemini-2.5-pro"))).toBe("gemini");
  });

  test("an endpoint ref fails before registration, parses after, and fails after undo", () => {
    expect(() => parseModelRef("groq:llama-3.3-70b")).toThrowError(
      expect.objectContaining({ code: "model_ref_invalid" }),
    );
    const undo = registerEndpoints({ groq: { baseUrl: "https://api.groq.com/openai/v1" } });
    try {
      expect(parseModelRef("groq:llama-3.3-70b")).toEqual({
        provider: "groq",
        model: "llama-3.3-70b",
      });
      expect(endpointConfig("groq")).toEqual({ baseUrl: "https://api.groq.com/openai/v1" });
    } finally {
      undo();
    }
    expect(() => parseModelRef("groq:llama-3.3-70b")).toThrowError(
      expect.objectContaining({ code: "model_ref_invalid" }),
    );
    expect(endpointConfig("groq")).toBeUndefined();
  });

  test("undo restores an endpoint registered before", () => {
    const first = registerEndpoints({ ep: { baseUrl: "https://a.example/v1" } });
    try {
      const second = registerEndpoints({ ep: { baseUrl: "https://b.example/v1" } });
      expect(endpointConfig("ep")?.baseUrl).toBe("https://b.example/v1");
      second();
      expect(endpointConfig("ep")?.baseUrl).toBe("https://a.example/v1");
    } finally {
      first();
    }
  });

  test("an endpoint name that is a built-in provider or malformed is refused", () => {
    for (const name of ["openai", "bedrock", "Groq", "1x", "a_b", "x".repeat(33)]) {
      expect(() => registerEndpoints({ [name]: { baseUrl: "https://x.example" } })).toThrowError(
        expect.objectContaining({ code: "model_ref_invalid" }),
      );
    }
    expect(isEndpointName("openai")).toBe(false);
  });

  test.each([
    ["anthropic/claude-opus-5-5", "claude"],
    ["claude-sonnet-5", "claude"],
    ["openai/gpt-5", "gpt"],
    ["gpt-4o-mini", "gpt"],
    ["o1-mini", "gpt"],
    ["o3", "gpt"],
    ["o4-mini", "gpt"],
    ["openai/gpt-oss-120b", "gpt"],
    ["google/gemini-2.5-pro", "gemini"],
    ["google/gemma-3-27b-it", "gemma"],
    ["llama-3.3-70b-versatile", "llama"],
    ["meta-llama/Llama-3.3-70B-Instruct", "llama"],
    ["deepseek-chat", "deepseek"],
    ["mistral-large-latest", "mistral"],
    ["Qwen/QwQ-32B", "qwen"],
    ["accounts/fireworks/models/codellama-34b", "llama"],
  ])("endpoint model %s is %s", (model, family) => {
    const undo = registerEndpoints({ openrouter: { baseUrl: "https://openrouter.ai/api/v1" } });
    try {
      expect(modelFamily({ provider: "openrouter", model })).toBe(family);
    } finally {
      undo();
    }
  });

  test("a family is never derived from the endpoint name", () => {
    const undo = registerEndpoints({ claude: { baseUrl: "https://x.example/v1" } });
    try {
      expect(modelFamily(parseModelRef("claude:llama-3.3-70b"))).toBe("llama");
    } finally {
      undo();
    }
  });

  test("an endpoint family override wins over the model id", () => {
    const undo = registerEndpoints({
      corp: { baseUrl: "https://llm.corp.example/v1", family: "x" },
    });
    try {
      expect(modelFamily(parseModelRef("corp:claude-opus-5-5"))).toBe("x");
    } finally {
      undo();
    }
  });

  test("an unregistered endpoint ref throws model_ref_invalid", () => {
    expect(() => modelFamily({ provider: "openrouter", model: "gpt-5" })).toThrowError(
      expect.objectContaining({ code: "model_ref_invalid" }),
    );
  });
});
