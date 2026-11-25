import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { newRunId, RewireError, redact } from "@rewire/core";
import type { ChatMessage } from "@rewire/providers";
import { z } from "zod";

/** `<repo>/.rewire/sessions`, relative to the repo root. */
export const SESSIONS_DIR = join(".rewire", "sessions");

/** Session ids are run-id shaped (`YYYYMMDD-HHMMSS-<6 hex>`); nothing else is ever a path. */
const ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const TITLE_MAX = 80;
/** `/resume` listings read at most this much of each session file for its title (M8). */
const TITLE_READ_MAX = 64 * 1024;

const { O_RDONLY, O_RDWR, O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants;
/** Never follow a final symlink; never block on a FIFO planted under a session name. */
const READ_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

const Message = z
  .object({
    /** The stable id the store wrote (`m<n>`); absent in files written before ids existed. */
    id: z.string().optional(),
    /**
     * Store-only, on tool results: whether the tool call failed. Absent in files written before
     * it was recorded. Never sent to a provider.
     */
    isError: z.boolean().optional(),
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      )
      .optional(),
    toolCallId: z.string().optional(),
  })
  .strict();

/**
 * A stored message with its stable id (`m<n>`: its 0-based position among message lines) and,
 * on a tool result whose outcome was recorded, `isError`. Both are store-only: strip them before a
 * message reaches a provider.
 */
export type StoredMessage = ChatMessage & { id: string; isError?: boolean };

/** What `append` takes: a chat message, optionally flagged as a failed tool result. */
export type AppendMessage = ChatMessage & { isError?: boolean };

/**
 * Lines that are not chat messages (Task 6 appends `{type:"compaction",...}`). They are skipped
 * by `load` and never shift message numbering. Any other `type` is corruption.
 */
const NON_MESSAGE_TYPES = new Set(["compaction"]);

type Line =
  | { kind: "message"; message: ChatMessage & { id?: string; isError?: boolean } }
  | { kind: "other" };

/** Classify one JSONL line; undefined when it is neither a chat message nor a known record. */
function parseLine(line: string): Line | "invalid_json" | "unknown_type" | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return "invalid_json";
  }
  if (json !== null && typeof json === "object" && !Array.isArray(json) && !("role" in json)) {
    const type = (json as { type?: unknown }).type;
    if (typeof type === "string")
      return NON_MESSAGE_TYPES.has(type) ? { kind: "other" } : "unknown_type";
    return undefined;
  }
  const m = Message.safeParse(json);
  return m.success
    ? { kind: "message", message: m.data as ChatMessage & { id?: string; isError?: boolean } }
    : undefined;
}

/**
 * Every message of a session's raw text with its id, checked: a malformed or truncated line, an
 * unknown line type, or a stored id that disagrees with its position throws `session_corrupt`.
 */
function parseSession(id: string, raw: string): StoredMessage[] {
  if (raw === "") return [];
  if (!raw.endsWith("\n")) throw corrupt(id, "the last line is truncated");
  const out: StoredMessage[] = [];
  raw
    .slice(0, -1)
    .split("\n")
    .forEach((line, i) => {
      const parsed = parseLine(line);
      if (parsed === "invalid_json") throw corrupt(id, `line ${i + 1} is not valid JSON`);
      if (parsed === undefined) throw corrupt(id, `line ${i + 1} is not a chat message`);
      if (parsed === "unknown_type") throw corrupt(id, `line ${i + 1} has an unknown line type`);
      if (parsed.kind !== "message") return;
      const expected = `m${out.length}`;
      const { id: stored, ...message } = parsed.message;
      if (stored !== undefined && stored !== expected) {
        throw corrupt(
          id,
          `line ${i + 1} has id ${JSON.stringify(stored).slice(0, 40)}, expected ${expected}`,
        );
      }
      out.push({ id: expected, ...message });
    });
  return out;
}

export type SessionSummary = {
  id: string;
  /** First line of the first user message, or "(empty)" / "(unreadable)". Already redacted. */
  title: string;
  /** Last write (file mtime). */
  updatedAt: Date;
};

/** Redact every string inside a JSON-shaped value; keys and structure are kept. */
function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  }
  return v;
}

const corrupt = (
  id: string,
  why: string,
  hint = "start a new session; the file is kept as it is",
): RewireError => new RewireError("session_corrupt", `session ${id} is corrupt: ${why}`, hint);

/** The hint `append` gives: this session stores no more turns until the file is repaired. */
const APPEND_CORRUPT_HINT =
  "this session cannot store more turns: start a new session, or repair the file by removing its partial or malformed line (usually the last one)";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

/**
 * Take `<session>.jsonl.lock` (O_CREAT|O_EXCL|O_NOFOLLOW, 0600) so a count-and-write is never
 * interleaved with another writer's, retrying with backoff for up to 2 s (then `session_locked`).
 * A lock older than 30 s is stolen by an atomic rename to a unique name (only one renamer wins);
 * a stolen lock that turns out to be fresh is put back. Same scheme as the skills trust store.
 */
