import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { parse } from "smol-toml";
import { z } from "zod";
import { DEFAULT_POLICY, type Policy } from "./defaults.js";
import { mergeTightenOnly } from "./merge.js";
import { selfTestRules } from "./rules.js";

const commandRule = z.strictObject({
  pattern: z.array(z.union([z.string(), z.array(z.string())])).min(1),
  decision: z.enum(["allow", "forbidden"]),
  justification: z.string().optional(),
  match: z.array(z.string()).optional(),
  notMatch: z.array(z.string()).optional(),
});

const overlaySchema = z
  .strictObject({
    testGlobs: z.array(z.string()),
    protectedGlobs: z.array(z.string()),
    credentialDenyGlobs: z.array(z.string()),
    gates: z.array(z.string()),
    reviewerMinConfidence: z.number().min(0).max(1),
    maxFixRounds: z.number().int().positive(),
    noProgressRounds: z.number().int().positive(),
    gateTimeoutMs: z.number().int().positive(),
    commandRules: z.array(commandRule),
  })
  .partial();

export async function loadPolicy(repoRoot: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(join(repoRoot, ".rewire", "policy.toml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    selfTestRules(DEFAULT_POLICY.commandRules);
    return structuredClone(DEFAULT_POLICY);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new RewireError(
      "policy_invalid",
      `.rewire/policy.toml is not valid TOML: ${(e as Error).message}`,
    );
  }
  const parsed = overlaySchema.safeParse(raw);
  if (!parsed.success)
    throw new RewireError(
      "policy_invalid",
      `.rewire/policy.toml: ${z.prettifyError(parsed.error)}`,
    );
  const policy = mergeTightenOnly(DEFAULT_POLICY, parsed.data as Partial<Policy>);
  selfTestRules(policy.commandRules);
  return policy;
}
