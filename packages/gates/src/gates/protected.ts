import { join } from "node:path";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import type { GateContext } from "../types.js";
import { checkRef, type GateExec, inNodeModules, realRootOf, splitZ } from "./shared.js";

export type ProtectedHit = { path: string; rule: string };

const CONCURRENCY = 8;

/**
 * Every path that differs from baseRef (modified, added, deleted, both sides of a rename) plus
 * every untracked path (gitignored ones included, so an ignore rule cannot hide a file), minus
 * node_modules. The implementer could have touched any of them.
 */
export async function touchedPaths(ctx: GateContext, g: GateExec): Promise<string[]> {
  checkRef(ctx.baseRef);
  const diff = await g.git([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--relative",
    ctx.baseRef,
    "--",
  ]);
  const others = await g.git(["ls-files", "--others", "-z"]);
  return [...new Set([...splitZ(diff), ...splitZ(others)])].filter((p) => !inNodeModules(p)).sort();
}

/**
 * R37: ask the sandbox whether the implementer profile may write each touched path. Reuses the
 * Rust decision (the same one the OS layer and the tools enforce), so there is no separate glob
 * engine here. On Linux the OS layer cannot block creating a path that matches a deny glob but
 * did not exist when the sandbox started; this check is what catches it.
 *
 * Frozen-manifest files are exempt: the test-writer wrote them, the implementer profile denies
 * them, and the frozen hash check covers them. Any other deny is a hit. A sandbox failure throws
 * (the gate turns it into an error, #22).
 */
export async function protectedPathHits(
  ctx: GateContext,
  g: GateExec,
  exempt: ReadonlySet<string>,
): Promise<ProtectedHit[]> {
  const touched = (await touchedPaths(ctx, g)).filter((p) => !exempt.has(p));
  // N1: `git ls-files --others` lists a nested repository (a `.git` the implementer created,
  // which Linux bwrap cannot block once the sandbox runs) as one `dir/` entry and never shows its
  // files. Nothing inside can be reviewed or committed, so any such entry is a hit.
  const nested: ProtectedHit[] = touched
    .filter((p) => p.endsWith("/"))
    .map((p) => ({ path: p, rule: "nested git repository" }));
  const paths = touched.filter((p) => !p.endsWith("/"));
  if (paths.length === 0) return nested;
  const own = ctx.implementerClient
    ? undefined
    : new SandboxClient(profileFor("implementer", ctx.worktree, ctx.policy, ctx.scratch));
  const client = ctx.implementerClient ?? (own as SandboxClient);
  try {
    const root = await realRootOf(ctx);
    const hits: ProtectedHit[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        if (ctx.signal?.aborted) throw new Error("aborted");
        const p = paths[next++] as string;
        const r = await client.checkPath("write", join(root, p));
        if (!r.allowed) hits.push({ path: p, rule: r.rule });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
    hits.push(...nested);
    return hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } finally {
    own?.dispose();
  }
}