async function acquireLock(lock: string): Promise<string> {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return token;
    } catch (e) {
      if (errno(e) === "ELOOP") throw unsafe(`${lock} is a symlink`);
      if (errno(e) !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - (await lstat(lock)).mtimeMs > LOCK_STALE_MS) {
        const stolen = `${lock}.stale-${token}`;
        try {
          await rename(lock, stolen);
        } catch {
          continue; // someone else stole it first
        }
        if (Date.now() - (await lstat(stolen)).mtimeMs > LOCK_STALE_MS) {
          await unlink(stolen).catch(() => {});
        } else {
          // We raced a fresh holder and took its live lock: put it back (link fails if retaken).
          await link(stolen, lock).catch(() => {});
          await unlink(stolen).catch(() => {});
        }
        continue;
      }
    } catch {
      continue; // the lock vanished: retry now
    }
    if (Date.now() > deadline) {
      throw new RewireError(
        "session_locked",
        "the session file is locked by another writer",
        "another rewire process is writing this session; wait and retry, or remove the .lock file if no other rewire is running",
      );
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(200, 5 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random())),
    );
  }
}

/** Remove the lock only if it still carries our token (it may have been stolen as stale). */
async function releaseLock(lock: string, token: string): Promise<void> {
  try {
    const fh = await open(lock, READ_FLAGS);
    let held: string;
    try {
      held = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
    if (held === token) await unlink(lock);
  } catch {
    // already gone
  }
}

const notFound = (id: string): RewireError =>
  new RewireError(
    "session_not_found",
    `unknown session id: ${JSON.stringify(id).slice(0, 80)}`,
    "list the repo's sessions first, or create one",
  );

const unsafe = (what: string): RewireError =>
  new RewireError(
    "session_store_unsafe",
    `refusing to use the session store: ${what}`,
    ".rewire/ and .rewire/sessions/ must be real directories inside the repo and each session a regular file; remove the symlink or file in the way",
  );

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/**
 * Make sure `path` is a real directory (never a symlink). Creates it when missing (with `mode`,
 * then chmod: only a directory this call created is ever chmodded). Returns false when missing
 * and `create` is false.
 */
async function realDir(path: string, create: boolean, mode?: number): Promise<boolean> {
  for (;;) {
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) throw unsafe(`${path} is a symlink`);
      if (!st.isDirectory()) throw unsafe(`${path} is not a directory`);
      return true;
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
    }
    if (!create) return false;
    try {
      await mkdir(path, mode === undefined ? {} : { mode });
    } catch (e) {
      if (errno(e) === "EEXIST") continue; // raced: inspect what is there now
      throw e;
    }
    if (mode !== undefined) await chmod(path, mode);
    return true;
  }
}

/**
 * Chat sessions as JSONL under `<repo>/.rewire/sessions/<id>.jsonl` (dir 0700, files 0600). Every
 * string is redacted with `redact()` before it is written. A store knows the ids it created or
 * listed; any other id is refused (`session_not_found`), so an id is never resolved as a path.
 *
 * A cloned repo controls `.rewire/` (git stores symlinks), so nothing here follows one:
 * `.rewire` and `.rewire/sessions` must be real directories whose realpath stays under the
 * repo's, and every session file is opened with O_NOFOLLOW. Otherwise `session_store_unsafe`.
 */
export class SessionStore {
  private readonly repos = new Map<string, string>();
  /** Message-line count per session, valid while the file has `size` bytes. */
  private readonly counts = new Map<string, { size: number; count: number }>();

  /** The checked sessions dir, or undefined when it does not exist and `create` is false. */
  private async dir(repo: string, create: boolean): Promise<string | undefined> {
    const root = await realpath(resolve(repo));
    const rewire = join(root, ".rewire");
    const sessions = join(rewire, "sessions");
    if (!(await realDir(rewire, create))) return undefined;
    if (!(await realDir(sessions, create, 0o700))) return undefined;
    if ((await realpath(sessions)) !== sessions) {
      throw unsafe(`${sessions} resolves outside the repo`);
    }
    return sessions;
  }

  /** The checked path of a known session. */
  private async path(id: string): Promise<string> {
    const repo = ID.test(id) ? this.repos.get(id) : undefined;
    if (repo === undefined) throw notFound(id);
    const dir = await this.dir(repo, false);
    if (dir === undefined) throw notFound(id);
    return join(dir, `${id}.jsonl`);
  }

  /** Create an empty session file and return its id. */
  async create(repo: string): Promise<string> {
    const dir = (await this.dir(repo, true)) as string;
    for (;;) {
      const id = newRunId();
      try {
        const fh = await open(
          join(dir, `${id}.jsonl`),
          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
          0o600,
        );
        await fh.close();
      } catch (e) {
        if (errno(e) === "EEXIST") continue;
        throw e;
      }
      this.repos.set(id, repo);
      return id;
    }
  }

