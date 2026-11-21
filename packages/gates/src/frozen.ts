import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FrozenTestManifest } from "@rewire/core";

export type FrozenMismatch = {
  path: string;
  reason: "missing" | "symlink" | "modified" | "escapes_root";
};

function insideRoot(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** sha256 of the resolved contents of each file (symlinks are followed, so their target is hashed). */
export async function hashFiles(
  root: string,
  paths: string[],
): Promise<Array<{ path: string; sha256: string }>> {
  const out: Array<{ path: string; sha256: string }> = [];
  for (const path of paths) {
    const abs = resolve(root, path);
    if (!insideRoot(resolve(root), abs)) throw new Error(`path escapes the root: ${path}`);
    const data = await readFile(abs);
    out.push({ path, sha256: createHash("sha256").update(data).digest("hex") });
  }
  return out;
}

/**
 * Verify every frozen file is still present, is a regular file (not a symlink, and not reached
 * through a symlinked directory), and has the frozen content hash.
 */
export async function verifyFrozen(
  root: string,
  manifest: FrozenTestManifest,
): Promise<{ ok: boolean; mismatches: FrozenMismatch[] }> {
  const mismatches: FrozenMismatch[] = [];
  const absRoot = resolve(root);
  let realRoot: string;
  try {
    realRoot = await realpath(absRoot);
  } catch {
    realRoot = absRoot;
  }
  for (const f of manifest.files) {
    const abs = resolve(absRoot, f.path);
    if (!insideRoot(absRoot, abs)) {
      mismatches.push({ path: f.path, reason: "escapes_root" });
      continue;
    }
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(abs);
    } catch {
      mismatches.push({ path: f.path, reason: "missing" });
      continue;
    }
    if (st.isSymbolicLink()) {
      mismatches.push({ path: f.path, reason: "symlink" });
      continue;
    }
    try {
      // A symlinked parent directory would make lstat see a regular file elsewhere.
      if ((await realpath(abs)) !== join(realRoot, relative(absRoot, abs))) {
        mismatches.push({ path: f.path, reason: "symlink" });
        continue;
      }
      const [h] = await hashFiles(absRoot, [f.path]);
      if (h?.sha256 !== f.sha256) mismatches.push({ path: f.path, reason: "modified" });
    } catch {
      mismatches.push({ path: f.path, reason: "missing" });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
