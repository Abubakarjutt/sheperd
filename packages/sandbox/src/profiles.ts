import { homedir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { RewireError } from "@rewire/core";
import type { Policy } from "@rewire/policy";

export type StageName =
  | "spec"
  | "test-writer"
  | "implementer"
  | "verify"
  | "chat"
  | "review"
  | "verify-registry";

/** Identical to the Rust profile JSON. */
export type CapabilityProfile = {
  root: string;
  write: string[];
  writeDeny: string[];
  readDeny: string[];
  network: "deny" | "registry";
  extraWrite: string[];
};

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Expand a leading `~/` (or bare `~`); any other leading `~` is invalid. */
export function expandHome(glob: string): string {
  if (glob === "~") return homedir();
  if (glob.startsWith("~/")) return homedir() + glob.slice(1);
  if (glob.startsWith("~")) {
    throw new RewireError("policy_invalid", `unsupported ~ pattern in policy glob: ${glob}`);
  }
  return glob;
}

/**
 * A run worktree lives at `<repo>/.rewire/worktrees/<id>`, so the repo's own `.env` files sit
 * outside the sandbox root, where `**\/.env*` does not reach (I3). Depth-limited like the HOME
 * globs (monorepo packages one or two levels down).
 */
function repoEnvDeny(root: string): string[] {
  const wt = dirname(root);
  if (basename(wt) !== "worktrees" || basename(dirname(wt)) !== ".rewire") return [];
  const repo = dirname(dirname(wt));
  return [`${repo}/.env*`, `${repo}/*/.env*`, `${repo}/*/*/.env*`];
}

export function profileFor(
  stage: StageName,
  root: string,
  policy: Policy,
  scratch: string,
): CapabilityProfile {
  if (!isAbsolute(root)) {
    throw new RewireError("policy_invalid", `sandbox root must be absolute: ${root}`);
  }
  let write: string[] = [];
  let writeDeny: string[] = [];
  let extraWrite: string[] = [];
  switch (stage) {
    case "spec":
    case "review":
      break;
    case "verify":
    case "chat":
    case "verify-registry":
      extraWrite = [scratch];
      break;
    case "test-writer":
      write = policy.testGlobs;
      writeDeny = policy.protectedGlobs;
      break;
    case "implementer":
      write = ["**"];
      writeDeny = [...policy.testGlobs, ...policy.protectedGlobs];
      break;
  }
  if (extraWrite.some((p) => !isAbsolute(p))) {
    throw new RewireError("policy_invalid", `scratch must be absolute: ${scratch}`);
  }
  return {
    root,
    write: dedupe(write),
    writeDeny: dedupe(writeDeny),
    readDeny: dedupe([...policy.credentialDenyGlobs.map(expandHome), ...repoEnvDeny(root)]),
    network: stage === "verify-registry" ? "registry" : "deny",
    extraWrite: dedupe(extraWrite),
  };
}
