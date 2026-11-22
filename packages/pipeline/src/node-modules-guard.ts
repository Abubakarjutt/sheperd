import { lstat, readlink, realpath, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * What `<wt>/node_modules` was when the orchestrator set it up (R33). Gates run
 * `<wt>/node_modules/.bin` tools, so every later check compares against this state.
 */
export type NodeModulesState =
  | { kind: "absent" }
  | { kind: "link"; target: string }
  | { kind: "dir"; dev: number; ino: number };

/**
 * Share the repo's node_modules with the worktree (no install, #26) whenever the repo has a
 * node_modules directory, whatever .gitignore says (the final commit excludes it explicitly).
 * A node_modules the worktree already has (tracked) is left alone and recorded as found.
 */
export async function linkNodeModules(repo: string, wt: string): Promise<NodeModulesState> {
  const dst = join(wt, "node_modules");
  const existing = await lstat(dst).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink()) return { kind: "link", target: await readlink(dst) };
    return { kind: "dir", dev: existing.dev, ino: existing.ino };
  }
  let target: string;
  try {
    target = await realpath(join(repo, "node_modules"));
    if (!(await stat(target)).isDirectory()) return { kind: "absent" };
  } catch {
    return { kind: "absent" };
  }
  await symlink(target, dst, "dir");
  return { kind: "link", target };
}

/**
 * True when `<wt>/node_modules` differs from the recorded state: anything appearing where there
 * was nothing, a link gone, replaced or retargeted, or a directory swapped for another node.
 * Platform independent: never relies on the sandbox.
 */
export async function nodeModulesTampered(wt: string, state: NodeModulesState): Promise<boolean> {
  const dst = join(wt, "node_modules");
  const now = await lstat(dst).catch(() => undefined);
  switch (state.kind) {
    case "absent":
      return now !== undefined;
    case "link":
      if (!now?.isSymbolicLink()) return true;
      return (await readlink(dst).catch(() => undefined)) !== state.target;
    case "dir":
      return (
        now === undefined ||
        now.isSymbolicLink() ||
        !now.isDirectory() ||
        now.dev !== state.dev ||
        now.ino !== state.ino
      );
  }
}
