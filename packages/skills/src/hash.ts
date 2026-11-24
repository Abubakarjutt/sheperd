import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { RewireError } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";

/** One skill dir: at most this many bytes and files (global constraint). */
export const MAX_SKILL_DIR_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_FILES = 200;

export type SkillFile = { path: string; bytes: number; content: Buffer };
export type SkillSnapshot = { sha256: string; files: SkillFile[] };

const invalid = (message: string) => new RewireError("skill_invalid", message);

const errCode = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;

/**
 * sha256 over the files sorted by relative path (`/`-separated, compared by code unit), each as
 * `path NUL bytes NUL content`. Independent of creation order, mtimes and the machine.
 */
export function hashFiles(files: ReadonlyArray<{ path: string; content: Buffer }>): string {
  const h = createHash("sha256");
  for (const f of sortFiles(files)) {
    h.update(`${f.path}\0${f.content.length}\0`);
    h.update(f.content);
  }
  return h.digest("hex");
}

function sortFiles<T extends { path: string }>(files: ReadonlyArray<T>): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

class Budget {
  files = 0;
  bytes = 0;
  add(bytes: number): void {
    this.files++;
    this.bytes += bytes;
    if (this.files > MAX_SKILL_FILES) {
      throw invalid(`skill dir has more than ${MAX_SKILL_FILES} files`);
    }
    if (this.bytes > MAX_SKILL_DIR_BYTES) {
      throw invalid(`skill dir is larger than ${MAX_SKILL_DIR_BYTES} bytes`);
    }
  }
}

/**
 * Strict walk (repo skills): `lstat` only, and any symlink or non-regular file is rejected, so
 * nothing outside `dir` is ever opened.
 */
export async function snapshotStrict(dir: string): Promise<SkillSnapshot> {
  const top = await lstat(dir).catch(() => undefined);
  if (!top?.isDirectory()) throw invalid("skill dir is a symlink or not a directory");
  const budget = new Budget();
  const files: SkillFile[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await readdir(abs)).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw invalid(`skill dir contains a symlink: ${r}`);
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile()) {
        budget.add(st.size);
        const content = await readFile(p);
        // Re-check after reading: the file may have grown since `lstat`.
        budget.bytes += content.length - st.size;
        if (budget.bytes > MAX_SKILL_DIR_BYTES) {
          throw invalid(`skill dir is larger than ${MAX_SKILL_DIR_BYTES} bytes`);
        }
        files.push({ path: r, bytes: content.length, content });
      } else throw invalid(`skill dir contains a non-regular file: ${r}`);
    }
  };
  await walk(dir, "");
  const sorted = sortFiles(files);
  return { sha256: hashFiles(sorted), files: sorted };
}

/** Hash a skill dir; rejects any symlink and enforces the size and file-count caps. */
export async function hashSkillDir(dir: string): Promise<string> {
  return (await snapshotStrict(dir)).sha256;
}

const within = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
};

/**
 * Where a USER skill's symlinks may resolve: inside HOME (or a user skill root), never into a
 * credential location (the policy's `credentialDenyGlobs`, `~` expanded against `home`).
 *
 * The credential list denies `~/.claude/**` and `~/.config/rewire/**`, which hold the user skill
 * roots themselves; for a target inside a skill root, the globs that cover that whole root are
 * skipped, the rest (`**\/.env*`, `**\/id_ed25519*`, ...) still apply.
 */
export class UserGuard {
  private constructor(
    private readonly home: string,
    private readonly roots: string[],
    private readonly globs: string[],
  ) {}

  static async create(opts: { home: string; xdgConfig: string }): Promise<UserGuard> {
    const home = await realpath(opts.home).catch(() => opts.home);
    const roots: string[] = [];
    for (const r of userSkillRoots(opts)) {
      const real = await realpath(r).catch(() => undefined);
      if (real) roots.push(real);
    }
    const globs: string[] = [];
    for (const g of DEFAULT_POLICY.credentialDenyGlobs) {
      if (g === "~") globs.push(home);
      else if (g.startsWith("~/")) globs.push(home + g.slice(1));
      else if (!g.startsWith("~")) globs.push(g);
      // `~user/...` cannot be expanded here; the sandbox layer rejects it as policy_invalid.
    }
    return new UserGuard(home, roots, globs);
  }

  /** Throw skill_invalid unless the resolved path `real` is allowed. */
  check(real: string): void {
    const root = this.roots.find((r) => within(r, real));
    if (!root && !within(this.home, real)) {
      throw invalid("a user skill symlink resolves outside HOME");
    }
    const probe = join(root ?? "", "__rewire_probe__");
    for (const g of this.globs) {
      if (root && matchesGlob(probe, g)) continue;
      if (matchesGlob(real, g)) {
        throw invalid("a user skill path resolves into a credential location");
      }
    }
  }

  /** `realpath` + `check`; a cycle (ELOOP) or dangling link is skill_invalid. */
  async resolve(path: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(path);
    } catch (e) {
      if (errCode(e) === "ELOOP") throw invalid("a user skill symlink forms a cycle");
      throw invalid("a user skill path cannot be resolved");
    }
    this.check(real);
    return real;
  }
}

export function userSkillRoots(opts: { home: string; xdgConfig: string }): string[] {
  return [join(opts.home, ".claude", "skills"), join(opts.xdgConfig, "rewire", "skills")];
}

/**
 * Following walk (user skills): symlinks are followed, every resolved path passes `guard`, a
 * directory link back to one of its ancestors is a cycle. Caps as in the strict walk.
 */
export async function snapshotFollowing(dir: string, guard: UserGuard): Promise<SkillSnapshot> {
  const budget = new Budget();
  const files: SkillFile[] = [];
  const walk = async (abs: string, rel: string, ancestors: string[]): Promise<void> => {
    const real = await guard.resolve(abs);
    if (ancestors.includes(real)) throw invalid("a user skill symlink forms a cycle");
    const st = await stat(real);
    if (st.isDirectory()) {
      for (const name of (await readdir(real)).sort()) {
        await walk(join(real, name), rel ? `${rel}/${name}` : name, [...ancestors, real]);
      }
    } else if (st.isFile()) {
      if (!rel) throw invalid("skill dir is not a directory");
      budget.add(st.size);
      const content = await readFile(real);
      budget.bytes += content.length - st.size;
      if (budget.bytes > MAX_SKILL_DIR_BYTES) {
        throw invalid(`skill dir is larger than ${MAX_SKILL_DIR_BYTES} bytes`);
      }
      files.push({ path: rel, bytes: content.length, content });
    } else throw invalid(`skill dir contains a non-regular file: ${rel}`);
  };
  await walk(dir, "", []);
  const sorted = sortFiles(files);
  return { sha256: hashFiles(sorted), files: sorted };
}
