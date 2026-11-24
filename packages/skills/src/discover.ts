import { type FileHandle, lstat, mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { RewireError, redact } from "@rewire/core";
import {
  hashEntries,
  listFollowing,
  listStrict,
  openNoFollow,
  type SkillEntry,
  type SkillSnapshot,
  UserGuard,
  userSkillRoots,
} from "./hash.js";
import { parseSkillMd, validateSkillMd } from "./parse.js";

/** SKILL.md at most this many bytes (global constraint); checked at discovery. */
export const MAX_SKILL_MD_BYTES = 256 * 1024;

export type SkillSource = "user" | "repo";

export type Skill = {
  name: string;
  description: string;
  source: SkillSource;
  /** The skill dir as found under its root (for a symlinked user skill, the link's path). */
  dir: string;
  /**
   * sha256 over all the skill's files (see `hashEntries`). Set at discovery for REPO skills (trust
   * pins it). Left unset for USER skills to keep discovery cheap; `hashSkill` computes it.
   */
  sha256?: string;
  /** Every file for repo skills; only `SKILL.md` for user skills (see `snapshotSkill`). */
  files: Array<{ path: string; bytes: number }>;
  /** The markdown after the frontmatter. */
  body: string;
  /** False when the frontmatter says `disable-model-invocation: true`. */
  modelInvocable: boolean;
  /** True when a skill of the same name was found earlier (a user skill beats a repo skill). */
  shadowed?: boolean;
};

export type SkillProblem = { dir: string; code: string; message: string };

export type DiscoverOptions = { home: string; xdgConfig: string; repo: string };

const invalid = (message: string) => new RewireError("skill_invalid", message);

const errCode = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;

/** Never echo an unexpected error's text (it could quote file content); keep only its code. */
function toProblem(dir: string, e: unknown): SkillProblem {
  if (e instanceof RewireError) return { dir, code: e.code, message: redact(e.message) };
  return { dir, code: "skill_invalid", message: `cannot read skill (${errCode(e) ?? "error"})` };
}

/** Distinguishes "no SKILL.md here" (skip silently) from a real problem. */
const SKIP = Symbol("skip");

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return false;
    throw e;
  }
}

async function readCapped(fh: FileHandle): Promise<string> {
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw invalid("SKILL.md is not a regular file");
    if (st.size > MAX_SKILL_MD_BYTES)
      throw invalid(`SKILL.md is larger than ${MAX_SKILL_MD_BYTES} bytes`);
    const buf = Buffer.alloc(MAX_SKILL_MD_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_SKILL_MD_BYTES)
      throw invalid(`SKILL.md is larger than ${MAX_SKILL_MD_BYTES} bytes`);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

function build(
  text: string,
  entry: string,
  source: SkillSource,
  dir: string,
  files: Skill["files"],
  sha256?: string,
): Skill {
  const parsed = parseSkillMd(text);
  const { name, description } = validateSkillMd(parsed, entry);
  const skill: Skill = {
    name,
    description,
    source,
    dir,
    files,
    body: parsed.body,
    modelInvocable: parsed.modelInvocable,
  };
  if (sha256 !== undefined) skill.sha256 = sha256;
  return skill;
}

/** A user skill: symlinks are followed but confined by `guard`; only SKILL.md is read. */
async function loadUserSkill(
  dir: string,
  entry: string,
  guard: UserGuard,
): Promise<Skill | typeof SKIP> {
  const real = await guard.resolve(dir);
  if (!(await stat(real)).isDirectory()) return SKIP;
  const md = join(real, "SKILL.md");
  if (!(await exists(md))) return SKIP;
  const mdReal = await guard.resolve(md);
  const text = await readCapped(await open(mdReal, "r"));
  return build(text, entry, "user", dir, [{ path: "SKILL.md", bytes: Buffer.byteLength(text) }]);
}

/** A repo skill: any symlink is rejected; the whole dir is hashed for trust. */
async function loadRepoSkill(dir: string, entry: string): Promise<Skill | typeof SKIP> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw invalid("repo skill dir is a symlink");
  if (!st.isDirectory()) return SKIP;
  const mdSt = await lstat(join(dir, "SKILL.md")).catch((e: unknown) => {
    if (errCode(e) === "ENOENT") return undefined;
    throw e;
  });
  if (!mdSt) return SKIP;
  if (mdSt.isSymbolicLink()) throw invalid("repo SKILL.md is a symlink");
  if (mdSt.size > MAX_SKILL_MD_BYTES)
    throw invalid(`SKILL.md is larger than ${MAX_SKILL_MD_BYTES} bytes`);
  const text = await readCapped(await openNoFollow(join(dir, "SKILL.md")));
  const snap = await hashEntries(await listStrict(dir));
  return build(text, entry, "repo", dir, snap.files, snap.sha256);
}

