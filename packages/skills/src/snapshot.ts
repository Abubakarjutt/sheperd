import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { assetRoot, fenceUntrusted, RewireError } from "@rewire/core";
import { materializeSkill, type Skill } from "./discover.js";
import { openNoFollow, UserGuard } from "./hash.js";

const PACKAGE_ROOT = assetRoot("skills", import.meta.url);

/** The whole skill index section is kept within this many bytes. */
export const INDEX_BUDGET_BYTES = 12 * 1024;
const DESC_CHARS = 300;
const SENTENCE_CHARS = 120;

export type SkillSetOptions = { scratch: string; home: string; xdgConfig: string };

/** A skill after its first load: where its files were copied (if they were) and their list. */
export type LoadedSkill = {
  /** The skill with `sha256` set to the hash of what was materialized (or of SKILL.md alone). */
  skill: Skill;
  /** Absolute path of the read-only copy; undefined when bundled files are unavailable. */
  dir?: string;
  files: Array<{ path: string; bytes: number }>;
  /** Why bundled files are unavailable (user skills only). */
  unavailable?: string;
  /** True only for the call that actually materialized the skill. */
  first: boolean;
};

export type SkillSet = {
  skills: Skill[];
  /** `<scratch>/skills`: each loaded skill lives in `<root>/<name>/`. */
  root: string;
  /** Materialize (once per session) and return a skill. Throws skill_invalid for a repo skill
   *  that no longer matches its pinned hash. Rejects unknown names with skill_invalid. */
  load(name: string): Promise<LoadedSkill>;
};

/** Skills the model may see and load: not shadowed, not `disable-model-invocation`. */
export const invocable = (skills: Skill[]): Skill[] =>
  skills.filter((s) => s.modelInvocable && !s.shadowed);

async function makeReadOnly(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await makeReadOnly(join(path, name));
    await chmod(path, 0o555);
  } else if (st.isFile()) {
    await chmod(path, st.mode & 0o111 ? 0o555 : 0o444);
  }
}

/** Make a read-only tree removable again (tests, cleanup). */
export async function makeWritable(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return;
  if (st.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else if (st.isFile()) await chmod(path, 0o644);
}

async function skillMdSha(skill: Skill, opts: SkillSetOptions): Promise<string> {
  try {
    const guard = await UserGuard.create(opts);
    const real = await guard.resolve(join(skill.dir, "SKILL.md"));
    const fh = await openNoFollow(real, false);
    try {
      return createHash("sha256")
        .update(await fh.readFile())
        .digest("hex");
    } finally {
      await fh.close();
    }
  } catch {
    return createHash("sha256").update(skill.body).digest("hex");
  }
}

const reason = (e: unknown): string =>
  e instanceof RewireError ? `${e.code}: ${e.message}` : "cannot read bundled files";

/**
 * A session's skills. Cheap: nothing is copied until the skill tool first loads a skill, which
 * copies it (read-only) under `<scratch>/skills/<name>/` and hashes the copy. A repo skill whose
 * copy does not hash to the sha256 pinned at discovery is rejected (`skill_invalid`) and nothing
 * is left at its final path. A user skill that cannot be copied (over the caps, unreadable)
 * degrades to its SKILL.md body alone.
 */
export function createSkillSet(skills: Skill[], opts: SkillSetOptions): SkillSet {
  const root = join(opts.scratch, "skills");
  const byName = new Map(invocable(skills).map((s) => [s.name, s]));
  const cache = new Map<string, Promise<LoadedSkill>>();

  const materialize = async (skill: Skill): Promise<LoadedSkill> => {
    await mkdir(root, { recursive: true });
    const tmp = join(root, `.tmp-${skill.name}-${randomUUID()}`);
    try {
      const snap = await materializeSkill(skill, tmp, opts);
      if (skill.source === "repo" && snap.sha256 !== skill.sha256) {
        throw new RewireError(
          "skill_invalid",
          `repo skill ${skill.name} changed since approval; not loaded`,
        );
      }
      const dest = join(root, skill.name);
      await rename(tmp, dest);
      await makeReadOnly(dest);
      return {
        skill: { ...skill, sha256: snap.sha256 },
        dir: dest,
        files: snap.files,
        first: true,
      };
    } catch (e) {
      await makeWritable(tmp).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      if (skill.source === "repo") throw e;
      return {
        skill: { ...skill, sha256: await skillMdSha(skill, opts) },
        files: skill.files,
        unavailable: reason(e),
        first: true,
      };
    }
  };

  return {
    skills,
    root,
    load(name) {
      const skill = byName.get(name);
      if (!skill) return Promise.reject(new RewireError("skill_invalid", `unknown skill: ${name}`));
      const hit = cache.get(name);
      if (hit) return hit.then((l) => ({ ...l, first: false }));
      const p = materialize(skill);
      cache.set(name, p);
      p.catch(() => cache.delete(name));
      return p;
    },
  };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstSentence = (s: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return clip(m ? m[0] : s, SENTENCE_CHARS);
};
const bytes = (s: string): number => Buffer.byteLength(s);

/** The index list text, degraded in steps until it fits `INDEX_BUDGET_BYTES`. */
export function indexList(skills: Skill[]): string {
  const list = invocable(skills);
  if (list.length === 0) return "(none)";
  const full = list.map((s) => `- ${s.name}: ${clip(oneLine(s.description), DESC_CHARS)}`);
  let text = full.join("\n");
  if (bytes(text) <= INDEX_BUDGET_BYTES) return text;
  text = list.map((s) => `- ${s.name}: ${firstSentence(oneLine(s.description))}`).join("\n");
  if (bytes(text) <= INDEX_BUDGET_BYTES) return text;
  const names = list.map((s) => s.name);
  text = names.join(", ");
  if (bytes(text) <= INDEX_BUDGET_BYTES) return text;
  const tail = (n: number) => `(+${n} more; ask the user or use the skill tool with a name)`;
  let used = 0;
  let count = 0;
  for (const n of names) {
    const add = bytes(n) + 2;
    if (used + add + bytes(tail(names.length - count - 1)) + 1 > INDEX_BUDGET_BYTES) break;
    used += add;
    count++;
  }
  return `${names.slice(0, count).join(", ")} ${tail(names.length - count)}`;
}

let template: string | undefined;

/** The system-prompt section: names and descriptions only (never bodies), fenced as untrusted. */
export function skillIndex(set: SkillSet): string {
  const text = template ?? readFileSync(join(PACKAGE_ROOT, "prompts", "skills-index.md"), "utf8");
  template = text;
  const block = fenceUntrusted("skills_index", indexList(set.skills));
  return text.replace("{{INDEX}}", () => block);
}
