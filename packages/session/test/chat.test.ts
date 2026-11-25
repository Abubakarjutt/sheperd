import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";
import {
  type ChatRequest,
  type ChatResponse,
  call,
  FauxProvider,
  type Provider,
  text,
} from "@rewire/providers";
import { sandboxAvailable } from "@rewire/sandbox";
import {
  createSkillSet,
  discoverSkills,
  disposeSkillSet,
  makeWritable,
  type SkillSet,
} from "@rewire/skills";
import { afterAll, describe, expect, test } from "vitest";
import { type ChatEvent, ChatSession, SessionStore, TURN_LIMIT_NOTE } from "../src/index.js";

const dirs: string[] = [];
const sets: SkillSet[] = [];
const sessions: ChatSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.dispose();
  for (const s of sets) await disposeSkillSet(s);
  for (const d of dirs) await makeWritable(d).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const MATH = "export const add = (a: number, b: number): number => a + b;\n";

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-chat-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "math.ts"), MATH);
  // .rewire/ (sessions) is ignored, as the README recommends.
  writeFileSync(join(root, ".gitignore"), ".rewire/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function makeSet(): Promise<SkillSet> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-chat-skillhome-")));
  dirs.push(base);
  const home = join(base, "home");
  const xdgConfig = join(base, "config");
  mkdirSync(join(home, ".claude", "skills", "tdd"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "skills", "tdd", "SKILL.md"),
    "---\nname: tdd\ndescription: Test-driven development helper\n---\nWrite the test first.\n",
  );
  const { skills } = await discoverSkills({ home, xdgConfig, repo: base });
  const set = createSkillSet(skills, { home, xdgConfig, cacheDir: join(base, "cache") });
  sets.push(set);
  return set;
}

async function setup(
  provider: Provider,
  o: {
    repo?: string;
    store?: SessionStore;
    sessionId?: string;
    maxTurns?: number;
    skills?: SkillSet;
    resume?: boolean;
  } = {},
) {
  const repo = o.repo ?? makeRepo();
  const events: ChatEvent[] = [];
  const store = o.store ?? new SessionStore();
  const skills = o.skills ?? (await makeSet());
  const opts = {
    repo,
    model: { provider: "faux", model: "chat" },
    provider,
    policy: DEFAULT_POLICY,
    skills,
    store,
    emit: (e) => events.push(e),
    ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
    ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
  };
  const session =
    o.resume && o.sessionId !== undefined
      ? await ChatSession.resume({ ...opts, sessionId: o.sessionId })
      : new ChatSession(opts);
  sessions.push(session);
  return { repo, events, store, session, skills };
}

const sessionFile = (repo: string, id: string): string =>
  join(repo, ".rewire", "sessions", `${id}.jsonl`);

