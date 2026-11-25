import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { SessionStore } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-session-store-")));
  dirs.push(d);
  return d;
}

const sessionFile = (repo: string, id: string): string =>
  join(repo, ".rewire", "sessions", `${id}.jsonl`);

test("append redacts sk- tokens before writing, in content and tool arguments", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const id = await store.create(repo);
  await store.append(id, [
    { role: "user", content: "my key is sk-ant-abc123DEF456 please" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "bash", arguments: { command: "echo sk-proj-zzz999" } }],
    },
    { role: "tool", content: "stdout:\nsk-proj-zzz999", toolCallId: "c1" },
    { role: "assistant", content: "done" },
  ]);
  const raw = readFileSync(sessionFile(repo, id), "utf8");
  expect(raw).not.toMatch(/sk-ant-abc|sk-proj-zzz/);
  expect(raw).toContain("[redacted]");
  const loaded = await store.load(id);
  expect(loaded).toHaveLength(4);
  expect(loaded[0]?.content).toBe("my key is [redacted] please");
  expect(loaded[1]?.toolCalls?.[0]?.arguments).toEqual({ command: "echo [redacted]" });
});

test("a redacted PEM block keeps every line valid JSON", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const id = await store.create(repo);
  await store.append(id, {
    role: "user",
    content: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc (truncated, no END line)",
  });
  const loaded = await store.load(id);
  expect(loaded[0]?.content).toBe("[redacted]");
});

test("session dir is 0700 and files are 0600", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const id = await store.create(repo);
  await store.append(id, { role: "user", content: "hi" });
  expect(statSync(join(repo, ".rewire", "sessions")).mode & 0o777).toBe(0o700);
  expect(statSync(sessionFile(repo, id)).mode & 0o777).toBe(0o600);
});

test("list orders sessions newest first, titled by the first user line", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const a = await store.create(repo);
  await store.append(a, [
    { role: "user", content: "why does wrap break?\nmore detail" },
    { role: "assistant", content: "because" },
  ]);
  const b = await store.create(repo);
  await store.append(b, { role: "user", content: "second session" });
  const c = await store.create(repo);
  const now = Date.now() / 1000;
  utimesSync(sessionFile(repo, a), now - 10, now - 10);
  utimesSync(sessionFile(repo, b), now - 100, now - 100);
  utimesSync(sessionFile(repo, c), now - 50, now - 50);
  const listed = await new SessionStore().list(repo);
  expect(listed.map((s) => s.id)).toEqual([a, c, b]);
  expect(listed[0]?.title).toBe("why does wrap break?");
  expect(listed[1]?.title).toBe("(empty)");
  expect(listed[2]?.title).toBe("second session");
});

test("list reads at most 64 KiB per session for its title (M8)", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const big = await store.create(repo);
  // A first line longer than the title read is not parsed: it lists as (untitled).
  await store.append(big, { role: "user", content: "x".repeat(70 * 1024) });
  const ok = await store.create(repo);
  await store.append(ok, [
    { role: "user", content: "short title" },
    { role: "assistant", content: "y".repeat(200 * 1024) },
  ]);
  const listed = await new SessionStore().list(repo);
  expect(listed.find((s) => s.id === big)?.title).toBe("(untitled)");
  expect(listed.find((s) => s.id === ok)?.title).toBe("short title");
});

test("list on a repo with no sessions is empty", async () => {
  expect(await new SessionStore().list(tempRepo())).toEqual([]);
});

test("load of a listed session works from a fresh store", async () => {
  const repo = tempRepo();
  const first = new SessionStore();
  const id = await first.create(repo);
  await first.append(id, { role: "user", content: "x" });
  const fresh = new SessionStore();
  await expect(fresh.load(id)).rejects.toMatchObject({ code: "session_not_found" });
  await fresh.list(repo);
  expect(await fresh.load(id)).toEqual([{ role: "user", content: "x" }]);
});

test("a truncated last line makes load throw session_corrupt", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const id = await store.create(repo);
  await store.append(id, { role: "user", content: "hello" });
  appendFileSync(sessionFile(repo, id), '{"role":"assistant","content":"cut of');
  await expect(store.load(id)).rejects.toMatchObject({ code: "session_corrupt" });
});

test("a complete but malformed line makes load throw session_corrupt", async () => {
  const repo = tempRepo();
  const store = new SessionStore();
  const id = await store.create(repo);
  await store.append(id, { role: "user", content: "hello" });
  appendFileSync(sessionFile(repo, id), '{"role":"wizard","content":"x"}\n');
  await expect(store.load(id)).rejects.toMatchObject({ code: "session_corrupt" });
});

test("an unknown or malformed id is refused, never resolved as a path", async () => {
  const store = new SessionStore();
  await expect(store.load("../../etc/passwd")).rejects.toMatchObject({
    code: "session_not_found",
  });
  await expect(store.load("20260101-000000-abcdef")).rejects.toMatchObject({
    code: "session_not_found",
  });
});

function outside(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-session-victim-")));
  dirs.push(d);
  chmodSync(d, 0o755);
  return d;
}

test("a symlinked .rewire/sessions dir is refused; the target is untouched", async () => {
  const repo = tempRepo();
  const victim = outside();
  mkdirSync(join(repo, ".rewire"));
  symlinkSync(victim, join(repo, ".rewire", "sessions"));
  const store = new SessionStore();
  await expect(store.create(repo)).rejects.toMatchObject({ code: "session_store_unsafe" });
  await expect(store.list(repo)).rejects.toMatchObject({ code: "session_store_unsafe" });
  expect(statSync(victim).mode & 0o777).toBe(0o755);
  expect(readdirSync(victim)).toEqual([]);
});

test("a symlinked .rewire dir is refused; the target is untouched", async () => {
  const repo = tempRepo();
  const victim = outside();
  symlinkSync(victim, join(repo, ".rewire"));
  await expect(new SessionStore().create(repo)).rejects.toMatchObject({
    code: "session_store_unsafe",
  });
  expect(readdirSync(victim)).toEqual([]);
  expect(statSync(victim).mode & 0o777).toBe(0o755);
});

test("a symlinked session file is not listed, loaded or appended to", async () => {
  const repo = tempRepo();
  const victim = outside();
  const target = join(victim, "target.jsonl");
  writeFileSync(target, "");
  const store = new SessionStore();
  const real = await store.create(repo);
  const planted = "20260101-000000-aaaaaa";
  symlinkSync(target, sessionFile(repo, planted));
  const listed = await store.list(repo);
  expect(listed.map((s) => s.id)).toEqual([real]);
  await expect(store.load(planted)).rejects.toMatchObject({ code: "session_not_found" });

  // A session file swapped for a symlink after it was created is refused too.
  rmSync(sessionFile(repo, real));
  symlinkSync(target, sessionFile(repo, real));
  await expect(store.append(real, { role: "user", content: "leak" })).rejects.toMatchObject({
    code: "session_store_unsafe",
  });
  await expect(store.load(real)).rejects.toMatchObject({ code: "session_store_unsafe" });
  expect(readFileSync(target, "utf8")).toBe("");
});

test("an existing .rewire dir is used as is, never chmodded", async () => {
  const repo = tempRepo();
  mkdirSync(join(repo, ".rewire"), { mode: 0o755 });
  chmodSync(join(repo, ".rewire"), 0o755);
  await new SessionStore().create(repo);
  expect(statSync(join(repo, ".rewire")).mode & 0o777).toBe(0o755);
});
