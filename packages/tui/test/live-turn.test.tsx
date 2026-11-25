// Force Ink's colour output on (before ink/chalk load) so the SGR assertions are not vacuous.
// Restored in afterAll; vitest isolates each test file in its own module graph.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  return previous;
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";
import type { ChatRequest, ChatResponse, Provider } from "@rewire/providers";
import { sandboxAvailable } from "@rewire/sandbox";
import {
  type ChatEvent,
  ChatSession,
  type ChatTurn,
  type RunController,
  type RunHandle,
  SessionStore,
} from "@rewire/session";
import { createSkillSet, disposeSkillSet, makeWritable, type SkillSet } from "@rewire/skills";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { App, type InterruptTarget } from "../src/app.js";
import { applyEvent, liveEntries, newLive } from "../src/live-turn.js";
import { formatTokens, SPINNER_GLYPHS, SPINNER_VERBS, Spinner } from "../src/spinner.js";
import { ToolLine } from "../src/transcript.js";

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

const ESC = "\x1b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");

/** The SGR allow-list of markdown.test.tsx: only Ink's own foreground/style parameters. */
const ALLOWED_SGR = new Set([
  0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 39, 90, 91, 92, 93, 94,
  95, 96, 97,
]);
function expectOnlySgr(f: string): void {
  for (const m of f.matchAll(SGR)) {
    const params = m[0].slice(2, -1).split(";").filter(Boolean).map(Number);
    for (const p of params) expect(ALLOWED_SGR.has(p), `SGR ${m[0].slice(1)}`).toBe(true);
  }
  expect(f.replace(SGR, "")).not.toContain("\x1b");
  expect(f).not.toContain("\x9b");
  expect(f).not.toContain("\x07");
}

type View = ReturnType<typeof render>;

/** Polls until the current frame (colour stripped) satisfies `ok`; fails with it on timeout. */
async function waitFor(v: View, ok: (frame: string) => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const f = plain(v.lastFrame());
    if (ok(f)) return f;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last frame:\n${f}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const waitText = (v: View, needle: string, ms?: number) =>
  waitFor(v, (f) => f.includes(needle), JSON.stringify(needle), ms);

/** Polls a plain condition. */
async function until(ok: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Types `text`, then presses Enter once the text is echoed (Ink subscribes keys in an effect). */
async function send(v: View, text: string) {
  v.stdin.write(text);
  await waitText(v, `> ${text}`);
  v.stdin.write("\r");
}

/** Presses Esc until `done()` (a lone ESC is held briefly by Ink's key parser). */
async function pressEsc(v: View, done: () => boolean) {
  const end = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > end) throw new Error("Esc was not handled");
    v.stdin.write("\x1b");
    const retry = Date.now() + 300;
    while (!done() && Date.now() < retry) await new Promise((r) => setTimeout(r, 10));
  }
}

function setColumns(stdout: unknown, n: number) {
  Object.defineProperty(stdout, "columns", { value: n, writable: true, configurable: true });
}

/**
 * A chat session whose `send` hands control to `turn`; `emit` reaches the App's listener, like
 * ChatSession's `emit` option does.
 */
function mount(
  turn: (text: string, signal: AbortSignal, emit: (e: ChatEvent) => void) => Promise<ChatTurn>,
  extra: { history?: { role: "user" | "assistant"; content: string }[]; run?: RunHandle } = {},
) {
  let listener: (e: ChatEvent) => void = () => {};
  const emit = (e: ChatEvent) => listener(e);
  const signals: AbortSignal[] = [];
  let target: InterruptTarget | undefined;
  const session = {
    history: () => extra.history ?? [],
    dispose: async () => {},
    send: (text: string, signal: AbortSignal) => {
      signals.push(signal);
      return turn(text, signal, emit);
    },
  } as unknown as ChatSession;
  const app = (run: RunHandle | undefined) => (
    <App
      session={session}
      runController={{} as RunController}
      config={{}}
      {...(run ? { run } : {})}
      subscribe={(l) => {
        listener = l;
        return () => {};
      }}
      bindInterrupt={(t) => {
        target = t;
      }}
    />
  );
  const v = render(app(extra.run));
  /** Hands a run in from the parent, as the CLI may while the App is mounted. */
  const handRun = (run: RunHandle) => v.rerender(app(run));
  return { v, emit, signals, target: () => target, handRun };
}

