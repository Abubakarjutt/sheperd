import { describe, expect, test } from "vitest";
import {
  createProvider,
  FauxProvider,
  OllamaProvider,
  parseModelRef,
  registerEndpoints,
  registerProvider,
} from "../src/index.js";

describe("createProvider", () => {
  test("provider_auth_missing for absent and empty keys, without leaking values", () => {
    expect(() => createProvider({ provider: "anthropic", model: "m" }, {})).toThrowError(
      expect.objectContaining({
        code: "provider_auth_missing",
        message: "ANTHROPIC_API_KEY is not set",
      }),
    );
    expect(() =>
      createProvider({ provider: "openai", model: "m" }, { OPENAI_API_KEY: "" }),
    ).toThrowError(expect.objectContaining({ code: "provider_auth_missing" }));
  });
  test("creates anthropic and openai with a key", () => {
    expect(
      createProvider({ provider: "anthropic", model: "m" }, { ANTHROPIC_API_KEY: "k" }),
    ).toBeTruthy();
    expect(
      createProvider({ provider: "openai", model: "m" }, { OPENAI_API_KEY: "k" }),
    ).toBeTruthy();
  });
  test("ollama is registered by default and needs no key", () => {
    expect(createProvider({ provider: "ollama", model: "m" }, {})).toBeInstanceOf(OllamaProvider);
  });
  test("faux registered by default with empty script; registerProvider overrides", () => {
    expect(createProvider({ provider: "faux", model: "m" }, {})).toBeInstanceOf(FauxProvider);
    const custom = new FauxProvider([]);
    const restore = registerProvider("ollama", () => custom);
    try {
      expect(createProvider({ provider: "ollama", model: "m" }, {})).toBe(custom);
    } finally {
      restore();
    }
    expect(createProvider({ provider: "ollama", model: "m" }, {})).toBeInstanceOf(OllamaProvider);
  });
});

describe("createProvider: names a later task wires up", () => {
  test("azure, gemini and endpoints fail cleanly with provider_unknown", () => {
    const undo = registerEndpoints({ groq: { baseUrl: "https://api.groq.com/openai/v1" } });
    try {
      for (const ref of ["azure:gpt-5", "gemini:gemini-2.5-pro", "groq:m"]) {
        expect(() => createProvider(parseModelRef(ref), {})).toThrowError(
          expect.objectContaining({ code: "provider_unknown" }),
        );
      }
    } finally {
      undo();
    }
  });
});
