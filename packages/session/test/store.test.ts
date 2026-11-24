import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
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
