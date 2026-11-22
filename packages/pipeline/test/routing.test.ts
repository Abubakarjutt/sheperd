import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFamily, parseModelRef } from "@rewire/providers";
import { expect, test } from "vitest";
import { loadModelsFile, resolveRouting } from "../src/routing.js";

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
