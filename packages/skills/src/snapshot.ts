import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { chmod, lstat, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assetRoot, fenceUntrusted, RewireError } from "@rewire/core";
import { MAX_SKILL_MD_BYTES, materializeSkill, type Skill } from "./discover.js";
import { openNoFollow, UserGuard } from "./hash.js";
import { parseSkillMd, SKILL_NAME_RE } from "./parse.js";

const PACKAGE_ROOT = assetRoot("skills", import.meta.url);

/** The WHOLE skills section of the system prompt (template and fence included) stays within this. */
export const INDEX_BUDGET_BYTES = 12 * 1024;
const DESC_CHARS = 300;
const SENTENCE_CHARS = 120;

export type SkillSetOptions = {
  home: string;
  xdgConfig: string;
  /**
   * Base cache dir (default `$XDG_CACHE_HOME`, else `<home>/.cache`). Set roots live under
   * `<cacheDir>/rewire/skill-sets/set-*`. Not os.tmpdir(): the Linux sandbox mounts a private
   * tmpfs over /tmp, which would hide the copies from sandboxed readers.
   */
  cacheDir?: string;
  /** Test seam: replaces `materializeSkill`. */
  materialize?: typeof materializeSkill;
};

const STALE_MS = 24 * 60 * 60 * 1000;

/** A skill after its first load. */
export type LoadedSkill = {
  /**
   * The skill as served. `sha256`: for a user skill, the hash of the exact SKILL.md bytes `body`
   * was parsed from; for a repo skill, the pinned tree hash (verified equal to the copy's).
   */
  skill: Skill;
  /** The body, parsed from the same SKILL.md read that `sha256` covers. */
  body: string;
  /** Absolute path of the read-only copy; undefined when bundled files are unavailable. */
  dir?: string;
  files: Array<{ path: string; bytes: number }>;
  /** Why bundled files are unavailable (user skills only). */
  unavailable?: string;
};

export type SkillSet = {
  skills: Skill[];
  /**
   * HOST-ONLY directory holding the read-only copies, `<root>/<name>/`. Created by
   * `createSkillSet` with mkdtemp (0700). It must NEVER be added to any sandbox profile's write
   * or extraWrite set: a sandboxed agent that could write here could redirect or alter the host's
   * copies. Read access for sandboxed agents (same user) is all they need.
   */
  readonly root: string;
  /** Materialize (once per set) and return a skill. Throws skill_invalid for a repo skill that
   *  no longer matches its pinned hash, or for an unknown name. */
  load(name: string): Promise<LoadedSkill>;
};

/** Skills the model may see and load: not shadowed, not `disable-model-invocation`. */
export const invocable = (skills: Skill[]): Skill[] =>
  skills.filter((s) => s.modelInvocable && !s.shadowed);

const invalid = (message: string) => new RewireError("skill_invalid", message);

/**
 * Files get 0444, except files that were executable, which get 0555 so bundled skill scripts
 * still run; directories get 0555.
 */
async function makeReadOnly(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await makeReadOnly(join(path, name));
    await chmod(path, 0o555);
  } else if (st.isFile()) {
    await chmod(path, st.mode & 0o111 ? 0o555 : 0o444);
  }
}

function makeWritableSync(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) makeWritableSync(join(path, name));
  } else if (st.isFile()) chmodSync(path, 0o644);
}

/** Create `<cacheDir>/rewire/skill-sets` (0700), refusing a symlink or non-dir on the way. */
function ensureParent(cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  let dir = cacheDir;
  for (const part of ["rewire", "skill-sets"]) {
    dir = join(dir, part);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) mkdirSync(dir, { mode: 0o700 });
    else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw invalid(`skill-set cache path is a symlink or not a directory: ${part}`);
    }
  }
  return dir;
}