/** A turn that never settles until aborted (then rejects like ChatSession does). */
const hold =
  (onStart?: (emit: (e: ChatEvent) => void) => void) =>
  (_t: string, signal: AbortSignal, emit: (e: ChatEvent) => void): Promise<ChatTurn> =>
    new Promise<ChatTurn>((_res, rej) => {
      onStart?.(emit);
      signal.addEventListener("abort", () =>
        rej(new RewireError("aborted", "the chat turn was aborted")),
      );
    });

const views: View[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.unmount();
  vi.useRealTimers();
});
const track = <T extends { v: View }>(m: T): T => {
  views.push(m.v);
  return m;
};

describe("Spinner", () => {
  it("formats token counts past 999 as k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_678)).toBe("45.7k");
  });

  it("shows the verb, the elapsed seconds and the token count, cycles its glyph, and leaves no timer", async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const startedAt = Date.now();
    const v = render(<Spinner verb="Pondering" startedAt={startedAt} tokens={0} />);
    const f0 = plain(v.lastFrame());
    expect(f0).toContain("Pondering… (0s · esc to interrupt)");
    expect(f0).not.toContain("tokens"); // omitted while 0
    const glyph0 = f0.trim().charAt(0);
    expect(SPINNER_GLYPHS).toContain(glyph0);
    // Ink throttles its own output, so give it a few glyph ticks.
    await vi.advanceTimersByTimeAsync(3 * 120);
    const glyph1 = plain(v.lastFrame()).trim().charAt(0);
    expect(SPINNER_GLYPHS).toContain(glyph1);
    expect(glyph1).not.toBe(glyph0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(plain(v.lastFrame())).toContain("Pondering… (12s · esc to interrupt)");
    v.rerender(<Spinner verb="Pondering" startedAt={startedAt} tokens={1234} />);
    await vi.advanceTimersByTimeAsync(120);
    expect(plain(v.lastFrame())).toContain("Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)");
    v.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("the verb list is fixed", () => {
    expect(SPINNER_VERBS).toEqual([
      "Thinking",
      "Pondering",
      "Working",
      "Reading",
      "Reasoning",
      "Composing",
    ]);
  });
});

describe("live turn", () => {
  it("streams deltas as Markdown above a spinner with the token count, then moves them to the transcript", async () => {
    let finish: (t: ChatTurn) => void = () => {};
    const m = track(
      mount(
        (_t, _s, emit) =>
          new Promise<ChatTurn>((res) => {
            finish = res;
            emit({ type: "assistant_delta", text: "Here is **bo" });
            emit({ type: "assistant_delta", text: "ld** text" });
            emit({ type: "usage", inputTokens: 10, outputTokens: 1000 });
            emit({ type: "usage", inputTokens: 10, outputTokens: 234 });
          }),
      ),
    );
    await send(m.v, "q");
    const live = await waitText(m.v, "Here is bold text");
    expect(live).not.toContain("**");
    expect(live).toMatch(/[·✢✳✶✻✽] \w+… \(\d+s · ↓ 1\.2k tokens · esc to interrupt\)/);
    const verb = /([A-Z][a-z]+)… \(/.exec(live)?.[1];
    expect(SPINNER_VERBS).toContain(verb);
    finish({ text: "Here is **bold** text" });
    const done = await waitFor(m.v, (f) => !f.includes("esc to interrupt)"), "the turn to end");
    // Streamed text is not repeated by the turn's final text.
    expect(done.split("Here is bold text")).toHaveLength(2);
    expect(done).not.toContain("**");
    // The session stays usable.
    expect(done).toContain("> ");
  });

  it("renders a split OSC 52 sequence inert and redacts a key split across deltas (Review Focus 1)", async () => {
    const tail = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"; // 40 chars
    let finish: (t: ChatTurn) => void = () => {};
    const m = track(
      mount(
        (_t, _s, emit) =>
          new Promise<ChatTurn>((res) => {
            finish = res;
            emit({ type: "assistant_delta", text: "\x1b]5" });
            emit({ type: "assistant_delta", text: "2;c;eHg=\x07ok then sk-ant-api03-" });
            emit({ type: "assistant_delta", text: `${tail} done` });
          }),
      ),
    );
    await send(m.v, "q");
    const live = await waitText(m.v, "done");
    expect(live).toContain("ok then");
    expect(live).toContain("[redacted]");
    expect(live).not.toContain(tail.slice(0, 10));
    expect(live).not.toContain("eHg=");
    for (const f of m.v.frames) expectOnlySgr(f);
    finish({ text: "" });
    const done = await waitFor(m.v, (f) => !f.includes("esc to interrupt)"), "the turn to end");
    expect(done).toContain("[redacted]");
    expect(done).not.toContain(tail.slice(0, 10));
    expect(done).not.toContain("eHg=");
    for (const f of m.v.frames) expectOnlySgr(f);
  });

  it("renders tool lines with a bold name, ⎿ previews and … +N lines, red on error", async () => {
    let finish: (t: ChatTurn) => void = () => {};
    const m = track(
      mount(
        (_t, _s, emit) =>
          new Promise<ChatTurn>((res) => {
            finish = res;
            emit({ type: "assistant_delta", text: "Let me look." });
            emit({
              type: "tool_call",
              callId: "c1",
              tool: "read",
              summary: "read src/x.ts",
              isError: false,
            });
            emit({
              type: "tool_result",
              callId: "c1",
              tool: "read",
              preview: ["line one", "line two", "line three", "line four"],
              more: 7,
              isError: false,
            });
            emit({
              type: "tool_call",
              callId: "c2",
              tool: "bash",
              summary: "bash false",
              isError: true,
            });
            emit({
              type: "tool_result",
              callId: "c2",
              tool: "bash",
              preview: ["exit 1"],
              more: 0,
              isError: true,
            });
            emit({ type: "assistant_delta", text: "Found it." });
          }),
      ),
    );
    await send(m.v, "q");
    const live = await waitText(m.v, "Found it.");
    const order = ["Let me look.", "● Read(src/x.ts)", "⎿  line one", "line four", "… +7 lines"];
    const at = order.map((s) => live.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(live).toContain("✗ Bash(false)");
    expect(live.indexOf("Found it.")).toBeGreaterThan(live.indexOf("✗ Bash(false)"));
    // The tool name is bold and the error line red.
    const raw = m.v.lastFrame() ?? "";
    expect(raw).toMatch(new RegExp(`${ESC}\\[1mRead`));
    expect(raw).toMatch(new RegExp(`${ESC}\\[31m✗`));
    finish({ text: "Found it." });
    const done = await waitFor(m.v, (f) => !f.includes("esc to interrupt)"), "the turn to end");
    for (const s of [...order, "✗ Bash(false)", "⎿  exit 1", "Found it."]) {
      expect(done).toContain(s);
    }
    expect(done.split("Found it.")).toHaveLength(2);
  });

  it("Esc mid-stream aborts the turn, stops the stream, keeps the partial text and stays usable (Review Focus 3)", async () => {
    let afterAbort = 0;
    let stopped = false;
    const persisted: string[] = [];
    const m = track(
      mount((text, signal, emit) => {
        if (text !== "first") {
          persisted.push(text);
          return Promise.resolve({ text: "second reply" });
        }
        // A fake provider stream: a delta every 10 ms until the turn's signal aborts it.
        return new Promise<ChatTurn>((_res, rej) => {
          emit({ type: "assistant_delta", text: "partial **answer**" });
          const t = setInterval(() => {
            if (signal.aborted) afterAbort++;
            emit({ type: "assistant_delta", text: "." });
          }, 10);
          signal.addEventListener("abort", () => {
            clearInterval(t);
            stopped = true;
            rej(new RewireError("aborted", "the chat turn was aborted"));
          });
        });
      }),
    );
    await send(m.v, "first");
    await waitText(m.v, "partial answer");
    await waitText(m.v, "esc to interrupt)");
    await pressEsc(m.v, () => m.signals[0]?.aborted === true);
    expect(stopped).toBe(true);
    const f = await waitText(m.v, "⎿ Interrupted by user");
    expect(f).toContain("partial answer");
    expect(f).not.toContain("esc to interrupt)");
    expect(f).not.toContain("aborted"); // no error line for a user interrupt
    expect(f.indexOf("partial answer")).toBeLessThan(f.indexOf("Interrupted by user"));
    await new Promise((r) => setTimeout(r, 60));
    expect(afterAbort).toBe(0);
    expect(persisted).toEqual([]);
    expect(m.target()?.activity()).toBe("idle");
    await send(m.v, "second");
    await waitText(m.v, "second reply");
    expect(persisted).toEqual(["second"]);
    expect(m.signals[1]?.aborted).toBe(false);
  });

  it("a Ctrl-C abortTurn renders the same Interrupted line", async () => {
    const m = track(
      mount(hold((emit) => emit({ type: "assistant_delta", text: "half a thought" }))),
    );
    await send(m.v, "q");
    await waitText(m.v, "half a thought");
    m.target()?.abortTurn();
    const f = await waitText(m.v, "⎿ Interrupted by user");
    expect(f).toContain("half a thought");
    expect(f).not.toContain("aborted");
  });

  it("Esc while a gated run is active aborts neither the run nor the chat turn", async () => {
    let aborted = 0;
    const run = {
      events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      pending: () => undefined,
      answer: () => false,
      abort: () => {
        aborted++;
      },
      done: new Promise(() => {}),
    } as unknown as RunHandle;
    // A chat turn is live (so the Esc listener is mounted), then a run is handed in: Esc must
    // now be inert. Without the `interruptible` gating it would abort the turn's signal.
    const m = track(mount(hold((emit) => emit({ type: "assistant_delta", text: "streaming" }))));
    await send(m.v, "q");
    await waitText(m.v, "esc to interrupt)");
    m.handRun(run);
    await until(() => m.target()?.activity() === "run", "the run");
    for (let i = 0; i < 3; i++) {
      m.v.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(aborted).toBe(0);
    expect(m.signals[0]?.aborted).toBe(false);
    expect(m.target()?.activity()).toBe("run");
    expect(plain(m.v.lastFrame())).not.toContain("Interrupted");
  });

  it("starts a new paragraph for each model call, even with no tool between them", async () => {
    let finish: (t: ChatTurn) => void = () => {};
    const m = track(
      mount(
        (_t, _s, emit) =>
          new Promise<ChatTurn>((res) => {
            finish = res;
            emit({ type: "assistant_delta", text: "Let me check." });
            emit({ type: "usage", inputTokens: 5, outputTokens: 4 });
            emit({ type: "assistant_delta", text: "The answer." });
          }),
      ),
    );
    await send(m.v, "q");
    const live = await waitText(m.v, "The answer.");
    expect(live).not.toContain("check.The");
    expect(live).toContain("Let me check.");
    finish({ text: "The answer." });
    const done = await waitFor(m.v, (f) => !f.includes("esc to interrupt)"), "the turn to end");
    expect(done).not.toContain("check.The");
    expect(done).toContain("Let me check.");
    expect(done.split("The answer.")).toHaveLength(2);
  });

  it("estimates tokens from streamed text until usage reports the real count", async () => {
    let emitNow: (e: ChatEvent) => void = () => {};
    const m = track(
      mount(
        hold((emit) => {
          emitNow = emit;
          emit({ type: "assistant_delta", text: "x".repeat(400) });
        }),
      ),
    );
    await send(m.v, "q");
    await waitText(m.v, "↓ ~100 tokens");
    emitNow({ type: "usage", inputTokens: 1, outputTokens: 1234 });
    const f = await waitText(m.v, "↓ 1.2k tokens");
    expect(f).not.toContain("↓ ~");
    emitNow({ type: "assistant_delta", text: "y".repeat(400) });
    await waitText(m.v, "↓ ~1.3k tokens");
  });

  it("stores cleaned (sanitized, redacted) text in transcript entries", () => {
    let s = newLive("Thinking", 0);
    for (const text of [
      "a\x1b]5",
      "2;c;eHg=\x07b sk-ant-api03-",
      "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ]) {
      s = applyEvent(s, { type: "assistant_delta", text });
    }
    const [entry] = liveEntries(s);
    expect(entry?.kind).toBe("assistant");
    const text = entry?.kind === "assistant" ? entry.text : "";
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("eHg=");
    expect(text).not.toContain("abcdefghij");
  });

  it("ToolLine shows at most 4 preview lines and counts the rest", () => {
    const v = render(
      <ToolLine
        summary="read a.ts"
        isError={false}
        preview={["l1", "l2", "l3", "l4", "l5", "l6"]}
        more={2}
      />,
    );
    const f = plain(v.lastFrame());
    v.unmount();
    expect(f).toContain("l4");
    expect(f).not.toContain("l5");
    expect(f).toContain("… +4 lines");
  });

  it("an error mid-turn keeps the streamed text and tool lines, then the error line", async () => {
    const m = track(
      mount(async (_t, _s, emit) => {
        emit({ type: "assistant_delta", text: "trying" });
        emit({
          type: "tool_call",
          callId: "a",
          tool: "read",
          summary: "read a.ts",
          isError: false,
        });
        await new Promise((r) => setTimeout(r, 80));
        throw new RewireError("loop_provider_error", "boom");
      }),
    );
    await send(m.v, "q");
    const f = await waitText(m.v, "loop_provider_error: boom");
    expect(f.indexOf("trying")).toBeLessThan(f.indexOf("● Read(a.ts)"));
    expect(f.indexOf("● Read(a.ts)")).toBeLessThan(f.indexOf("loop_provider_error"));
    expect(f).not.toContain("Interrupted");
  });

  it("replays resumed assistant history as Markdown", async () => {
    const m = track(
      mount(hold(), {
        history: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "# Title\n\nsome **bold** and `code`" },
        ],
      }),
    );
    const f = await waitText(m.v, "some bold and code");
    expect(f).toContain("> hi");
    expect(f).toContain("Title");
    expect(f).not.toContain("**");
    expect(f).not.toContain("# Title");
  });

  it("fits 40 columns while live and after, and survives resizes", async () => {
    const long = "src/very/long/path/".repeat(10);
    let finish: (t: ChatTurn) => void = () => {};
    const m = track(
      mount(
        (_t, _s, emit) =>
          new Promise<ChatTurn>((res) => {
            finish = res;
            emit({
              type: "tool_call",
              callId: "c1",
              tool: "read",
              summary: `read ${long}`,
              isError: false,
            });
            emit({
              type: "tool_result",
              callId: "c1",
              tool: "read",
              preview: [long, `\t${long}`],
              more: 123,
              isError: false,
            });
            emit({ type: "assistant_delta", text: `${"word ".repeat(40)}\n\n\`\`\`ts\n${long}` });
            emit({ type: "usage", inputTokens: 1, outputTokens: 123_456 });
          }),
      ),
    );
    setColumns(m.v.stdout, 40);
    m.v.stdout.emit("resize");
    await send(m.v, "q");
    await waitText(m.v, "↓ 123.5k tokens");
    // The welcome header was printed (through <Static>) at the width before the resize, and is
    // never re-flowed: check what follows its bottom border.
    const afterHeader = (f: string) => {
      const i = f.indexOf("╰");
      return i < 0 ? f : f.slice(f.indexOf("\n", i) + 1);
    };
    const fits = (f: string) => {
      for (const line of afterHeader(plain(f)).split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(40);
      }
    };
    const live = m.v.lastFrame() ?? "";
    fits(live);
    expect(plain(live)).toContain("…");
    for (const n of [5, 1, 0, 200, 40]) {
      setColumns(m.v.stdout, n);
      expect(() => m.v.stdout.emit("resize")).not.toThrow();
      await new Promise((r) => setTimeout(r, 30));
    }
    fits(m.v.lastFrame() ?? "");
    finish({ text: "" });
    const done = await waitFor(m.v, (f) => !f.includes("esc to interrupt)"), "the turn to end");
    fits(done);
  });
});

// Review Focus 3 against the real ChatSession and SessionStore: the provider's stream stops on
// Esc, nothing of the interrupted turn is persisted, and the next turn is.
const dirs: string[] = [];
const sets: SkillSet[] = [];
afterAll(async () => {
  for (const s of sets) await disposeSkillSet(s).catch(() => {});
  for (const d of dirs) await makeWritable(d).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

class StreamingProvider implements Provider {
  calls = 0;
  stopped = false;
  deltasAfterAbort = 0;
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    if (this.calls === 1) {
      return new Promise<ChatResponse>((_res, rej) => {
        req.onDelta?.("partial reply");
        const t = setInterval(() => {
          if (req.signal?.aborted) this.deltasAfterAbort++;
          req.onDelta?.(".");
        }, 10);
        req.signal?.addEventListener("abort", () => {
          clearInterval(t);
          this.stopped = true;
          rej(new RewireError("provider_aborted", "the request was aborted"));
        });
      });
    }
    req.onDelta?.("second ");
    req.onDelta?.("answer");
    return {
      message: { text: "second answer", toolCalls: [] },
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
  }
}

describe.skipIf(!sandboxAvailable())("live turn with a real ChatSession", () => {
  it("Esc stops the provider stream and persists nothing; the next send is stored", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tui-live-")));
    dirs.push(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tui-live-skills-")));
    dirs.push(base);
    const skills = createSkillSet([], {
      home: join(base, "home"),
      xdgConfig: join(base, "config"),
      cacheDir: join(base, "cache"),
    });
    sets.push(skills);
    const listeners = new Set<(e: ChatEvent) => void>();
    const provider = new StreamingProvider();
    const session = new ChatSession({
      repo,
      model: { provider: "faux", model: "chat" },
      provider,
      policy: DEFAULT_POLICY,
      skills,
      store: new SessionStore(),
      emit: (e) => {
        for (const l of listeners) l(e);
      },
    });
    const v = render(
      <App
        session={session}
        runController={{} as RunController}
        config={{ repo }}
        subscribe={(l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        }}
      />,
    );
    views.push(v);
    try {
      await send(v, "first");
      await waitText(v, "partial reply", 30_000);
      await pressEsc(v, () => provider.stopped);
      const f = await waitText(v, "⎿ Interrupted by user");
      expect(f).toContain("partial reply");
      await new Promise((r) => setTimeout(r, 60));
      expect(provider.deltasAfterAbort).toBe(0);
      expect(session.history()).toEqual([]);
      const dir = join(repo, ".rewire", "sessions");
      const stored = () =>
        (() => {
          try {
            return readdirSync(dir);
          } catch {
            return [];
          }
        })()
          .map((n) => readFileSync(join(dir, n), "utf8"))
          .join("");
      expect(stored()).not.toContain("first");
      await send(v, "second");
      await waitText(v, "second answer", 30_000);
      await until(() => stored().includes("second answer"), "the second turn to be stored");
      expect(stored()).not.toContain("first");
      expect(stored()).not.toContain("partial reply");
      expect(session.history().map((h) => h.content)).toEqual(["second", "second answer"]);
    } finally {
      await session.dispose();
    }
  }, 60_000);
});
