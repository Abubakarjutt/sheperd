import { RewireError, type RunEvent } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";
import { call, FauxProvider, type ScriptEntry, text } from "@rewire/providers";
import type { SandboxClient } from "@rewire/sandbox";
import { expect, test } from "vitest";
import { runSpecStage } from "../src/index.js";

const client = {} as SandboxClient;
const model = { provider: "ollama", model: "faux" } as const;

function contractJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "c1",
    title: "Add thing",
    criteria: [
      { id: "x", statement: "returns 1" },
      { id: "y", statement: "returns 2" },
    ],
    nonGoals: ["no ui"],
    affectedAreas: ["src/a.ts"],
    openQuestions: [],
    ...over,
  });
}

function setup(
  script: ScriptEntry[],
  ask = async (_q: string[]): Promise<string[] | null> => null,
) {
  const provider = new FauxProvider(script);
  const events: RunEvent[] = [];
  const run = (emit: (e: RunEvent) => void = (e) => events.push(e)) =>
    runSpecStage({
      task: "add a thing",
      worktree: "/tmp/none",
      model,
      provider,
      ask,
      emit,
      runId: "r1",
      client,
      policy: DEFAULT_POLICY,
    });
  return { provider, events, run };
}

test("compiles contract and renumbers criteria", async () => {
  const { run, events } = setup([text("explored"), text(contractJson())]);
  const c = await run();
  expect(c.criteria.map((x) => x.id)).toEqual(["AC-1", "AC-2"]);
  expect(c.criteria.map((x) => x.statement)).toEqual(["returns 1", "returns 2"]);
  expect(events.map((e) => e.type)).toEqual(["stage_start", "stage_end"]);
  const end = events[1];
  expect(end?.type === "stage_end" && end.ok).toBe(true);
  expect(events[0]).toMatchObject({ stage: "spec", runId: "r1" });
});

test("open questions with no human throws clarification_required carrying questions", async () => {
  const { run } = setup([text("x"), text(contractJson({ openQuestions: ["Q one?", "Q two?"] }))]);
  const err = await run().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RewireError);
  expect((err as RewireError).code).toBe("clarification_required");
  expect((err as RewireError).message).toBe("Q one?\nQ two?");
});

test("answers trigger exactly one recompile", async () => {
  const { run, provider } = setup(
    [
      text("x"),
      text(contractJson({ openQuestions: ["Which db?"] })),
      text(contractJson({ criteria: [{ id: "q", statement: "uses sqlite" }] })),
    ],
    async () => ["sqlite"],
  );
  const c = await run();
  expect(provider.callCount).toBe(3); // 1 exploration + 2 structured
  expect(c.criteria).toEqual([{ id: "AC-1", statement: "uses sqlite" }]);
  const second = provider.requests[2]?.messages[0]?.content ?? "";
  const first = provider.requests[1]?.messages[0]?.content ?? "";
  expect(second.startsWith(first)).toBe(true);
  expect(second).toContain("Q: Which db?\nA: sqlite");
});

test("exploration error throws and emits stage_end ok:false", async () => {
  const { run, events } = setup([
    () => {
      throw new RewireError("boom", "provider down");
    },
  ]);
  const err = await run().catch((e: unknown) => e);
  expect((err as RewireError).code).toBe("boom");
  const end = events.at(-1);
  expect(end?.type === "stage_end" && end.ok).toBe(false);
});

test("a throwing emit does not break the stage", async () => {
  const { run } = setup([text("x"), text(contractJson())]);
  const c = await run(() => {
    throw new Error("observer down");
  });
  expect(c.criteria).toHaveLength(2);
});

test("tool_call summaries are redacted and capped", async () => {
  const secret = "sk-abc123DEF456ghi789";
  const { run, events } = setup([
    call("read", { path: `${secret}.txt`, pad: "p".repeat(300) }),
    text("done"),
    text(contractJson()),
  ]);
  await run();
  const tc = events.find((e) => e.type === "tool_call");
  expect(tc?.type === "tool_call" && tc.stage).toBe("spec");
  const summary = tc?.type === "tool_call" ? tc.summary : "";
  expect(summary.startsWith("read ")).toBe(true);
  expect(summary).toContain("[redacted]");
  expect(summary).not.toContain("abc123");
  expect(summary.length).toBeLessThanOrEqual(5 + 120);
});

test("mismatched answer count throws clarification_required", async () => {
  const { run } = setup(
    [text("x"), text(contractJson({ openQuestions: ["a?", "b?"] }))],
    async () => ["only one"],
  );
  const err = await run().catch((e: unknown) => e);
  expect((err as RewireError).code).toBe("clarification_required");
});

test("open questions remaining after recompile throws clarification_required", async () => {
  const { run } = setup(
    [
      text("x"),
      text(contractJson({ openQuestions: ["a?"] })),
      text(contractJson({ openQuestions: ["still b?"] })),
    ],
    async () => ["ans"],
  );
  const err = await run().catch((e: unknown) => e);
  expect((err as RewireError).code).toBe("clarification_required");
  expect((err as RewireError).message).toBe("still b?");
});