/** Best effort: remove `set-*` dirs older than 24 h (real directories under our parent only). */
function sweepStale(parent: string): void {
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const name of readdirSync(parent)) {
      if (!name.startsWith("set-")) continue;
      const p = join(parent, name);
      try {
        const st = lstatSync(p);
        if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs >= cutoff) continue;
        makeWritableSync(p);
        rmSync(p, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

/** Make a read-only tree removable again. Never follows symlinks (lstat first). */
export async function makeWritable(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return;
  if (st.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else if (st.isFile()) await chmod(path, 0o644);
}

/** The root must still be a real directory (not swapped for a symlink). */
async function checkRoot(root: string): Promise<void> {
  const st = await lstat(root).catch(() => undefined);
  if (!st?.isDirectory()) throw invalid("skill root is not a real directory");
}

/** Remove a leftover entry of ours; refuse a symlink (never follow, never trust it). */
async function clearLeftover(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return;
  if (st.isSymbolicLink()) throw invalid("skill path is a symlink; refused");
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

/** Read SKILL.md once: its sha256 and its parsed body come from the same bytes. */
async function readSkillMd(path: string): Promise<{ sha256: string; body: string }> {
  const fh = await openNoFollow(path, false);
  try {
    const st = await fh.stat();
    if (st.size > MAX_SKILL_MD_BYTES) throw invalid("SKILL.md is too large");
    const bytes = await fh.readFile();
    if (bytes.length > MAX_SKILL_MD_BYTES) throw invalid("SKILL.md is too large");
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      body: parseSkillMd(bytes.toString("utf8")).body,
    };
  } finally {
    await fh.close();
  }
}

const reason = (e: unknown): string =>
  e instanceof RewireError ? `${e.code}: ${e.message}` : "cannot read bundled files";

/** Callers share one cached result: hand out an immutable copy (nothing aliases the Skill). */
function freezeLoaded(l: LoadedSkill): LoadedSkill {
  const files = Object.freeze(l.files.map((f) => Object.freeze({ ...f })));
  const skill = Object.freeze({ ...l.skill, files: [...files] as Skill["files"] });
  Object.freeze(skill.files);
  return Object.freeze({ ...l, skill, files: files as LoadedSkill["files"] });
}

/**
 * A session's skills. Cheap: nothing is copied until a skill is first loaded, which copies it
 * (read-only) under the set's own host-only root and hashes the copy. A repo skill whose copy does
 * not hash to the sha256 pinned at discovery is rejected (`skill_invalid`) and nothing is left at
 * its final path. A user skill that cannot be copied (over the caps, unreadable, refused path)
 * degrades to its SKILL.md body alone. Call `disposeSkillSet` at session end.
 */
export function createSkillSet(skills: Skill[], opts: SkillSetOptions): SkillSet {
  const seen = new Set<string>();
  for (const s of skills) {
    if (!SKILL_NAME_RE.test(s.name)) throw invalid(`invalid skill name: ${JSON.stringify(s.name)}`);
    if (!s.shadowed) {
      if (seen.has(s.name)) throw invalid(`duplicate skill name: ${s.name}`);
      seen.add(s.name);
    }
  }
  const parent = ensureParent(
    opts.cacheDir ?? join(process.env.XDG_CACHE_HOME || join(opts.home, ".cache")),
  );
  sweepStale(parent);
  const root = mkdtempSync(join(parent, "set-"));
  const doMaterialize = opts.materialize ?? materializeSkill;
  const byName = new Map(invocable(skills).map((s) => [s.name, s]));
  const cache = new Map<string, Promise<LoadedSkill>>();

  const materialize = async (skill: Skill): Promise<LoadedSkill> => {
    const tmp = join(root, `${skill.name}.tmp`);
    const dest = join(root, skill.name);
    try {
      await checkRoot(root);
      await clearLeftover(tmp);
      await clearLeftover(dest);
      const snap = await doMaterialize(skill, tmp, opts);
      if (skill.source === "repo" && snap.sha256 !== skill.sha256) {
        throw invalid(`repo skill ${skill.name} changed since approval; not loaded`);
      }
      await checkRoot(root);
      await rename(tmp, dest);
      await makeReadOnly(dest);
      const md = await readSkillMd(join(dest, "SKILL.md"));
      return freezeLoaded({
        skill: { ...skill, sha256: skill.source === "repo" ? snap.sha256 : md.sha256 },
        body: md.body,
        dir: dest,
        files: snap.files,
      });
    } catch (e) {
      await clearLeftover(tmp).catch(() => undefined);
      await clearLeftover(dest).catch(() => undefined);
      if (skill.source === "repo") throw e;
      const guard = await UserGuard.create(opts);
      const md = await readSkillMd(await guard.resolve(join(skill.dir, "SKILL.md")));
      return freezeLoaded({
        skill: { ...skill, sha256: md.sha256 },
        body: md.body,
        files: skill.files,
        unavailable: reason(e),
      });
    }
  };

  return {
    skills,
    root,
    load(name) {
      const skill = byName.get(name);
      if (!skill) return Promise.reject(invalid(`unknown skill: ${name}`));
      const hit = cache.get(name);
      if (hit) return hit;
      const p = materialize(skill);
      cache.set(name, p);
      p.catch(() => cache.delete(name));
      return p;
    },
  };
}

/** Session end: remove the set's root (never follows a symlink root). */
export async function disposeSkillSet(set: SkillSet): Promise<void> {
  const st = await lstat(set.root).catch(() => undefined);
  if (!st || st.isSymbolicLink()) return;
  await makeWritable(set.root);
  await rm(set.root, { recursive: true, force: true });
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstSentence = (s: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return clip(m ? m[0] : s, SENTENCE_CHARS);
};
const bytes = (s: string): number => Buffer.byteLength(s);

export type IndexTier = "full" | "sentence" | "names" | "truncated";

/** The index list text, degraded in steps until it fits `budget` bytes; says which tier fit. */
export function indexTier(
  skills: Skill[],
  budget = INDEX_BUDGET_BYTES,
): { text: string; tier: IndexTier } {
  const list = invocable(skills);
  if (list.length === 0) return { text: "(none)", tier: "full" };
  let text = list.map((s) => `- ${s.name}: ${clip(oneLine(s.description), DESC_CHARS)}`).join("\n");
  if (bytes(text) <= budget) return { text, tier: "full" };
  text = list.map((s) => `- ${s.name}: ${firstSentence(oneLine(s.description))}`).join("\n");
  if (bytes(text) <= budget) return { text, tier: "sentence" };
  const names = list.map((s) => s.name);
  text = names.join(", ");
  if (bytes(text) <= budget) return { text, tier: "names" };
  const tail = (n: number) => `(+${n} more; ask the user or use the skill tool with a name)`;
  let used = 0;
  let count = 0;
  for (const n of names) {
    if (used + bytes(n) + 2 + bytes(tail(names.length - count - 1)) + 1 > budget) break;
    used += bytes(n) + 2;
    count++;
  }
  return {
    text: `${names.slice(0, count).join(", ")} ${tail(names.length - count)}`,
    tier: "truncated",
  };
}

export const indexList = (skills: Skill[], budget = INDEX_BUDGET_BYTES): string =>
  indexTier(skills, budget).text;

let template: string | undefined;
const INDEX_TAG = "untrusted_skills_index";

/**
 * The system-prompt section: names and descriptions only (never bodies), fenced as untrusted.
 * The whole section, template and fence included, fits `INDEX_BUDGET_BYTES`.
 */
export function skillIndex(set: SkillSet): string {
  const text = template ?? readFileSync(join(PACKAGE_ROOT, "prompts", "skills-index.md"), "utf8");
  template = text;
  const render = (budget: number): string =>
    text.replace("{{INDEX}}", () => fenceUntrusted(INDEX_TAG, indexList(set.skills, budget)));
  // Defanging fake closers inside descriptions grows the text, so measure the FINAL text and
  // shrink the list budget by the excess until it fits.
  let budget = INDEX_BUDGET_BYTES - bytes(render(0)) + bytes(indexList(set.skills, 0));
  let out = render(budget);
  for (let i = 0; i < 20 && bytes(out) > INDEX_BUDGET_BYTES; i++) {
    budget = Math.max(0, budget - (bytes(out) - INDEX_BUDGET_BYTES));
    out = render(budget);
  }
  return out;
}
