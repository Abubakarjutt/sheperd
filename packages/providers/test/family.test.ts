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
