import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { RewireError } from "@rewire/core";
import { trustedGit, trustedGitOk } from "@rewire/sandbox";

type Sig = { signal?: AbortSignal };

const isTopNodeModules = (entry: string): boolean => entry.replace(/\/+$/, "") === "node_modules";

/**
 * R38: delete every ignored untracked entry in the worktree except the top-level node_modules
 * link, so the gates see exactly what `git add -A` will commit. Trusted TS on the host (never
 * the sandbox). Returns the removed entries (worktree-relative, directories with a trailing
 * `/`). An entry whose parent no longer resolves inside the worktree (a directory swapped for a
 * symlink after listing) is refused with `stage_error`-class `tree_unsafe` rather than followed.
 */
export async function pruneIgnored(worktree: string, sig: Sig = {}): Promise<string[]> {
  const out = await trustedGitOk(
    worktree,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    sig,
  );
  const entries = out.split("\0").filter((e) => e !== "" && !isTopNodeModules(e));
  if (entries.length === 0) return [];
  const root = await realpath(worktree);
  const removed: string[] = [];
  for (const entry of entries) {
    const rel = normalize(entry.replace(/\/+$/, ""));
    if (rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new RewireError(
        "tree_unsafe",
        `git listed an ignored entry outside the worktree: ${entry}`,
      );
    }
    const abs = join(root, rel);
    const parent = dirname(abs);
    const realParent = await realpath(parent).catch(() => undefined);
    if (realParent === undefined) continue; // already gone with an earlier entry
    if (realParent !== parent) {
      throw new RewireError(
        "tree_unsafe",
        `the parent of ignored entry ${entry} resolves outside its worktree path; refusing to delete through it`,
      );
    }
    // A symlink entry is removed itself, never its target.
    await rm(abs, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

/** `git add -A` that never stages the top-level node_modules (the index check is the guarantee). */
export async function stageAll(
  worktree: string,
  opts: Sig & { indexFile?: string } = {},
): Promise<void> {
  const sig = opts.signal ? { signal: opts.signal } : {};
  // git rejects an exclude pathspec that names an ignored path, so an ignored node_modules
  // relies on the ignore rule instead.
  const nmIgnored = (await trustedGit(worktree, ["check-ignore", "-q", "node_modules"], sig)).code;
  await trustedGitOk(
    worktree,
    nmIgnored === 0 ? ["add", "-A"] : ["add", "-A", "--", ".", ":(exclude,top)node_modules"],
    { ...sig, ...(opts.indexFile ? { indexFile: opts.indexFile } : {}) },
  );
}

/**
 * The tree id `git add -A` would commit right now, computed in a scratch index (the real index
 * is untouched). Seeded from the real index so unchanged files are not re-hashed.
 */
export async function snapshotTree(worktree: string, sig: Sig = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rewire-index-"));
  try {
    const index = join(dir, "index");
    const real = (await trustedGitOk(worktree, ["rev-parse", "--git-path", "index"], sig)).trim();
    await copyFile(resolve(worktree, real), index).catch(() => {});
    await stageAll(worktree, { ...sig, indexFile: index });
    return (await trustedGitOk(worktree, ["write-tree"], { ...sig, indexFile: index })).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
