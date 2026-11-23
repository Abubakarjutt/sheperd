import { RewireError } from "@rewire/core";
import { describe, expect, test } from "vitest";
import { modelFamily, parseModelRef } from "../src/index.js";

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