describe.skipIf(!sandboxAvailable())("ChatSession", () => {
  test("the second send's request includes the first exchange", async () => {
    const p = new FauxProvider([text("first answer"), text("second answer")]);
    const { session, events } = await setup(p);
    expect((await session.send("first question")).text).toBe("first answer");
    expect((await session.send("second question")).text).toBe("second answer");
    const msgs = p.requests[1]?.messages ?? [];
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
    ]);
    expect(events.filter((e) => e.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: "first answer" },
      { type: "assistant_text", text: "second answer" },
    ]);
  });

  test("a bash write into the repo is a tool error and the tree is byte-identical", async () => {
    const p = new FauxProvider([call("bash", { command: "echo x > src/math.ts" }), text("ok")]);
    const { repo, session, events } = await setup(p);
    await session.send("break it");
    const result = p.requests[1]?.messages.find((m) => m.role === "tool");
    expect(result?.content).toMatch(/exit code [1-9]/);
    const ev = events.find((e) => e.type === "tool_call");
    expect(ev).toMatchObject({ type: "tool_call", tool: "bash", isError: true });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "src", "math.ts"), "utf8")).toBe(MATH);
  });

  test("the skill set root is readable but never writable from chat bash", async () => {
    const set = await makeSet();
    await set.load("tdd");
    const root = set.root as string;
    expect(root).toBeDefined();
    // Not vacuous: make the host copy writable, so only the sandbox can refuse the write.
    await makeWritable(root);
    writeFileSync(join(root, "tdd", "probe"), "host can write");
    rmSync(join(root, "tdd", "probe"));
    const q = new FauxProvider([
      call("bash", { command: `cat "${root}/tdd/SKILL.md" && echo x > "${root}/tdd/evil"` }),
      text("ok"),
    ]);
    const { session } = await setup(q);
    await session.send("try");
    const result = q.requests[1]?.messages.find((m) => m.role === "tool");
    expect(result?.content).toContain("Write the test first.");
    expect(result?.content).toMatch(/exit code [1-9]/);
    expect(existsSync(join(root, "tdd", "evil"))).toBe(false);
  });

  test("propose_run ends the turn with the proposal; the session stays usable", async () => {
    const p = new FauxProvider([
      {
        text: "I suggest a run.",
        toolCalls: [{ id: "", name: "propose_run", arguments: { task: "fix wrap" } }],
      },
      text("next"),
    ]);
    const { session } = await setup(p);
    const turn = await session.send("please fix wrap");
    expect(turn.proposal?.task).toBe("fix wrap");
    expect(turn.text).toBe("I suggest a run.");
    expect(turn.endedBy).toBe("proposal");
    expect(p.callCount).toBe(1);
    const h = session.history();
    expect(h[h.length - 1]?.role).toBe("assistant");
    expect(h[h.length - 1]?.toolCalls).toBeUndefined();
    const next = await session.send("thanks");
    expect(next.proposal).toBeUndefined();
    expect(next.endedBy).toBeUndefined();
    expect(next.text).toBe("next");
  });

  test("a turn cut by the turn limit says so and is stored with the limit note", async () => {
    const p = new FauxProvider([{ text: "looking", ...call("find", { pattern: "*.ts" }) }]);
    const { session } = await setup(p, { maxTurns: 1 });
    const turn = await session.send("look around");
    expect(turn.endedBy).toBe("turn_limit");
    expect(turn.proposal).toBeUndefined();
    const h = session.history();
    expect(h[h.length - 1]).toEqual({ role: "assistant", content: TURN_LIMIT_NOTE });
  });

  test("model text with a secret is redacted in events and in the turn text", async () => {
    const p = new FauxProvider([text("your key is sk-ant-SECRET123abc, keep it safe")]);
    const { session, events } = await setup(p);
    const turn = await session.send("what is the key?");
    expect(turn.text).toBe("your key is [redacted], keep it safe");
    expect(events).toContainEqual({
      type: "assistant_text",
      text: "your key is [redacted], keep it safe",
    });
    expect(JSON.stringify(events)).not.toContain("SECRET123");
  });

  test("propose_run with an empty task is a tool error, not a proposal", async () => {
    const p = new FauxProvider([call("propose_run", { task: "  " }), text("sorry")]);
    const { session } = await setup(p);
    const turn = await session.send("go");
    expect(turn.proposal).toBeUndefined();
    expect(p.requests[1]?.messages.find((m) => m.role === "tool")?.content).toMatch(/task/);
  });

  test("the tool list is read-only: no write or edit", async () => {
    const p = new FauxProvider([text("hi")]);
    const { session } = await setup(p);
    await session.send("hello");
    const names = (p.requests[0]?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["bash", "find", "grep", "propose_run", "read", "skill"]);
  });

  test("the system prompt carries the skills index and the skill tool loads a skill", async () => {
    const p = new FauxProvider([call("skill", { name: "tdd" }), text("loaded")]);
    const { session, events } = await setup(p);
    await session.send("use tdd");
    expect(p.requests[0]?.system).toContain("## Skills");
    expect(p.requests[0]?.system).toContain("tdd: Test-driven development helper");
    expect(p.requests[0]?.system).toMatch(/propose_run/);
    const result = p.requests[1]?.messages.find((m) => m.role === "tool");
    expect(result?.content).toContain("Write the test first.");
    expect(events).toContainEqual({ type: "skill_loaded", name: "tdd" });
  });

  test("a completed turn is persisted whole; the tool summary is redacted", async () => {
    const p = new FauxProvider([call("bash", { command: "echo sk-abc123secret" }), text("done")]);
    const { repo, session, store, events } = await setup(p);
    await session.send("run it");
    const id = session.id();
    expect(id).toBeDefined();
    const loaded = await store.load(id as string);
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(readFileSync(sessionFile(repo, id as string), "utf8")).not.toContain("sk-abc123");
    const ev = events.find((e) => e.type === "tool_call");
    expect(ev?.type === "tool_call" && ev.summary).not.toContain("sk-abc123");
  });

  test("an aborted send rejects promptly, persists nothing and the next send works", async () => {
    let n = 0;
    const p: Provider & { requests: ChatRequest[] } = {
      requests: [],
      chat(req: ChatRequest): Promise<ChatResponse> {
        this.requests.push({ ...req, messages: [...req.messages] });
        n++;
        if (n === 1) {
          return new Promise((_, reject) => {
            req.signal?.addEventListener("abort", () =>
              reject(new RewireError("provider_aborted", "aborted")),
            );
          });
        }
        return Promise.resolve({
          message: { text: "after", toolCalls: [] },
          stopReason: "end",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    };
    const { repo, session } = await setup(p);
    const ac = new AbortController();
    const pending = session.send("slow question", ac.signal);
    setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(session.history()).toEqual([]);
    const turn = await session.send("again");
    expect(turn.text).toBe("after");
    expect(p.requests[1]?.messages.map((m) => m.content)).toEqual(["again"]);
    const raw = readFileSync(sessionFile(repo, session.id() as string), "utf8");
    expect(raw).not.toContain("slow question");
    expect(raw).toContain("again");
  });

  test("an abort during a long bash call rejects promptly; the next send works", async () => {
    const p = new FauxProvider([call("bash", { command: "sleep 20" }), text("later")]);
    const { session } = await setup(p);
    const ac = new AbortController();
    const pending = session.send("wait", ac.signal);
    setTimeout(() => ac.abort(), 500);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(session.history()).toEqual([]);
    const turn = await session.send("again");
    expect(turn.text).toBe("later");
  });

  test("a send whose signal is already aborted rejects without calling the model", async () => {
    const p = new FauxProvider([text("never")]);
    const { session } = await setup(p);
    const ac = new AbortController();
    ac.abort();
    await expect(session.send("x", ac.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(p.callCount).toBe(0);
  });

  test("a failed turn rejects and leaves history and the file unchanged", async () => {
    const p = new FauxProvider([text("one")]);
    const { repo, session } = await setup(p);
    await session.send("q1");
    await expect(session.send("q2")).rejects.toMatchObject({ code: "faux_script_exhausted" });
    expect(session.history().map((m) => m.content)).toEqual(["q1", "one"]);
    const lines = readFileSync(sessionFile(repo, session.id() as string), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
  });

  test("a resumed session continues from its stored history", async () => {
    const repo = makeRepo();
    const store = new SessionStore();
    const id = await store.create(repo);
    await store.append(id, [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier answer" },
    ]);
    const p = new FauxProvider([text("resumed")]);
    const { session } = await setup(p, { repo, store, sessionId: id, resume: true });
    expect(session.history().map((m) => m.content)).toEqual(["earlier", "earlier answer"]);
    await session.send("now");
    expect(p.requests[0]?.messages.map((m) => m.content)).toEqual([
      "earlier",
      "earlier answer",
      "now",
    ]);
    expect((await store.load(id)).map((m) => m.content)).toEqual([
      "earlier",
      "earlier answer",
      "now",
      "resumed",
    ]);
  });

  test("a resumed history with a dangling tool call surfaces as session_corrupt", async () => {
    const repo = makeRepo();
    const store = new SessionStore();
    const id = await store.create(repo);
    await store.append(id, [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "x" } }],
      },
    ]);
    const p = new FauxProvider([text("never")]);
    const { session } = await setup(p, { repo, store, sessionId: id });
    const err = await session.send("now").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RewireError);
    expect(err).toMatchObject({ code: "session_corrupt" });
    expect((err as Error).message).toMatch(/tool call/);
    expect(p.callCount).toBe(0);
  });

  test("dispose during an in-flight send rejects it cleanly and stores nothing", async () => {
    const p: Provider = {
      chat(req: ChatRequest): Promise<ChatResponse> {
        return new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () =>
            reject(new RewireError("provider_aborted", "aborted")),
          );
        });
      },
    };
    const { session } = await setup(p);
    const pending = session.send("hang");
    await new Promise((r) => setTimeout(r, 50));
    const disposed = session.dispose();
    await expect(pending).rejects.toMatchObject({ code: "session_disposed" });
    await disposed;
    expect(session.id()).toBeUndefined();
    expect(session.history()).toEqual([]);
    await expect(session.send("after")).rejects.toMatchObject({ code: "session_disposed" });
  });

  test("a skill load finishing after its turn was aborted is not reported", async () => {
    const set = await makeSet();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = true;
    const slow: SkillSet = {
      skills: set.skills,
      root: set.root,
      load: async (name) => {
        if (gated) await gate;
        return set.load(name);
      },
    };
    const p = new FauxProvider([
      call("skill", { name: "tdd" }),
      call("skill", { name: "tdd" }),
      text("ok"),
    ]);
    const { session, events } = await setup(p, { skills: slow });
    const ac = new AbortController();
    const pending = session.send("load it", ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    gated = false;
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "skill_loaded")).toEqual([]);
    await session.send("load it again");
    expect(events.filter((e) => e.type === "skill_loaded")).toEqual([
      { type: "skill_loaded", name: "tdd" },
    ]);
  });
});