/**
 * Find skills in `~/.claude/skills`, `$XDG_CONFIG_HOME/rewire/skills` (user) and
 * `<repo>/.claude/skills` (repo). A missing root is not an error; a dir without SKILL.md is
 * skipped silently; anything invalid becomes a `skill_invalid` problem and its content appears in
 * no returned field. On a name collision the earlier skill wins and later ones get `shadowed`.
 */
export async function discoverSkills(
  opts: DiscoverOptions,
): Promise<{ skills: Skill[]; problems: SkillProblem[] }> {
  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const guard = await UserGuard.create(opts);

  const scan = async (
    root: string,
    load: (dir: string, entry: string) => Promise<Skill | typeof SKIP>,
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(root)).sort();
    } catch (e) {
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return;
      problems.push(toProblem(root, e));
      return;
    }
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        const s = await load(dir, entry);
        if (s !== SKIP) skills.push(s);
      } catch (e) {
        problems.push(toProblem(dir, e));
      }
    }
  };

  for (const root of userSkillRoots(opts)) {
    if (!(await exists(root))) continue;
    try {
      await guard.resolve(root);
    } catch (e) {
      problems.push(toProblem(root, e));
      continue;
    }
    await scan(root, (dir, entry) => loadUserSkill(dir, entry, guard));
  }

  const repoRoot = await repoSkillsRoot(opts.repo, problems);
  if (repoRoot) await scan(repoRoot, loadRepoSkill);

  const seen = new Set<string>();
  for (const s of skills) {
    if (seen.has(s.name)) s.shadowed = true;
    else seen.add(s.name);
  }
  return { skills, problems };
}

/** `<repo>/.claude/skills`, or undefined when absent; a symlink on the way is a problem. */
async function repoSkillsRoot(repo: string, problems: SkillProblem[]): Promise<string | undefined> {
  const claude = join(repo, ".claude");
  const root = join(claude, "skills");
  for (const p of [claude, root]) {
    const st = await lstat(p).catch(() => undefined);
    if (!st) return undefined;
    if (st.isSymbolicLink()) {
      problems.push({ dir: p, code: "skill_invalid", message: "repo skills path is a symlink" });
      return undefined;
    }
    if (!st.isDirectory()) return undefined;
  }
  return root;
}

type HomeOpts = { home: string; xdgConfig: string };

/** The skill's files under its source's rules and caps (see `listStrict` / `listFollowing`). */
async function entriesFor(skill: Skill, opts: HomeOpts): Promise<SkillEntry[]> {
  if (skill.source === "repo") return listStrict(skill.dir);
  return listFollowing(skill.dir, await UserGuard.create(opts));
}

/**
 * List and hash every file of a discovered skill with its source's rules (repo: no symlinks,
 * 2 MiB / 200 files; user: symlinks confined to HOME and away from credentials, 64 MiB / 5000
 * files). Streams; no file is held in memory whole.
 */
export async function snapshotSkill(skill: Skill, opts: HomeOpts): Promise<SkillSnapshot> {
  return hashEntries(await entriesFor(skill, opts));
}

/** The skill's sha256, computed lazily (user skills are not hashed at discovery). */
export async function hashSkill(skill: Skill, opts: HomeOpts): Promise<string> {
  return (await snapshotSkill(skill, opts)).sha256;
}

/**
 * Copy the skill file by file into `destDir` (created if missing; existing files are never
 * overwritten), hashing as it copies. Each file is re-checked against the source's rules when it
 * is opened. The returned sha256 is the hash of exactly the bytes written.
 */
export async function materializeSkill(
  skill: Skill,
  destDir: string,
  opts: HomeOpts,
): Promise<SkillSnapshot> {
  const entries = await entriesFor(skill, opts);
  await mkdir(destDir, { recursive: true });
  return hashEntries(entries, destDir);
}
