import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "@rewire/loop";
import { type CompactionConfig, defaultCompactionConfig, resolveRouting } from "@rewire/pipeline";
import { DEFAULT_POLICY } from "@rewire/policy";
import {
  type ChatRequest,
  type ChatResponse,
  type ContextWindow,
  FauxProvider,
  type Provider,
  type ScriptedTurn,
  TokenEstimator,
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
import {
  ARCHIVE_MAX,
  type ChatEvent,
  ChatSession,
  type CompactionDeps,
  compactionDeps,
  emptyRecord,
  RECORD_PREFACE,
  type RecordItem,
  SessionStore,
  type VerifyRisky,
} from "../src/index.js";

const CACHE_BASE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.cache/rewire-test",
);
mkdirSync(CACHE_BASE, { recursive: true });

const dirs: string[] = [];
const sets: SkillSet[] = [];
const sessions: ChatSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.dispose();
  for (const s of sets) await disposeSkillSet(s);
  for (const d of dirs) await makeWritable(d).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-compaction-")));
  dirs.push(root);
  writeFileSync(join(root, ".gitignore"), ".rewire/\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

async function makeSet(): Promise<SkillSet> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-compaction-skills-")));
  dirs.push(base);
  const { skills } = await discoverSkills({
    home: join(base, "home"),
    xdgConfig: join(base, "config"),
    repo: base,
  });
  const cache = realpathSync(mkdtempSync(join(CACHE_BASE, "skill-cache-")));
  dirs.push(cache);
  const set = createSkillSet(skills, {
    home: join(base, "home"),
    xdgConfig: join(base, "config"),
    cacheDir: cache,
  });
  sets.push(set);
  return set;
}

type ChatEntry = ScriptedTurn | ((req: ChatRequest) => ScriptedTurn);
type CompactEntry = string | ((req: ChatRequest) => string) | Error;

/**
 * One model for chat and compaction (the chat model is the author model): requests with tools
 * are chat turns, requests without are compactions. `usage` gives each chat call's input tokens.
 */
