import { DEFAULT_POLICY } from "@rewire/policy";
import { createProvider, type ModelRef } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import { buildDiffSummary, REVIEWERS, runReviewer } from "../src/index.js";
import { hostClient, makeRepo, put } from "./helpers.js";

const live = process.env.REWIRE_LIVE_TESTS === "1";

/** Same env convention as packages/providers/test/live.test.ts. */
function pickModel(): ModelRef | undefined {
  const a = process.env.REWIRE_LIVE_ANTHROPIC_MODEL;
  if (a) return { provider: "anthropic", model: a };
  const o = process.env.REWIRE_LIVE_OPENAI_MODEL;
  if (o) return { provider: "openai", model: o };
  const l = process.env.REWIRE_LIVE_OLLAMA_MODEL;
  if (l) return { provider: "ollama", model: l };
  return undefined;
}
const model = pickModel();

const contract = {
  id: "c-live",
  title: "Add a file download endpoint and a settings loader",
  criteria: [
    { id: "AC-1", statement: "GET /files?name=<n> returns a file from the uploads directory only" },
    { id: "AC-2", statement: "loadSettings(path) throws when the file is missing or invalid" },
  ],
  nonGoals: ["No caching layer"],
  affectedAreas: ["src"],
  openQuestions: [],
};

type Fixture = { reviewer: string; base: string; next: string; category: string; needle: string };
const fixtures: Fixture[] = [
  {
    reviewer: "security",
    base: "export {};\n",
    next: [
      "export {};",
      'import { readFileSync } from "node:fs";',
      'export function download(name: string) { return readFileSync("/srv/uploads/" + name, "utf8"); }',
      "",
    ].join("\n"),
    category: "security",
    needle: "readFileSync",
  },
  {
    reviewer: "spec-compliance",
    base: "export {};\n",
    next: [
      "export {};",
      "export function loadSettings(path: string) {",
      '  if (path === "settings.test.json") return { theme: "dark" };',
      "  return {};",
      "}",
      "",
    ].join("\n"),
    category: "spec_drift",
    needle: "loadSettings",
  },
  {
    reviewer: "silent-failure",
    base: "export {};\n",
    next: [
      "export {};",
      'import { readFileSync } from "node:fs";',
      "export function loadSettings(path: string) {",
      "  try {",
      "    return JSON.parse(readFileSync(path, 'utf8'));",
      "  } catch (e) {",
      "    return {};",
      "  }",
      "}",
      "",
    ].join("\n"),
    category: "silent_failure",
    needle: "catch",
  },
];

describe.skipIf(!live || !model)("live reviewers (planted defects)", () => {
  for (const fx of fixtures) {
    test(`${fx.reviewer} finds its planted defect`, async () => {
      const ref = model as ModelRef;
      const root = makeRepo({ "src/a.ts": fx.base });
      put(root, "src/a.ts", fx.next);
      const client = hostClient();
      const diff = await buildDiffSummary(root, "HEAD", { client });
      const def = REVIEWERS.find((r) => r.name === fx.reviewer);
      if (!def) throw new Error(`no reviewer ${fx.reviewer}`);
      const r = await runReviewer(def, {
        diff,
        contract,
        worktree: root,
        model: ref,
        provider: createProvider(ref, process.env),
        policy: DEFAULT_POLICY,
        emit: () => {},
        runId: "live",
        client,
      });
      expect(
        r.kept.some(
          (f) =>
            // Row 93: the needle must be in the evidence (every fixture changes src/a.ts, so a
            // file match alone proved nothing).
            f.category === fx.category && f.file === "src/a.ts" && f.evidence.includes(fx.needle),
        ),
      ).toBe(true);
    }, 300_000);
  }
});
