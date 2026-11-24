import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { RewireError } from "@rewire/core";
import type { Skill } from "./discover.js";

/** Repo realpath -> sha256 of its repo skills at approval time. A Map so keys like "__proto__" are inert. */
export type TrustStore = { readonly repos: ReadonlyMap<string, string> };

const HASH = /^[0-9a-f]{64}$/;

const empty = (): TrustStore => ({ repos: new Map() });

/** Parses the trust file; anything not exactly the expected shape yields undefined (never "trusted"). */
function parseStore(text: string): { repos: Map<string, string>; dropped: boolean } | undefined {
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
  let dropped = false;
  for (const key of Object.keys(raw)) {
    const v = Object.getOwnPropertyDescriptor(raw, key)?.value as unknown;
    if (key !== "__proto__" && typeof v === "string" && HASH.test(v)) repos.set(key, v);
    else dropped = true;
  }
  return { repos, dropped };
}

const unreadable = (message: string) => new RewireError("trust_store_unreadable", message);
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;

/** Refuses a symlinked trust path: it is neither followed nor replaced. */
async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw unreadable(`trust file is a symlink: ${path}`);
  } catch (e) {
    if (e instanceof RewireError) throw e;
    if (errCode(e) !== "ENOENT") throw unreadable(`cannot stat trust file: ${errCode(e) ?? e}`);
  }
}

/** Copies the original aside without ever overwriting an earlier backup. */
async function backup(path: string, move: boolean): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 0; n < 1000; n++) {
    const dest = `${path}.${stamp}${n ? `-${n}` : ""}.bak`;
    try {
      await copyFile(path, dest, constants.COPYFILE_EXCL);
      if (move) await unlink(path);
      return;
    } catch (e) {
      if (errCode(e) !== "EEXIST")
        throw unreadable(`cannot back up trust file: ${errCode(e) ?? e}`);
    }
  }
  throw unreadable("cannot back up trust file: too many backups");
}

async function readStore(path: string): Promise<{ store: TrustStore; dropped: boolean }> {
  await assertNotSymlink(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return { store: empty(), dropped: false };
    throw unreadable(`cannot read trust file: ${errCode(e) ?? e}`);
  }
  const parsed = parseStore(text);
  if (!parsed) {
    await backup(path, true);
    return { store: empty(), dropped: false };
  }
  return { store: { repos: parsed.repos }, dropped: parsed.dropped };
}

/**
 * A missing file is an empty store; a corrupt one is backed up (timestamped `.bak`) and treated as
 * empty; a file with some invalid entries loads without them (and is backed up when next written).
 * Any other read error (EACCES, EISDIR, ...) or a symlinked path throws `trust_store_unreadable`
 * and touches nothing.
 */
export async function loadTrust(path: string): Promise<TrustStore> {
  return (await readStore(path)).store;
}

/**
 * The key `isTrusted`/`trust` expect: the repo's realpath. Callers must pass `trustKey(repo)` to
 * `isTrusted`; `trustRepo` applies it itself.
 */
export async function trustKey(repo: string): Promise<string> {
  return realpath(repo);
}

/** `repoRealpath` must be a `trustKey`. Compares the pinned hash for exact equality. */
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

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

/** Test seam: runs after a waiter has judged the lock stale and before it tries to steal it. */
export type LockHooks = { afterStaleSeen?: () => Promise<void> };

async function acquireLock(lock: string, hooks?: LockHooks): Promise<string> {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, "wx", 0o600);
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return token;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw unreadable(`cannot lock trust file: ${errCode(e) ?? e}`);
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
        await hooks?.afterStaleSeen?.();
        // Steal by atomic rename to a unique name: only one renamer gets the file.
        const stolen = `${lock}.stale-${token}`;
        try {
          await rename(lock, stolen);
        } catch {
          continue; // someone else stole it first
        }
        if (Date.now() - (await stat(stolen)).mtimeMs > LOCK_STALE_MS) {
          await unlink(stolen).catch(() => {});
        } else {
          // We raced a fresh holder and took its live lock: put it back (link fails if retaken).
          await link(stolen, lock).catch(() => {});
          await unlink(stolen).catch(() => {});
        }
        continue;
      }
    } catch {
      continue; // lock vanished: retry immediately
    }
    if (Date.now() > deadline) throw new RewireError("trust_store_locked", "trust file is locked");
    await new Promise((r) =>
      setTimeout(r, Math.min(200, 5 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random())),
    );
  }
}

/** Removes the lock only if it still carries our token (it may have been stolen as stale). */
async function releaseLock(lock: string, token: string): Promise<void> {
  try {
    if ((await readFile(lock, "utf8")) === token) await unlink(lock);
  } catch {
    // already gone
  }
}

/** Exported for tests only. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  hooks?: LockHooks,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const token = await acquireLock(lock, hooks);
  try {
    return await fn();
  } finally {
    await releaseLock(lock, token);
  }
}

/** Atomic write (tmp + rename), mode 0600, tmp removed on failure. Caller holds the lock. */
async function writeStore(path: string, store: TrustStore): Promise<void> {
  await assertNotSymlink(path);
  const repos: Record<string, string> = Object.create(null);
  for (const [k, v] of store.repos) repos[k] = v;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** Whole-store write under the same lock as `trustRepo`. */
export async function saveTrust(path: string, store: TrustStore): Promise<void> {
  await withLock(path, async () => {
    if ((await readStore(path)).dropped) await backup(path, false);
    await writeStore(path, store);
  });
}

/** Locked read-merge-write: concurrent callers never lose each other's approvals. */
export async function trustRepo(path: string, repo: string, hash: string): Promise<void> {
  const key = await trustKey(repo);
  await withLock(path, async () => {
    const { store, dropped } = await readStore(path);
    if (dropped) await backup(path, false);
    await writeStore(path, trust(store, key, hash));
  });
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