function model(o: {
  chat: ChatEntry[];
  compact?: CompactEntry[];
  usage?: (req: ChatRequest) => number;
}): Provider & { chats: ChatRequest[]; compactions: ChatRequest[] } {
  const chat = [...o.chat];
  const comp = [...(o.compact ?? [])];
  let callId = 0;
  return {
    chats: [],
    compactions: [],
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { signal: _s, onDelta, onFirstChunk, ...rest } = req;
      if ((req.tools ?? []).length === 0) {
        this.compactions.push(structuredClone(rest) as ChatRequest);
        const e = comp.shift();
        if (e === undefined) throw new Error("compaction script exhausted");
        if (e instanceof Error) throw e;
        const t = typeof e === "function" ? e(req) : e;
        return {
          message: { text: t, toolCalls: [] },
          stopReason: "end",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      this.chats.push(structuredClone(rest) as ChatRequest);
      const e = chat.shift();
      if (e === undefined) throw new Error("chat script exhausted");
      const turn = typeof e === "function" ? e(req) : e;
      const toolCalls = (turn.toolCalls ?? []).map((c) => ({
        ...c,
        id: c.id !== "" ? c.id : `call_${++callId}`,
      }));
      onFirstChunk?.();
      if (turn.text) onDelta?.(turn.text);
      return {
        message: { text: turn.text ?? "", toolCalls },
        stopReason: toolCalls.length > 0 ? "tool_use" : "end",
        usage: { inputTokens: o.usage?.(req) ?? 0, outputTokens: 1 },
      };
    },
  };
}

const acceptAll: VerifyRisky = async (ops) => ops.map(() => ({ accept: true }));
const W32: ContextWindow = { window: 32768, source: "model", provisional: true };

function deps(o: Partial<CompactionDeps> & { limit?: number; recentUserTokens?: number } = {}) {
  const { limit, recentUserTokens, ...rest } = o;
  const config: CompactionConfig = {
    ...defaultCompactionConfig(),
    ...(recentUserTokens !== undefined ? { recentUserTokens } : {}),
    limits: limit !== undefined ? { "faux:chat": limit } : {},
  };
  const refreshed: ContextWindow[] = [];
  const d: CompactionDeps = {
    window: W32,
    config,
    estimator: new TokenEstimator(),
    verifier: acceptAll,
    independence: "cross-family",
    refreshWindow: async () => {
      const w = rest.window ?? W32;
      refreshed.push(w);
      return w;
    },
    ...rest,
  };
  return { deps: d, refreshed };
}

async function setup(
  provider: Provider,
  compaction: CompactionDeps | undefined,
  o: { repo?: string; store?: SessionStore; sessionId?: string } = {},
) {
  const repo = o.repo ?? makeRepo();
  const events: ChatEvent[] = [];
  const store = o.store ?? new SessionStore();
  const opts = {
    repo,
    model: { provider: "faux" as const, model: "chat" },
    provider,
    policy: DEFAULT_POLICY,
    skills: await makeSet(),
    store,
    emit: (e: ChatEvent) => events.push(e),
    ...(compaction ? { compaction } : {}),
  };
  const session =
    o.sessionId !== undefined
      ? await ChatSession.resume({ ...opts, sessionId: o.sessionId })
      : new ChatSession(opts);
  sessions.push(session);
  return { repo, events, store, session };
}

const phases = (events: ChatEvent[]) =>
  events.flatMap((e) => (e.type === "compaction" ? [e.phase] : []));
const ops = (...o: object[]): string => JSON.stringify({ ops: o });
const userAdd = (kind: string, text: string, messageId: string, quote: string) => ({
  op: "add",
  kind,
  text,
  source: "user",
  evidence: [{ messageId, quote }],
});
const sessionFile = (repo: string, id: string) => join(repo, ".rewire", "sessions", `${id}.jsonl`);

/** The smallest text length whose next-request estimate reaches `target`. */
async function lengthAt(session: ChatSession, target: number): Promise<number> {
  let lo = 0;
  let hi = 1;
  const at = async (n: number) => (await session.contextStatus("a".repeat(n)))?.estimate ?? 0;
  while ((await at(hi)) < target) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await at(mid)) >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe.skipIf(!sandboxAvailable())("ChatSession compaction", { timeout: 60_000 }, () => {
  test("the automatic trigger fires before a send at the limit, fed by real usage numbers", async () => {
    const plain = new TokenEstimator();
    const p = model({
      chat: [text("noted"), text("ok"), text("fine")],
      compact: [
        ops(
          userAdd("constraint", "keep the public API stable", "m0", "keep the public API stable"),
        ),
      ],
      // The model reports 1.5x the chars/4 estimate: the estimator learns the ratio.
      usage: (req) => Math.round(plain.estimate(req.system, req.messages, req.tools) * 1.5),
    });
    const { deps: d } = deps({ limit: 12_000 });
    const { session, events, store, repo } = await setup(p, d);
    await session.send("keep the public API stable");
    expect(d.estimator.ratio).toBeCloseTo(1.5, 1);
    const n = await lengthAt(session, 12_000);
    // Just below the limit: no compaction.
    await session.send("a".repeat(n - 1));
    expect(p.compactions).toHaveLength(0);
    expect(phases(events)).toEqual([]);
    const status = await session.contextStatus("next");
    expect(status?.estimate).toBeGreaterThanOrEqual(12_000);
    expect(status?.limit).toMatchObject({ limit: 12_000, reason: "override" });
    await session.send("next");
    expect(p.compactions).toHaveLength(1);
    expect(phases(events)).toEqual(["start", "done"]);
    const done = events.find((e) => e.type === "compaction" && e.phase === "done");
    expect(done).toMatchObject({
      messages: 4,
      counts: { decisions: 0, constraints: 1, open: 0, preferences: 0, notes: 0 },
      rejected: 0,
      reasons: [],
    });
    if (done?.type !== "compaction" || done.phase !== "done") throw new Error("no done");
    expect(done.after).toBeLessThan(done.before);
    // The compaction ran before the turn: the turn's request starts with the record.
    const req = p.chats[2] as ChatRequest;
    expect(req.messages[0]?.role).toBe("user");
    expect(
      req.messages[0]?.content.startsWith(`${RECORD_PREFACE}\n\n<untrusted_session_record id=`),
    ).toBe(true);
    expect(req.messages[0]?.content).toContain("keep the public API stable");
    // The newest earlier user message was over the retained budget: it is cut, not dropped.
    expect(req.messages[1]?.role).toBe("user");
    expect(req.messages[1]?.content).toContain("characters omitted by compaction");
    expect(req.messages.slice(2).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "ok"],
      ["user", "next"],
    ]);
    // The stored history keeps everything; the file has the compaction line.
    expect(session.history()).toHaveLength(6);
    const loaded = await store.loadSession(session.id() as string);
    expect(loaded.compactions).toHaveLength(1);
    expect(loaded.compactions[0]?.since).toBe("m4");
    expect(readFileSync(sessionFile(repo, session.id() as string), "utf8")).toContain(
      '"type":"compaction"',
    );
  });

  test("compact(focus) compacts now, passing the focus; nothing new is a failure without a model call", async () => {
    const p = model({
      chat: [text("one"), text("two")],
      compact: [ops({ op: "add", kind: "decision", text: "use postgres", source: "inferred" })],
    });
    const { deps: d } = deps();
    const { session, events } = await setup(p, d);
    await session.send("first");
    await session.send("second");
    const out = await session.compact("the database choice");
    expect(out).toMatchObject({ ok: true, counts: { decisions: 1 } });
    expect(p.compactions).toHaveLength(1);
    expect(p.compactions[0]?.messages[0]?.content).toContain("the database choice");
    expect(phases(events)).toEqual(["start", "done"]);
    const again = await session.compact();
    expect(again).toMatchObject({ ok: false, code: "compaction_invalid" });
    expect(p.compactions).toHaveLength(1);
    expect(session.record().items.map((i) => i.text)).toEqual(["use postgres"]);
  });

  test("a window too big for the model is compacted in consecutive parts", async () => {
    const turns = 8;
    const p = model({
      // Long replies to short questions: the largest part that fits often ends after a question.
      chat: Array.from({ length: turns }, (_, k) => text(`reply ${k} ${"y".repeat(1900)}`)),
      compact: Array.from({ length: 10 }, () => ops()),
    });
    // Window 8192: the compaction prompt may take min(limit, 0.85·W − 4000) = 2963 tokens.
    const { deps: d } = deps({
      window: { window: 8192, source: "model", provisional: true },
      limit: 100_000,
      recentUserTokens: 1000,
    });
    const { session, store } = await setup(p, d);
    for (let k = 0; k < turns; k++) await session.send(`turn ${k} ${"x".repeat(200)}`);
    const out = await session.compact();
    expect(out.ok).toBe(true);
    expect(p.compactions.length).toBeGreaterThan(1);
    // Each part's window starts where the previous one ended, and together they cover all.
    const firstIds = p.compactions.map(
      (r) => /\[(m\d+) /.exec(r.messages[0]?.content.split("untrusted_messages")[1] ?? "")?.[1],
    );
    expect(firstIds[0]).toBe("m0");
    const loaded = await store.loadSession(session.id() as string);
    expect(loaded.compactions).toHaveLength(p.compactions.length);
    expect(loaded.compactions.map((c) => c.since).slice(0, -1)).toEqual(firstIds.slice(1));
    expect(loaded.compactions.at(-1)?.since).toBe(`m${turns * 2}`);
    // Parts end before a user message, and each record feeds the next.
    for (const id of firstIds) expect(session.history()[Number(id?.slice(1))]?.role).toBe("user");
    expect(loaded.compactions.map((c) => c.record.compactions)).toEqual(
      loaded.compactions.map((_, k) => k + 1),
    );
  });

  test("a failed middle part stops the sequence; applied parts stay; the window ends there", async () => {
    const turns = 8;
    const p = model({
      chat: [...Array.from({ length: turns }, (_, k) => text(`reply ${k}`)), text("still here")],
      compact: [
        ops({ op: "add", kind: "note", text: "part one", source: "inferred" }),
        "not json",
        "still not json",
      ],
    });
    const { deps: d } = deps({
      window: { window: 8192, source: "model", provisional: true },
      limit: 100_000,
      recentUserTokens: 1000,
    });
    const { session, store, events } = await setup(p, d);
    for (let k = 0; k < turns; k++) await session.send(`turn ${k} ${"x".repeat(1200)}`);
    const out = await session.compact();
    expect(out).toMatchObject({ ok: false, code: "compaction_invalid" });
    if (out.ok) throw new Error("ok");
    expect(out.reason).toMatch(/after 1 part\(s\) applied/);
    expect(phases(events)).toEqual(["start", "failed"]);
    expect(p.compactions).toHaveLength(3); // part 1, part 2 and its one retry
    const loaded = await store.loadSession(session.id() as string);
    expect(loaded.compactions).toHaveLength(1);
    const since = loaded.compactions[0]?.since as string;
    expect(Number(since.slice(1))).toBeLessThan(turns * 2);
    expect(session.record().items.map((i) => i.text)).toEqual(["part one"]);
    // Nothing is lost: everything after the kept message is still verbatim in the context.
    const ctx = session.context();
    const kept = loaded.compactions[0]?.retainedFrom as string;
    expect(ctx.slice(1)).toEqual(session.history().slice(Number(kept.slice(1))));
    expect(Number(kept.slice(1))).toBeLessThan(Number(since.slice(1)));
    // The session is usable, and the next compaction starts at the stored window end.
    await session.send("more");
    expect(p.chats.at(-1)?.messages[0]?.content.startsWith(RECORD_PREFACE)).toBe(true);
  });

  test("review focus 4: resume after two compactions gives byte-identical context, and recall finds a pre-compaction detail", async () => {
    const DETAIL = "the flaky test is tests/net/retry.spec.ts line 88";
    const p = model({
      chat: [text("a1"), text("a2"), text("a3"), text("a4"), text("a5")],
      compact: [
        ops(
          userAdd(
            "preference",
            "answer in short bullet points",
            "m2",
            "answer in short bullet points",
          ),
        ),
        ops({ op: "add", kind: "note", text: "looked at retries", source: "inferred" }),
      ],
    });
    const { deps: d } = deps({ recentUserTokens: 1000 });
    const { session, store, repo } = await setup(p, d);
    await session.send(`remember: ${DETAIL}`);
    await session.send("answer in short bullet points");
    await session.send(`padding ${"p".repeat(6000)}`);
    expect((await session.compact()).ok).toBe(true);
    await session.send("what about retries?");
    expect((await session.compact()).ok).toBe(true);
    const ctx = session.context();
    // The detail is no longer in the model-visible context.
    expect(JSON.stringify(ctx)).not.toContain("retry.spec.ts");
    expect((await store.loadSession(session.id() as string)).compactions).toHaveLength(2);

    const fresh = new SessionStore();
    await fresh.list(repo);
    const r = model({
      chat: [
        { toolCalls: [{ id: "", name: "recall", arguments: { query: "FLAKY test" } }] },
        text("found it"),
      ],
    });
    const { deps: d2 } = deps({ recentUserTokens: 1000 });
    const { session: resumed } = await setup(r, d2, {
      repo,
      store: fresh,
      sessionId: session.id() as string,
    });
    expect(JSON.stringify(resumed.context())).toBe(JSON.stringify(ctx));
    expect(resumed.record()).toEqual(session.record());
    await resumed.send("where was the flaky test?");
    const req = r.chats[0] as ChatRequest;
    expect(JSON.stringify(req.messages)).toBe(
      JSON.stringify([...ctx, { role: "user", content: "where was the flaky test?" }]),
    );
    const result = r.chats[1]?.messages.at(-1);
    expect(result?.role).toBe("tool");
    expect(result?.content).toContain("<untrusted_recall id=");
    expect(result?.content).toContain(
      "[m0 user] remember: the flaky test is tests/net/retry.spec.ts",
    );
  });

  test("a failed compaction keeps the session usable and the file loadable; automatic retries wait for 25% growth", async () => {
    const p = model({
      chat: Array.from({ length: 6 }, (_, k) => text(`r${k}`)),
      compact: ["nope", "nope again", "nope", "nope", ops()],
    });
    const { deps: d } = deps({ limit: 6000 });
    const { session, store, events } = await setup(p, d);
    await session.send("hello");
    const n = await lengthAt(session, 6000);
    await session.send("b".repeat(n)); // at the limit: tries, fails (2 calls)
    expect(phases(events)).toEqual(["start", "failed"]);
    const failed = events.find((e) => e.type === "compaction" && e.phase === "failed");
    expect(failed).toMatchObject({ code: "compaction_invalid" });
    expect(p.compactions).toHaveLength(2);
    // The turn still ran, on the raw messages.
    expect(session.context()).toEqual(session.history());
    expect(session.history()).toHaveLength(4);
    const loaded = await store.loadSession(session.id() as string);
    expect(loaded.compactions).toEqual([]);
    expect(loaded.messages).toHaveLength(4);
    // Still over the limit, but under 125% of the failed attempt's estimate: no new attempt.
    await session.send("small");
    expect(p.compactions).toHaveLength(2);
    // /compact always tries (and fails again: 2 more calls).
    expect((await session.compact()).ok).toBe(false);
    expect(p.compactions).toHaveLength(4);
    // Growth past 125% of that estimate lets the automatic trigger try again.
    const status = await session.contextStatus();
    const grow = await lengthAt(session, Math.ceil((status?.estimate ?? 0) * 1.25) + 10);
    await session.send("c".repeat(grow));
    expect(p.compactions).toHaveLength(5);
    expect(phases(events).at(-1)).toBe("done");
  });

  test("an unavailable verifier fails the compaction (compaction_rejected) and changes nothing", async () => {
    const p = model({
      chat: [text("ok")],
      compact: [ops(userAdd("constraint", "never touch main", "m0", "never touch main"))],
    });
    const { deps: d } = deps({
      verifier: async () => {
        throw new Error("verifier down");
      },
    });
    const { session, store, events } = await setup(p, d);
    await session.send("never touch main");
    const out = await session.compact();
    expect(out).toMatchObject({ ok: false, code: "compaction_rejected" });
    if (out.ok) throw new Error("ok");
    expect(out.reason).toMatch(/verifier unavailable/);
    expect(events.at(-1)).toMatchObject({ type: "compaction", phase: "failed" });
    expect((await store.loadSession(session.id() as string)).compactions).toEqual([]);
    expect(session.record()).toEqual(emptyRecord());
  });

  test("runAgent accepts the compacted history, tool calls in the kept tail included", async () => {
    const p = model({
      chat: [
        text("first"),
        { toolCalls: [{ id: "", name: "find", arguments: { pattern: "*.ts" } }] },
        text("found a.ts"),
      ],
      compact: [ops()],
    });
    const { deps: d } = deps();
    const { session } = await setup(p, d);
    await session.send("hi");
    await session.send("find ts files");
    expect((await session.compact()).ok).toBe(true);
    const ctx = session.context();
    expect(ctx[0]?.role).toBe("user");
    expect(ctx.some((m) => (m.toolCalls?.length ?? 0) > 0)).toBe(true);
    const res = await runAgent({
      provider: new FauxProvider([text("fine")]),
      model: "m",
      system: "s",
      prompt: "go on",
      history: ctx,
      tools: [],
      maxTurns: 2,
      emit: () => {},
      runId: "r",
      stage: "chat",
    });
    expect(res.endedBy).not.toBe("error");
    expect(res.messages.slice(0, ctx.length)).toEqual(ctx);
  });

  test("record.pending is persisted and restored on resume", async () => {
    const p = model({
      chat: [text("ok")],
      compact: [ops(userAdd("constraint", "ship on fridays only", "m0", "ship on fridays only"))],
    });
    const { deps: d } = deps({
      verifier: async (o) => o.map(() => ({ accept: false, reason: "not what the user said" })),
    });
    const { session, repo, events } = await setup(p, d);
    await session.send("ship on fridays only");
    const out = await session.compact();
    expect(out).toMatchObject({ ok: true, rejected: 1 });
    if (!out.ok) throw new Error("failed");
    expect(out.reasons[0]).toMatch(/not what the user said/);
    expect(events.at(-1)).toMatchObject({ phase: "done", rejected: 1 });
    expect(session.record().pending).toEqual([{ messageId: "m0", compactionsLeft: 3 }]);
    const fresh = new SessionStore();
    await fresh.list(repo);
    expect(
      (await fresh.loadSession(session.id() as string)).compactions[0]?.record.pending,
    ).toEqual([{ messageId: "m0", compactionsLeft: 3 }]);
    const { session: resumed } = await setup(model({ chat: [] }), deps().deps, {
      repo,
      store: fresh,
      sessionId: session.id() as string,
    });
    expect(resumed.record().pending).toEqual([{ messageId: "m0", compactionsLeft: 3 }]);
  });

  test("the archive is capped at 500 entries, oldest dropped; recall still finds a dropped one on disk", async () => {
    const repo = makeRepo();
    const store = new SessionStore();
    const id = await store.create(repo);
    await store.append(id, [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
    ]);
    const archived = (k: number): RecordItem => ({
      id: `i${k}`,
      kind: "note",
      text: `old note ${k}${k === 0 ? " about the zebra migration" : ""}`,
      source: "inferred",
      status: "resolved",
      createdAt: "m0",
      updatedAt: "m0",
    });
    const record = {
      ...emptyRecord(),
      compactions: 1,
      archive: Array.from({ length: ARCHIVE_MAX }, (_, k) => archived(k)),
      items: [
        {
          id: `i${ARCHIVE_MAX}`,
          kind: "note" as const,
          text: "the open note",
          source: "inferred" as const,
          status: "active" as const,
          createdAt: "m0",
          updatedAt: "m0",
        },
      ],
    };
    await store.appendCompaction(id, {
      at: new Date().toISOString(),
      record,
      since: "m2",
      retainedFrom: "m0",
      recordMessage: "Session record: (test)",
    });
    const p = model({
      chat: [text("done")],
      compact: [
        ops({
          op: "resolve",
          itemId: `i${ARCHIVE_MAX}`,
          evidence: [{ messageId: "m2", quote: "the open note is finished" }],
        }),
      ],
    });
    const { session } = await setup(p, deps().deps, { repo, store, sessionId: id });
    await session.send("the open note is finished");
    expect((await session.compact()).ok).toBe(true);
    const archive = session.record().archive;
    expect(archive).toHaveLength(ARCHIVE_MAX);
    expect(archive[0]?.id).toBe("i1");
    expect(archive.at(-1)?.id).toBe(`i${ARCHIVE_MAX}`);
    // The full history stays on disk: the earlier compaction line still has i0.
    const loaded = await store.loadSession(id);
    expect(loaded.compactions[0]?.record.archive[0]?.text).toContain("zebra");
  });

  test("the first call of a session, and a call far slower than the measured speed, are not prefill samples; the window is refreshed after the first turn and after a reload", async () => {
    const delays = [400, 400, 400];
    const inputs = [40_000, 40_000, 4_000];
    let k = 0;
    const p: Provider = {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const i = k++;
        await new Promise((r) => setTimeout(r, delays[i] ?? 0));
        req.onFirstChunk?.();
        req.onDelta?.("x");
        return {
          message: { text: "x", toolCalls: [] },
          stopReason: "end",
          usage: { inputTokens: inputs[i] ?? 0, outputTokens: 1 },
        };
      },
    };
    const W64: ContextWindow = { window: 65536, source: "loaded", provisional: false };
    const { deps: d, refreshed } = deps({ window: W64 });
    d.window = W32;
    const { session } = await setup(p, d);
    await session.send("one"); // first call: a load, never a sample
    expect(session.prefill()).toBeUndefined();
    expect(refreshed).toHaveLength(1);
    expect((await session.contextStatus())?.window).toEqual(W64);
    await session.send("two"); // 40,000 tokens in ~400 ms: ~100,000 tok/s
    expect(session.prefill()?.samples).toBe(1);
    expect(refreshed).toHaveLength(1);
    // 4,000 tokens should take ~40 ms; 400 ms is over 5x: a reload, not a sample.
    await session.send("three");
    expect(session.prefill()?.samples).toBe(1);
    expect(refreshed).toHaveLength(2);
  });

  test("compactionDeps wires the verifier from routing, with independence and the window", async () => {
    const routing = resolveRouting([{ provider: "faux", model: "chat" }]);
    const asked: string[] = [];
    const built = await compactionDeps({
      routing,
      providers: (ref) => {
        asked.push(`${ref.provider}:${ref.model}`);
        return new FauxProvider([]);
      },
      config: defaultCompactionConfig(),
      estimator: new TokenEstimator(),
      windowOptions: { fauxWindow: 16_384 },
    });
    expect(asked).toEqual([`${routing.verifier.provider}:${routing.verifier.model}`]);
    expect(built.window).toMatchObject({ window: 16_384 });
    expect(built.independence).toBe(routing.independence);
    expect((built.verifier as VerifyRisky & { independent: boolean }).independent).toBe(false);
  });
});
