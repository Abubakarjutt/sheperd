import { z } from "zod";

export const SlopCategory = z.enum([
  "broken",
  "fake_verification",
  "spec_drift",
  "security",
  "silent_failure",
  "bloat",
  "convention_drift",
  "maintainability",
  "entropy",
]);
export type SlopCategory = z.infer<typeof SlopCategory>;

/** The first five categories block a run outright. */
export const HARD_BLOCK_CATEGORIES: ReadonlySet<SlopCategory> = new Set(
  SlopCategory.options.slice(0, 5),
);

/**
 * What a criterion asks of the change. `change`: new or corrected behaviour; its tests must fail
 * before the fix. `preserve`: behaviour that works today and the task says must keep working; its
 * tests must pass before the fix. Both kinds must pass after it.
 */
export const CriterionKind = z.enum(["change", "preserve"]);
export type CriterionKind = z.infer<typeof CriterionKind>;

export const Criterion = z.object({ id: z.string(), kind: CriterionKind, statement: z.string() });
export type Criterion = z.infer<typeof Criterion>;

/**
 * `kind` is required, with no default: the only place a contract is parsed is the spec model's
 * output (contract.json is written for the record, never read back), and a silent default would
 * hide an unlabelled criterion.
 */
export const Contract = z.object({
  id: z.string(),
  title: z.string(),
  criteria: z.array(Criterion).min(1),
  nonGoals: z.array(z.string()),
  affectedAreas: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type Contract = z.infer<typeof Contract>;

export const Finding = z.object({
  id: z.string(),
  reviewer: z.string(),
  category: SlopCategory,
  severity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  file: z.string(),
  lineStart: z.number(),
  lineEnd: z.number(),
  evidence: z.string().min(1),
  failureScenario: z.string().min(1),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const Verdict = z.object({
  findingId: z.string(),
  verdict: z.enum(["upheld", "refuted"]),
  reasoning: z.string(),
  verifierModel: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

export const GateResult = z.object({
  gate: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  category: SlopCategory,
  summary: z.string(),
  details: z.unknown(),
  durationMs: z.number(),
});
export type GateResult = z.infer<typeof GateResult>;

export const FrozenTestManifest = z.object({
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  criteriaToTests: z.record(z.string(), z.array(z.string())),
});
export type FrozenTestManifest = z.infer<typeof FrozenTestManifest>;

export const CheckpointKind = z.enum(["contract", "tests", "commit"]);
export type CheckpointKind = z.infer<typeof CheckpointKind>;

const CheckpointNote = z.string().min(1).max(2000);

export const CheckpointDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("revise"), note: CheckpointNote }),
  z.object({ action: z.literal("stop"), note: CheckpointNote.optional() }),
]);
export type CheckpointDecision = z.infer<typeof CheckpointDecision>;
