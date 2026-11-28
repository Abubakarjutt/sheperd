import { RewireError } from "@rewire/core";
import type { Policy, WebPolicy } from "./defaults.js";
import { domainWithin } from "./web.js";

/** One policy layer: any field may be left out, and `web` field by field. */
export type PolicyOverlay = Partial<Omit<Policy, "web">> & { web?: Partial<WebPolicy> };

const ARRAY_FIELDS = ["testGlobs", "protectedGlobs", "credentialDenyGlobs", "gates"] as const;
const LOWER_ONLY = ["maxFixRounds", "noProgressRounds", "gateTimeoutMs"] as const;

function loosening(field: string, why: string): RewireError {
  return new RewireError("policy_loosening", `policy_loosening: ${field} ${why}`);
}

/**
 * Overlay may only tighten the base: supersets, lower limits, a lower reviewer confidence
 * threshold (findings below it are dropped, so lower keeps more), appended rules.
 */
export function mergeTightenOnly(base: Policy, overlay: PolicyOverlay): Policy {
  const out: Policy = structuredClone(base);

  for (const f of ARRAY_FIELDS) {
    const v = overlay[f];
    if (v === undefined) continue;
    const missing = base[f].filter((x) => !v.includes(x));
    if (missing.length > 0)
      throw loosening(f, `must be a superset of the base (missing: ${missing.join(", ")})`);
    out[f] = [...new Set([...base[f], ...v])];
  }

  // R39: lower-only with a floor of 0; raising it drops more findings, which loosens review.
  const conf = overlay.reviewerMinConfidence;
  if (conf !== undefined) {
    if (!(conf >= 0)) throw loosening("reviewerMinConfidence", `must be at least 0 (got ${conf})`);
    if (conf > base.reviewerMinConfidence)
      throw loosening(
        "reviewerMinConfidence",
        `may not be raised above ${base.reviewerMinConfidence} (a higher threshold drops more findings)`,
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
  if (overlay.web) out.web = mergeWeb(base.web, overlay.web);
  return out;
}

/**
 * `enabled` can only go false; `denyDomains` is the union; `allowDomains` is set by the first
 * layer that names it and intersected by every later one (a domain survives when it lies within
 * an entry of both lists; the narrower of the two is kept), so no layer can widen it.
 */
function mergeWeb(base: WebPolicy, overlay: Partial<WebPolicy>): WebPolicy {
  if (overlay.enabled === true && !base.enabled)
    throw loosening("web.enabled", "may not be turned back on (a lower layer turned web off)");
  const out: WebPolicy = {
    enabled: base.enabled && overlay.enabled !== false,
    denyDomains: [...new Set([...base.denyDomains, ...(overlay.denyDomains ?? [])])],
  };
  const a = base.allowDomains;
  const b = overlay.allowDomains;
  if (a !== undefined && b !== undefined) out.allowDomains = intersect(a, b);
  else if (a !== undefined || b !== undefined) out.allowDomains = [...new Set(a ?? b ?? [])];
  return out;
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a)
    for (const y of b) {
      if (domainWithin(y, x)) out.add(y);
      else if (domainWithin(x, y)) out.add(x);
    }
  return [...out];
}
