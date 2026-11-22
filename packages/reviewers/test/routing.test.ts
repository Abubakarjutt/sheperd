import { DEFAULT_POLICY } from "@rewire/policy";
import { FauxProvider, text } from "@rewire/providers";
import { expect, test } from "vitest";
import { type DiffSummary, REVIEWERS, runPanel, selectReviewers } from "../src/index.js";
import { hostClient, makeRepo, put } from "./helpers.js";

const model = { provider: "ollama", model: "faux" } as const;
const contract = {
  id: "c1",
  title: "t",
  criteria: [{ id: "AC-1", statement: "does a thing" }],
  nonGoals: [],
  affectedAreas: [],
  openQuestions: [],
};

const patchOf = (added: string[]): string =>
  `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}\n`;
const diffOf = (added: string[], over: Partial<DiffSummary> = {}): DiffSummary => ({
  files: [{ path: "a.ts", addedLines: added.map((_, i) => i + 1) }],
  patch: patchOf(added),
  truncated: false,
  omitted: [],
  forced: [],
  ...over,
});
const names = (d: DiffSummary) => selectReviewers(d).map((r) => r.name);

test("security and spec-compliance always selected", () => {
  const docs = diffOf(["# hello docs"]);
  expect(names(docs)).toEqual(["security", "spec-compliance"]);
  expect(names(diffOf([], { files: [], patch: "" }))).toEqual(["security", "spec-compliance"]);
});

test("silent-failure selected when diff adds catch; order follows REVIEWERS", () => {
  expect(names(diffOf(["try { x() } catch (e) {}"]))).toEqual([
    "security",
    "spec-compliance",
    "silent-failure",
  ]);
  expect(REVIEWERS.map((r) => r.name)).toEqual(["security", "spec-compliance", "silent-failure"]);
});

test.each([
  "} catch (e) {",
  "const a = b ?? 0;",
  "const a = b || 0;",
  "// TODO later",
  "// FIXME later",
  "console.error(e);",
  "console.warn(e);",
  "p.catch(() => {});",
  "await Promise.allSettled(ps);",
])("silent-failure triggers on %s", (line) => {
  expect(names(diffOf([line]))).toContain("silent-failure");
});

test("silent-failure ignores removed and context lines, and plain code", () => {
  expect(names(diffOf(["const a = 1 + 2;"]))).not.toContain("silent-failure");
  const removedOnly: DiffSummary = {
    ...diffOf(["const a = 1;"]),
    patch:
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,1 @@\n-try {} catch {}\n context catch\n+const a = 1;\n",
  };
  expect(names(removedOnly)).not.toContain("silent-failure");
});

test("silent-failure is selected when the patch was truncated (cannot prove absence)", () => {
  expect(names(diffOf(["const a = 1;"], { truncated: true }))).toContain("silent-failure");
});

async function panelSetup(
  script: string[],
  over: Partial<DiffSummary> = {},
  added = ["const a = b ?? 0;"],
) {
  const root = makeRepo({ "a.ts": "x\n" });
  put(root, "a.ts", `x\n${added.join("\n")}\n`);
  const { buildDiffSummary } = await import("../src/index.js");
  const client = hostClient();
  const built = await buildDiffSummary(root, "HEAD", { client });
  const diff = { ...built, ...over };
  const provider = new FauxProvider(script.map((s) => text(s)));
  const run = (d: DiffSummary = diff) =>
    runPanel({
      diff: d,
      contract,
      worktree: root,
      model,
      provider,
      policy: DEFAULT_POLICY,
      emit: () => {},
      runId: "r1",
      client,
    });
  return { run, provider, diff };
}
const none = JSON.stringify({ findings: [] });
const forcedOne = {
  file: "a.ts",
  lineStart: 2,
  lineEnd: 2,
  evidence: "NUL byte in added line",
  failureScenario: "binary content hidden",
};

test("panel rejects if one reviewer fails, naming it", async () => {
  // Faux provider hands out scripted replies in call order; make the 3rd call garbage.
  const { run } = await panelSetup([none, none, "garbage", "garbage"]);
  await expect(run()).rejects.toThrow(/silent-failure|security|spec-compliance/);
  await expect(
    (async () => {
      const s = await panelSetup([
        "garbage",
        "garbage",
        "garbage",
        "garbage",
        "garbage",
        "garbage",
      ]);
      return s.run();
    })(),
  ).rejects.toMatchObject({ message: expect.stringMatching(/^reviewer "[a-z-]+" failed/) });
});

test("clean panel does not escalate", async () => {
  const { run } = await panelSetup([none, none, none]);
  const r = await run();
  expect(r).toMatchObject({
    kept: [],
    dropped: [],
    omitted: [],
    truncated: false,
    escalate: false,
    escalationReasons: [],
  });
});

test("panel escalates on truncated diff, even when reviewers report nothing", async () => {
  const { run, diff } = await panelSetup([none, none, none]);
  const r = await run({ ...diff, truncated: true });
  expect(r.escalate).toBe(true);
  expect(r.truncated).toBe(true);
  expect(r.escalationReasons.join(" ")).toMatch(/truncated/);
});

test("panel escalates on omitted files from the diff", async () => {
  const { run, diff } = await panelSetup([none, none, none]);
  const r = await run({ ...diff, omitted: ["img.png (binary)"] });
  expect(r.escalate).toBe(true);
  expect(r.omitted).toContain("img.png (binary)");
  expect(r.escalationReasons.join(" ")).toMatch(/omitted/);
});

test("panel escalates on forced findings and dedupes them across reviewers", async () => {
  const { run, diff } = await panelSetup([none, none, none]);
  const r = await run({ ...diff, forced: [forcedOne] });
  expect(r.escalate).toBe(true);
  expect(r.escalationReasons.join(" ")).toMatch(/forced/);
  expect(r.kept).toHaveLength(1);
  expect(r.kept[0]?.evidence).toBe("NUL byte in added line");
});

test("forced findings are not re-filtered and not dropped for synthetic evidence", async () => {
  const { run, diff } = await panelSetup([none, none, none]);
  const r = await run({ ...diff, forced: [forcedOne] });
  expect(r.dropped).toEqual([]);
});

test("a skipped-only forced finding still escalates (no model verdict needed)", async () => {
  const { run, diff } = await panelSetup([none, none], {}, ["const a = 1 + 2;"]);
  const r = await run({ ...diff, forced: [forcedOne] });
  expect(r.escalate).toBe(true);
  expect(r.kept).toHaveLength(1);
});
