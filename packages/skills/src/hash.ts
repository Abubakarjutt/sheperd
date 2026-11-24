import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { RewireError, stripControls } from "@rewire/core";
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

/** An untrusted file name, safe for a message: no control characters, at most 200 chars. */
export function safeName(name: string): string {
  const clean = stripControls(name);
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
}

/**
 * Translate a glob to a RegExp in which `*`, `?` and `**` also match dot segments (as git does).
 * `path.matchesGlob` does not, so `~/.claude/**` would miss `~/.claude/.credentials.json`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const atSegStart = i === 0 || glob[i - 1] === "/";
    if (atSegStart && glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (atSegStart && glob.startsWith("**", i) && i + 2 === glob.length) {
      re += ".*";
      i += 2;
    } else {
      const c = glob[i] ?? "";
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`${re}$`);
}

/** `a{b,c}d` -> `abd`, `acd` (no nesting across braces). */
export function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const [whole, inner] = m;
  return (inner ?? "")
    .split(",")
    .flatMap((alt) =>
      expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + whole.length)),
    );
}

const NOFOLLOW_RO = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Open a regular file read-only without following a final symlink. O_NONBLOCK keeps a FIFO
 * swapped in after the type check from blocking the open; the fstat then rejects it.
 * `singleLink` (repo rules) rejects hardlinks, which could alias a file outside the dir.
 */
export async function openNoFollow(path: string, singleLink = true): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(path, NOFOLLOW_RO);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw invalid("skill file is a symlink");
    throw e;
  }
  const st = await fh.stat();
  if (!st.isFile() || (singleLink && st.nlink > 1)) {
    await fh.close();
    throw invalid(st.isFile() ? "skill file is hardlinked" : "skill file is not a regular file");
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
      if (st.isSymbolicLink()) throw invalid(`skill dir contains a symlink: ${safeName(r)}`);
      if (st.isDirectory()) await walk(p, r);
      else if (st.isFile()) {
        if (st.nlink > 1) throw invalid(`skill dir contains a hardlink: ${safeName(r)}`);
        budget.add(st.size);
        out.push({ path: r, size: st.size, open: () => openNoFollow(p) });
      } else throw invalid(`skill dir contains a non-regular file: ${safeName(r)}`);
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
        // Re-resolve and re-check right before opening; the resolved path has no symlinks,
        // so O_NOFOLLOW catches a swap between the check and the open.
        open: async () => openNoFollow(await guard.resolve(abs), false),
      });
    } else throw invalid(`skill dir contains a non-regular file: ${safeName(rel)}`);
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
export async function hashEntries(
  entries: SkillEntry[],
  destDir?: string,
  capture?: string,
): Promise<SkillSnapshot & { captured?: Buffer }> {
  let captured: Buffer[] | undefined;
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
        if (e.path === capture) {
          captured ??= [];
          captured.push(Buffer.from(chunk));
        }
      }
      if (total !== e.size) throw invalid(`skill file changed while reading: ${safeName(e.path)}`);
    } finally {
      await src.close();
      await dst?.close();
    }
  }
  const snap: SkillSnapshot & { captured?: Buffer } = {
    sha256: h.digest("hex"),
    files: sortEntries(entries.map((e) => ({ path: e.path, bytes: e.size }))),
  };
  if (capture !== undefined) snap.captured = Buffer.concat(captured ?? []);
  return snap;
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
    private readonly globs: RegExp[],
  ) {}

  static async create(opts: { home: string; xdgConfig: string }): Promise<UserGuard> {
    const home = await realpath(opts.home).catch(() => opts.home);
    const roots: string[] = [];
    for (const r of userSkillRoots(opts)) {
      const real = await realpath(r).catch(() => undefined);
      if (real) roots.push(real);
    }
    const globs: RegExp[] = [];
    for (const g of DEFAULT_POLICY.credentialDenyGlobs) {
      let abs: string | undefined;
      if (g === "~") abs = home;
      else if (g.startsWith("~/")) abs = home + g.slice(1);
      else if (!g.startsWith("~")) abs = g;
      if (abs !== undefined) globs.push(...expandBraces(abs).map(globToRegExp));
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
      if (root && g.test(probe)) continue;
      if (g.test(real)) {
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
