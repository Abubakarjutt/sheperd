import { z } from "zod";
import { CheckpointDecision, CheckpointKind, Finding, GateResult, Verdict } from "./schemas.js";

const base = { runId: z.string(), ts: z.iso.datetime() };
const staged = { ...base, stage: z.string() };

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run_start"), task: z.string(), repo: z.string() }),
  z.object({ ...staged, type: z.literal("stage_start") }),
  z.object({ ...staged, type: z.literal("stage_end"), ok: z.boolean() }),
  z.object({
    ...staged,
    type: z.literal("tool_call"),
    tool: z.string(),
    isError: z.boolean(),
    summary: z.string(),
  }),
  z.object({ ...staged, type: z.literal("gate_result"), result: GateResult }),
  z.object({ ...staged, type: z.literal("finding"), finding: Finding }),
  z.object({ ...staged, type: z.literal("verdict"), verdict: Verdict }),
  z.object({
    ...staged,
    type: z.literal("checkpoint"),
    kind: CheckpointKind,
    decision: CheckpointDecision,
  }),
  z.object({
    ...staged,
    type: z.literal("skill_loaded"),
    name: z.string(),
    source: z.enum(["user", "repo"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ ...base, type: z.literal("fix_round"), round: z.number(), score: z.number() }),
  z.object({
    ...base,
    type: z.literal("escalation"),
    reason: z.string(),
    question: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("run_end"),
    status: z.enum(["verified", "escalated"]),
    reportPath: z.string(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
