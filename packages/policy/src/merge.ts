import { RewireError } from "@rewire/core";
import type { Policy } from "./defaults.js";

const ARRAY_FIELDS = ["testGlobs", "protectedGlobs", "credentialDenyGlobs", "gates"] as const;
const LOWER_ONLY = ["maxFixRounds", "noProgressRounds", "gateTimeoutMs"] as const;

function loosening(field: string, why: string): RewireError {
  return new RewireError("policy_loosening", `policy_loosening: ${field} ${why}`);
}

/** Overlay may only tighten the base: supersets, higher confidence, lower limits, appended rules. */
export function mergeTightenOnly(base: Policy, overlay: Partial<Policy>): Policy {
  const out: Policy = structuredClone(base);

  for (const f of ARRAY_FIELDS) {
    const v = overlay[f];
    if (v === undefined) continue;
    const missing = base[f].filter((x) => !v.includes(x));
    if (missing.length > 0)
      throw loosening(f, `must be a superset of the base (missing: ${missing.join(", ")})`);
    out[f] = [...new Set([...base[f], ...v])];
  }

  const conf = overlay.reviewerMinConfidence;
  if (conf !== undefined) {
    if (conf < base.reviewerMinConfidence)
      throw loosening(
        "reviewerMinConfidence",
        `may not be lowered below ${base.reviewerMinConfidence}`,
      );
    out.reviewerMinConfidence = conf;
  }

  for (const f of LOWER_ONLY) {
    const v = overlay[f];
    if (v === undefined) continue;
    if (v > base[f]) throw loosening(f, `may not be raised above ${base[f]}`);
    out[f] = v;
  }

  if (overlay.commandRules)
    out.commandRules = [...base.commandRules, ...structuredClone(overlay.commandRules)];
  return out;
}
