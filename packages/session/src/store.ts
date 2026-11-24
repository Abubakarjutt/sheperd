import { appendFile, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newRunId, RewireError, redact } from "@rewire/core";
import type { ChatMessage } from "@rewire/providers";
import { z } from "zod";

/** `<repo>/.rewire/sessions`, relative to the repo root. */
export const SESSIONS_DIR = join(".rewire", "sessions");

/** Session ids are run-id shaped (`YYYYMMDD-HHMMSS-<6 hex>`); nothing else is ever a path. */
const ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const TITLE_MAX = 80;

const Message = z
  .object({
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

const corrupt = (id: string, why: string): RewireError =>
  new RewireError(
    "session_corrupt",
    `session ${id} is corrupt: ${why}`,
    "start a new session; the file is kept as it is",
  );

const notFound = (id: string): RewireError =>
  new RewireError(
    "session_not_found",
    `unknown session id: ${JSON.stringify(id).slice(0, 80)}`,
    "list the repo's sessions first, or create one",
  );

/**
 * Chat sessions as JSONL under `<repo>/.rewire/sessions/<id>.jsonl` (dir 0700, files 0600). Every
 * string is redacted with `redact()` before it is written. A store knows the ids it created or
 * listed; any other id is refused (`session_not_found`), so an id is never resolved as a path.
 */
export class SessionStore {
  private readonly paths = new Map<string, string>();

  private async dir(repo: string): Promise<string> {
    const dir = join(repo, SESSIONS_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    return dir;
  }

  private path(id: string): string {
    const p = ID.test(id) ? this.paths.get(id) : undefined;
    if (p === undefined) throw notFound(id);
    return p;
  }

  /** Create an empty session file and return its id. */
  async create(repo: string): Promise<string> {
    const dir = await this.dir(repo);
    for (;;) {
      const id = newRunId();
      const path = join(dir, `${id}.jsonl`);
      try {
        await writeFile(path, "", { mode: 0o600, flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      this.paths.set(id, path);
      return id;
    }
  }

  /**
   * Append one message, or a whole turn, as redacted JSONL lines in a single write, so a turn is
   * on disk entirely or (on a failed write) not at all.
   */
  async append(id: string, msgs: ChatMessage | ChatMessage[]): Promise<void> {
    const path = this.path(id);
    const list = Array.isArray(msgs) ? msgs : [msgs];
    if (list.length === 0) return;
    const lines = list.map((m) => `${JSON.stringify(redactDeep(m))}\n`).join("");
    await appendFile(path, lines, { mode: 0o600 });
  }

  /** The repo's sessions, newest (last written) first. */
  async list(repo: string): Promise<SessionSummary[]> {
    const dir = join(repo, SESSIONS_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!ID.test(id)) continue;
      const path = join(dir, name);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(path);
      } catch {
        continue; // removed between readdir and stat
      }
      if (!st.isFile()) continue;
      this.paths.set(id, path);
      out.push({ id, title: await titleOf(path), updatedAt: st.mtime });
    }
    return out.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1),
    );
  }

  /** Every message of a session. A malformed or truncated line throws `session_corrupt`. */
  async load(id: string): Promise<ChatMessage[]> {
    const raw = await readFile(this.path(id), "utf8");
    if (raw === "") return [];
    if (!raw.endsWith("\n")) throw corrupt(id, "the last line is truncated");
    const lines = raw.slice(0, -1).split("\n");
    return lines.map((line, i) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw corrupt(id, `line ${i + 1} is not valid JSON`);
      }
      const m = Message.safeParse(json);
      if (!m.success) throw corrupt(id, `line ${i + 1} is not a chat message`);
      return m.data as ChatMessage;
    });
  }
}

async function titleOf(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return "(unreadable)";
  }
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return "(unreadable)";
    }
    const parsed = Message.safeParse(m);
    if (!parsed.success) return "(unreadable)";
    if (parsed.data.role !== "user") continue;
    const first = parsed.data.content.split("\n")[0]?.trim() ?? "";
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 3)}...` : first || "(empty)";
  }
  return "(empty)";
}
