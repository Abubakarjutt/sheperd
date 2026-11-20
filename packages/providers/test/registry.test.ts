import { describe, expect, test } from "vitest";
import { createProvider, FauxProvider, registerProvider } from "../src/index.js";

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
  test("ollama unknown until Task 7", () => {
    expect(() => createProvider({ provider: "ollama", model: "m" }, {})).toThrowError(
      expect.objectContaining({ code: "provider_unknown" }),
    );
  });
  test("faux registered by default with empty script; registerProvider overrides", () => {
    expect(createProvider({ provider: "faux", model: "m" }, {})).toBeInstanceOf(FauxProvider);
    const custom = new FauxProvider([]);
    registerProvider("ollama", () => custom);
    expect(createProvider({ provider: "ollama", model: "m" }, {})).toBe(custom);
  });
});