  /**
   * Append one message, or a whole turn, as redacted JSONL lines in a single write, so a turn is
   * on disk entirely or (on a failed write) not at all. Each line gets the next stable id
   * (`m<n>`, n = the number of message lines already in the file; any id the caller passed is
   * replaced). Returns the assigned ids. The count is taken from the file itself (cached by file
   * size) under a per-session lock file (`session_locked` after 2 s of contention), so two
   * writers never assign the same ids; a file whose last line is truncated or malformed is
   * refused (`session_corrupt`, with a repair hint) rather than extended. A tool message passed
   * with a boolean `isError` is stored with it (store-only; `load` returns it, callers strip it).
   */
  async append(id: string, msgs: AppendMessage | AppendMessage[]): Promise<string[]> {
    const path = await this.path(id);
    const list = Array.isArray(msgs) ? msgs : [msgs];
    if (list.length === 0) return [];
    const lock = `${path}.lock`;
    const token = await acquireLock(lock);
    try {
      const fh = await openFile(path, O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw unsafe(`${path} is not a regular file`);
        let base: number;
        const cached = this.counts.get(id);
        if (cached !== undefined && cached.size === st.size) {
          base = cached.count;
        } else {
          try {
            base = parseSession(id, await fh.readFile("utf8")).length;
          } catch (e) {
            if (e instanceof RewireError && e.code === "session_corrupt") {
              throw new RewireError(e.code, e.message, APPEND_CORRUPT_HINT);
            }
            throw e;
          }
        }
        const ids = list.map((_, i) => `m${base + i}`);
        const lines = list
          .map((m, i) => {
            const { id: _id, isError, ...rest } = m as AppendMessage & { id?: unknown };
            const flag = typeof isError === "boolean" && rest.role === "tool" ? { isError } : {};
            return `${JSON.stringify({ id: ids[i], ...flag, ...(redactDeep(rest) as object) })}\n`;
          })
          .join("");
        await fh.appendFile(lines, "utf8");
        this.counts.set(id, {
          size: st.size + Buffer.byteLength(lines, "utf8"),
          count: base + list.length,
        });
        return ids;
      } finally {
        await fh.close();
      }
    } finally {
      await releaseLock(lock, token);
    }
  }

  /**
   * The repo's sessions, newest (last written) first. Entries that are not regular files
   * (symlinks, directories, FIFOs) or not named `<id>.jsonl` are skipped by design: they are
   * never sessions this store wrote, and following them could read outside the repo.
   */
  async list(repo: string): Promise<SessionSummary[]> {
    const dir = await this.dir(repo, false);
    if (dir === undefined) return [];
    const out: SessionSummary[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!ID.test(id)) continue;
      const path = join(dir, name);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(path);
      } catch {
        continue; // removed between readdir and lstat
      }
      if (!st.isFile()) continue; // see the doc comment: skipped, never followed
      this.repos.set(id, repo);
      out.push({ id, title: await titleOf(path), updatedAt: st.mtime });
    }
    return out.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1),
    );
  }

  /**
   * Every message of a session, each with its stable id (files written before ids existed get
   * ids from their position). Non-message lines are skipped. A malformed or truncated line, an
   * unknown line type, or an id that disagrees with its position throws `session_corrupt`.
   */
  async load(id: string): Promise<StoredMessage[]> {
    const path = await this.path(id);
    const fh = await openFile(path, READ_FLAGS);
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw unsafe(`${path} is not a regular file`);
      const raw = await fh.readFile("utf8");
      const messages = parseSession(id, raw);
      this.counts.set(id, { size: Buffer.byteLength(raw, "utf8"), count: messages.length });
      return messages;
    } finally {
      await fh.close();
    }
  }
}

async function openFile(path: string, flags: number) {
  try {
    return await open(path, flags);
  } catch (e) {
    if (errno(e) === "ELOOP") throw unsafe(`${path} is a symlink`);
    if (errno(e) === "ENXIO") throw unsafe(`${path} is not a regular file`);
    throw e;
  }
}

/**
 * The first `max` bytes of a session file, cut back to its last complete line; `undefined` when
 * the file has bytes but no complete line within them.
 */
async function readHead(path: string, max: number): Promise<string | undefined> {
  const fh = await openFile(path, READ_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) throw unsafe(`${path} is not a regular file`);
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return bytesRead === 0 ? "" : undefined;
    return buf.subarray(0, end).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function titleOf(path: string): Promise<string> {
  let raw: string | undefined;
  try {
    raw = await readHead(path, TITLE_READ_MAX);
  } catch {
    return "(unreadable)";
  }
  // No complete line within the read: a first message too long to title.
  if (raw === undefined) return "(untitled)";
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parsed = parseLine(line);
    if (parsed === undefined || typeof parsed === "string") return "(unreadable)";
    if (parsed.kind !== "message" || parsed.message.role !== "user") continue;
    const first = parsed.message.content.split("\n")[0]?.trim() ?? "";
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 3)}...` : first || "(empty)";
  }
  return "(empty)";
}
