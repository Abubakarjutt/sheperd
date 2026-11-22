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
};

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

const ModelsToml = z.object({
  available: z.array(RefString).min(1, "available must list at least one model"),
  roles: z
    .object(Object.fromEntries(ROLES.map((r) => [r, RefString.optional()])))
    .strict()
    .optional(),
});

/** Read `available = [...]` and an optional `[roles]` table from a TOML file. */
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
  return { available: r.data.available, overrides };
}
