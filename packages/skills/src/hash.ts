import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { RewireError } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";

/** Caps on one skill dir: total bytes and file count. */
export type SkillCaps = { bytes: number; files: number };
/** Repo skills (untrusted until approved): at most 2 MiB and 200 files. */
export const REPO_SKILL_CAPS: SkillCaps = Object.freeze({ bytes: 2 * 1024 * 1024, files: 200 });
/** User skills (the user's own; e.g. gstack is ~30 MiB): at most 64 MiB and 5000 files. */
export const USER_SKILL_CAPS: SkillCaps = Object.freeze({ bytes: 64 * 1024 * 1024, files: 5000 });

export type SkillSnapshot = { sha256: string; files: Array<{ path: string; bytes: number }> };

/** A file found by a walk; `open` re-checks the source's rules before opening it. */
export type SkillEntry = { path: string; size: number; open: () => Promise<FileHandle> };

const invalid = (message: string) => new RewireError("skill_invalid", message);

const errCode = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;

function sortEntries<T extends { path: string }>(xs: T[]): T[] {
  return xs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

class Budget {
  files = 0;
  bytes = 0;
  constructor(private readonly caps: SkillCaps) {}
  add(bytes: number): void {
    this.files++;
    this.bytes += bytes;
    if (this.files > this.caps.files) {
      throw invalid(`skill dir has more than ${this.caps.files} files`);
    }
    if (this.bytes > this.caps.bytes) {
      throw invalid(`skill dir is larger than ${this.caps.bytes} bytes`);
    }
  }
}

/** Open a regular file without following a final symlink (repo rules). */
export async function openNoFollow(path: string): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw invalid("skill file is a symlink");
    throw e;
  }
  if (!(await fh.stat()).isFile()) {
    await fh.close();
    throw invalid("skill file is not a regular file");
  }
  return fh;
}

/**
 * Strict walk (repo skills): `lstat` only; any symlink or non-regular file is rejected, and files
 * are later opened with O_NOFOLLOW, so nothing outside `dir` is ever opened.
 */
export async function listStrict(dir: string, caps = REPO_SKILL_CAPS): Promise<SkillEntry[]> {
  const top = await lstat(dir).catch(() => undefined);
  if (!top?.isDirectory()) throw invalid("skill dir is a symlink or not a directory");
  const budget = new Budget(caps);
  const out: SkillEntry[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw invalid(`skill dir contains a symlink: ${r}`);
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile()) {
        budget.add(st.size);
        out.push({ path: r, size: st.size, open: () => openNoFollow(p) });
      } else throw invalid(`skill dir contains a non-regular file: ${r}`);
    }
  };
  await walk(dir, "");
  return sortEntries(out);
}

/**
 * Following walk (user skills): symlinks are followed, every resolved path passes `guard` (again
 * when the file is opened), a directory link back to one of its ancestors is a cycle.
 */
export async function listFollowing(
  dir: string,
  guard: UserGuard,
  caps = USER_SKILL_CAPS,
): Promise<SkillEntry[]> {
  const budget = new Budget(caps);
  const out: SkillEntry[] = [];
  const walk = async (abs: string, rel: string, ancestors: string[]): Promise<void> => {
    const real = await guard.resolve(abs);
    if (ancestors.includes(real)) throw invalid("a user skill symlink forms a cycle");
    const st = await stat(real);
    if (st.isDirectory()) {
      for (const name of await readdir(real)) {
        await walk(join(real, name), rel ? `${rel}/${name}` : name, [...ancestors, real]);
      }
    } else if (st.isFile()) {
      if (!rel) throw invalid("skill dir is not a directory");
      budget.add(st.size);
      out.push({
        path: rel,
        size: st.size,
        open: async () => {
          const fh = await open(await guard.resolve(abs), "r");
          if (!(await fh.stat()).isFile()) {
            await fh.close();
            throw invalid(`skill file is not a regular file: ${rel}`);
          }
          return fh;
        },
      });
    } else throw invalid(`skill dir contains a non-regular file: ${rel}`);
  };
  await walk(dir, "", []);
  return sortEntries(out);
}

const CHUNK = 64 * 1024;

/**
 * Stream every entry in path order into one sha256 (each file as `path NUL bytes NUL content`;
 * independent of creation order, mtimes and the machine), optionally copying it under `destDir`.
 * Files are never held in memory whole. A file whose size changed since the walk is rejected, so
 * the caps hold.
 */
export async function hashEntries(entries: SkillEntry[], destDir?: string): Promise<SkillSnapshot> {
  const h = createHash("sha256");
  const buf = Buffer.alloc(CHUNK);
  for (const e of sortEntries([...entries])) {
    h.update(`${e.path}\0${e.size}\0`);
    const src = await e.open();
    let dst: FileHandle | undefined;
    try {
      if (destDir !== undefined) {
        const target = join(destDir, ...e.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        const mode = (await src.stat()).mode & 0o755;
        dst = await open(target, "wx", mode | 0o400);
      }
      let total = 0;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > e.size) break;
        const chunk = buf.subarray(0, bytesRead);
        h.update(chunk);
        if (dst) await dst.write(chunk);
      }
      if (total !== e.size) throw invalid(`skill file changed while reading: ${e.path}`);
    } finally {
      await src.close();
      await dst?.close();
    }
  }
  return {
    sha256: h.digest("hex"),
    files: sortEntries(entries.map((e) => ({ path: e.path, bytes: e.size }))),
  };
}

/** Hash a skill dir with repo rules: rejects any symlink; at most 2 MiB and 200 files. */
export async function hashSkillDir(dir: string): Promise<string> {
  return (await hashEntries(await listStrict(dir))).sha256;
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
