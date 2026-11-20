import { describe, expect, test } from "vitest";
import { createProvider } from "../src/index.js";

const live = process.env.REWIRE_LIVE_TESTS === "1";
const anthropicModel = process.env.REWIRE_LIVE_ANTHROPIC_MODEL;
const openaiModel = process.env.REWIRE_LIVE_OPENAI_MODEL;

describe.skipIf(!live)("live providers", () => {
  test.skipIf(!anthropicModel)("anthropic smoke", async () => {
    const model = anthropicModel as string;
    const p = createProvider({ provider: "anthropic", model }, process.env);
    const r = await p.chat({
      model,
      system: "Reply briefly.",
      messages: [{ role: "user", content: "Say hello." }],
      maxTokens: 64,
    });
    expect(r.message.text.length).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });
  test.skipIf(!openaiModel)("openai smoke", async () => {
    const model = openaiModel as string;
    const p = createProvider({ provider: "openai", model }, process.env);
    const r = await p.chat({
      model,
      system: "Reply briefly.",
      messages: [{ role: "user", content: "Say hello." }],
      maxTokens: 64,
    });
    expect(r.message.text.length).toBeGreaterThan(0);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });
});

const ollamaModel = process.env.REWIRE_LIVE_OLLAMA_MODEL;

describe.skipIf(!live || !ollamaModel)("live ollama", () => {
  test("probe, model info and role-fitness smoke test", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { assertRoleFit, getModelInfo, normalizeOllamaHost, probeOllama } = await import(
      "../src/index.js"
    );
    const model = ollamaModel as string;
    const base = normalizeOllamaHost(process.env.OLLAMA_HOST);
    expect((await probeOllama(base)).version).toMatch(/^\d+\./);
    expect((await getModelInfo(base, model)).digest.length).toBeGreaterThan(0);
    const dir = await mkdtemp(join(tmpdir(), "rewire-live-"));
    await assertRoleFit({ provider: "ollama", model }, "reviewer", dir, { baseUrl: base });
  }, 300_000);
});
