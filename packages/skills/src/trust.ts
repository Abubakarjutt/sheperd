import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Skill } from "./discover.js";

/** Repo realpath -> sha256 of its repo skills at approval time. A Map so keys like "__proto__" are inert. */
export type TrustStore = { readonly repos: ReadonlyMap<string, string> };

const HASH = /^[0-9a-f]{64}$/;

const empty = (): TrustStore => ({ repos: new Map() });

/** Parses the trust file; anything not exactly the expected shape yields undefined (never "trusted"). */
function parseStore(text: string): TrustStore | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const raw = Object.getOwnPropertyDescriptor(data, "repos")?.value as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const repos = new Map<string, string>();
  for (const key of Object.keys(raw)) {
    const v = Object.getOwnPropertyDescriptor(raw, key)?.value as unknown;
    if (typeof v === "string" && HASH.test(v)) repos.set(key, v);
  }
  return { repos };
}

/** A missing file is an empty store; a corrupt one is moved to `<path>.bak` and treated as empty. */
export async function loadTrust(path: string): Promise<TrustStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return empty();
  }
  const parsed = parseStore(text);
  if (parsed) return parsed;
  try {
    await rename(path, `${path}.bak`);
  } catch {
    // best effort: the store is empty either way
  }
  return empty();
}

export function isTrusted(
  store: TrustStore,
  repoRealpath: string,
  repoSkillsHash: string,
): boolean {
  const pinned = store.repos.get(repoRealpath);
  return typeof pinned === "string" && pinned === repoSkillsHash;
}

export function trust(store: TrustStore, repoRealpath: string, repoSkillsHash: string): TrustStore {
  const repos = new Map(store.repos);
  repos.set(repoRealpath, repoSkillsHash);
  return { repos };
}

/** Atomic write (tmp + rename), mode 0600. */
export async function saveTrust(path: string, store: TrustStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const repos: Record<string, string> = Object.create(null);
  for (const [k, v] of store.repos) repos[k] = v;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * sha256 over the sorted `name:sha256` pairs of the REPO skills. Shadowed repo skills are included:
 * one could become active if the user skill is removed, so it must be covered by the approval.
 */
export function repoSkillsHash(skills: Skill[]): string {
  const lines = skills
    .filter((s) => s.source === "repo")
    .map((s) => {
      if (!s.sha256) throw new Error(`repo skill ${s.name} has no sha256`);
      return `${s.name}:${s.sha256}`;
    })
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** User skills are always active; repo skills only when trusted. Shadowed repo skills are never either. */
export function resolveSkills(
  found: Skill[],
  trusted: boolean,
): { active: Skill[]; pendingRepo: Skill[] } {
  const active: Skill[] = [];
  const pendingRepo: Skill[] = [];
  for (const s of found) {
    if (s.source === "user") active.push(s);
    else if (s.shadowed) continue;
    else if (trusted) active.push(s);
    else pendingRepo.push(s);
  }
  return { active, pendingRepo };
}
