import { readFile } from "node:fs/promises";
import { RewireError } from "@rewire/core";
import { type ModelRef, modelFamily, parseModelRef } from "@rewire/providers";
import { parse } from "smol-toml";
import { z } from "zod";

export const ROLES = ["spec", "test-writer", "implementer", "reviewer", "verifier"] as const;
export type Role = (typeof ROLES)[number];

export type RoleRouting = Record<Role, ModelRef> & { independence: "cross-family" | "same-family" };
export type ModelsFile = {
  available: ModelRef[];
  overrides: Partial<Record<Role, ModelRef>>;
  /** The chat session's compaction settings (`[compaction]`); defaults when the table is absent. */
  compaction: CompactionConfig;
};

/**
 * `[compaction]` in models.toml. `limits` maps a canonical `provider:model` to a fixed compaction
 * limit in tokens (`[compaction.models."<provider:model>"] limit = N`), replacing the adaptive one.
 */
export type CompactionConfig = {
  /** Seconds of prompt reading one turn may cost (`latency_budget_s`, 5 to 3600). */
  latencyBudgetS: number;
  /** Tokens of recent user messages kept verbatim (`recent_user_tokens`, 1000 to 200000). */
  recentUserTokens: number;
  limits: Record<string, number>;
};

export const DEFAULT_LATENCY_BUDGET_S = 60;
export const DEFAULT_RECENT_USER_TOKENS = 20_000;
/** The smallest compaction limit, configured or computed. */
export const MIN_COMPACTION_LIMIT = 4096;

/** A fresh copy of the defaults, safe to mutate. */
export const defaultCompactionConfig = (): CompactionConfig => ({
  latencyBudgetS: DEFAULT_LATENCY_BUDGET_S,
  recentUserTokens: DEFAULT_RECENT_USER_TOKENS,
  limits: {},
});

/** The configured fixed limit for `ref`, if any. */
export function compactionLimitOverride(
  config: CompactionConfig,
  ref: ModelRef,
): number | undefined {
  return Object.hasOwn(config.limits, show(ref)) ? config.limits[show(ref)] : undefined;
}

const same = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;
const show = (r: ModelRef): string => `${r.provider}:${r.model}`;

/**
 * Assign models to roles. The author roles use available[0]; the reviewer is the first model of
 * another family; the verifier prefers a family distinct from both, then one distinct from the
 * implementer, then falls back to the reviewer. Overrides win but must be in `available`;
 * `independence` is computed from the final assignment.
 */
export function resolveRouting(
  available: ModelRef[],
  overrides: Partial<Record<Role, ModelRef>> = {},
): RoleRouting {
  const author = available[0];
  if (author === undefined) {
    throw new RewireError("routing_no_models", "no models available", "list at least one model");
  }
  for (const [role, ref] of Object.entries(overrides)) {
    if (ref !== undefined && !available.some((a) => same(a, ref))) {
      throw new RewireError(
        "routing_override_unavailable",
        `override for role "${role}" (${show(ref)}) is not in the available models`,
      );
    }
  }
  const implementer = overrides.implementer ?? author;
  const implFam = modelFamily(implementer);
  const reviewer =
    overrides.reviewer ?? available.find((m) => modelFamily(m) !== implFam) ?? implementer;
  const revFam = modelFamily(reviewer);
  const verifier =
    overrides.verifier ??
    available.find((m) => {
      const f = modelFamily(m);
      return f !== implFam && f !== revFam;
    }) ??
    available.find((m) => modelFamily(m) !== implFam) ??
    reviewer;
  const independence =
    modelFamily(reviewer) !== implFam && modelFamily(verifier) !== implFam
      ? "cross-family"
      : "same-family";
  return {
    spec: overrides.spec ?? author,
    "test-writer": overrides["test-writer"] ?? author,
    implementer,
    reviewer,
    verifier,
    independence,
  };
}

const RefString = z.string().transform((s, ctx) => {
  try {
    return parseModelRef(s);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
    return z.NEVER;
  }
});

const CompactionToml = z.strictObject({
  latency_budget_s: z.number().min(5).max(3600).optional(),
  recent_user_tokens: z.number().int().min(1000).max(200_000).optional(),
  models: z
    .record(z.string(), z.strictObject({ limit: z.number().int().min(MIN_COMPACTION_LIMIT) }))
    .optional(),
});

const ModelsToml = z.strictObject({
  available: z.array(RefString).min(1, "available must list at least one model"),
  compaction: CompactionToml.optional(),
  roles: z
    .object(Object.fromEntries(ROLES.map((r) => [r, RefString.optional()])))
    .strict()
    .optional(),
});

/** Read `available = [...]` and the optional `[roles]` and `[compaction]` tables from a TOML file. */
export async function loadModelsFile(path: string): Promise<ModelsFile> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new RewireError(
      "models_file_invalid",
      `cannot read models file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const r = ModelsToml.safeParse(raw);
  if (!r.success) {
    const why = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new RewireError("models_file_invalid", `invalid models file ${path}: ${why}`);
  }
  const overrides: Partial<Record<Role, ModelRef>> = {};
  for (const role of ROLES) {
    const ref = (r.data.roles as Record<string, ModelRef | undefined> | undefined)?.[role];
    if (ref) overrides[role] = ref;
  }
  return {
    available: r.data.available,
    overrides,
    compaction: compactionConfig(r.data.compaction, path),
  };
}

function compactionConfig(
  raw: z.infer<typeof CompactionToml> | undefined,
  path: string,
): CompactionConfig {
  const config = defaultCompactionConfig();
  if (raw === undefined) return config;
  if (raw.latency_budget_s !== undefined) config.latencyBudgetS = raw.latency_budget_s;
  if (raw.recent_user_tokens !== undefined) config.recentUserTokens = raw.recent_user_tokens;
  for (const [key, { limit }] of Object.entries(raw.models ?? {})) {
    let ref: ModelRef;
    try {
      ref = parseModelRef(key);
    } catch (e) {
      throw new RewireError(
        "models_file_invalid",
        `invalid models file ${path}: compaction.models.${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    config.limits[show(ref)] = limit;
  }
  return config;
}
