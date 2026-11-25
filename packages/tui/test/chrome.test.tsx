// Task 5: the welcome header, the bordered input box, the status line and the `?` shortcuts panel.
import type { RunEvent } from "@rewire/core";
import type {
  ChatEvent,
  ChatSession,
  ChatTurn,
  PendingPrompt,
  RunController,
  RunHandle,
} from "@rewire/session";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import { App, type AppProps } from "../src/app.js";
import { Header, type HeaderInfo, shortPath } from "../src/header.js";
import { StatusLine, statusText } from "../src/status-line.js";

type View = ReturnType<typeof render>;
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");
const maxWidth = (f: string | undefined): number =>
  Math.max(
    0,
    ...plain(f)
      .split("\n")
      .map((l) => stringWidth(l)),
  );

async function waitFor(v: View, ok: (frame: string) => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const f = plain(v.lastFrame());
    if (ok(f)) return f;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last frame:\n${f}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const waitText = (v: View, needle: string) =>
  waitFor(v, (f) => f.includes(needle), JSON.stringify(needle));

function setColumns(stdout: unknown, n: number) {
  Object.defineProperty(stdout, "columns", { value: n, writable: true, configurable: true });
}

const views: View[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.unmount();
});
const track = (v: View): View => {
  views.push(v);
  return v;
};

const MODELS = {
  chat: "claude-chat",
  spec: "claude-spec",
  implementer: "qwen-impl",
  reviewers: ["gpt-review", "gpt-verify"],
};

function session(
  send: (t: string, s: AbortSignal) => Promise<ChatTurn> = async () => ({ text: "ok" }),
) {
  return {
    send,
    history: () => [],
    dispose: async () => {},
  } as unknown as ChatSession;
}

function mountApp(props: Partial<AppProps> = {}) {
  let listener: (e: ChatEvent) => void = () => {};
  const app = (extra: Partial<AppProps> = {}) => (
    <App
      session={session()}
      runController={{} as RunController}
      config={{}}
      cwd="/home/dev/projects/demo"
      home="/home/dev"
      models={MODELS}
      subscribe={(l) => {
        listener = l;
        return () => {};
      }}
      {...props}
      {...extra}
    />
  );
  const v = track(render(app()));
  return {
    v,
    emit: (e: ChatEvent) => listener(e),
    rerender: (x: Partial<AppProps>) => v.rerender(app(x)),
  };
}

/** A run that yields `events`, then waits; `pending` is read on every poll. */
function fakeRun(events: RunEvent[], pending: () => PendingPrompt | undefined) {
  let finish: (o: unknown) => void = () => {};
  const done = new Promise<unknown>((r) => {
    finish = r;
  });
  const run = {
    events: {
      [Symbol.asyncIterator]: async function* () {
        yield* events;
        await done;
      },
    },
    pending,
    answer: () => true,
    abort: () => {},
    done,
  } as unknown as RunHandle;
  return { run, finish };
}

const evt = (e: Record<string, unknown>): RunEvent =>
  ({ ts: "2026-01-01T00:00:00.000Z", runId: "r1", ...e }) as unknown as RunEvent;

describe("header", () => {
  it("shows the welcome line, the cwd with ~ and the models", async () => {
    const { v } = mountApp({
      skills: {
        found: [],
        active: [{} as never, {} as never],
        pendingRepo: [{} as never],
        repo: "/r",
        trustFile: "/t",
      },
    });
    const f = await waitText(v, "Welcome to rewire");
    expect(f).toContain("✻ Welcome to rewire");
    expect(f).toContain("cwd: ~/projects/demo");
    expect(f).toContain("chat: claude-chat");
    expect(f).toContain("run: spec claude-spec · impl qwen-impl · review gpt-review, gpt-verify");
    expect(f).toContain("skills: 2 active · 1 pending trust");
    expect(f).toContain("/help for commands");
    expect(f).toContain("╭");
  });

  it("omits the skills line when there are none", async () => {
    const { v } = mountApp();
    const f = await waitText(v, "Welcome to rewire");
    expect(f).not.toContain("skills:");
  });

  it("is printed again after /clear", async () => {
    const created = session();
    const { v } = mountApp({
      sessions: {
        create: async () => created,
        resume: async () => created,
        list: async () => [],
      },
    });
    await waitText(v, "Welcome to rewire");
    v.stdin.write("/clear");
    await waitText(v, "> /clear");
    v.stdin.write("\r");
    // The new <Static> region starts with the separator, then the header again.
    const f = await waitFor(
      v,
      (x) => x.includes("new session") && x.indexOf("new session") < x.lastIndexOf("Welcome"),
      "the header after the separator",
    );
    expect(f.slice(f.indexOf("new session"))).toContain("cwd: ~/projects/demo");
  });

  it("substitutes ~ only for the home directory itself or a path under it", () => {
    expect(shortPath("/home/dev", "/home/dev")).toBe("~");
    expect(shortPath("/home/dev/x", "/home/dev")).toBe("~/x");
    expect(shortPath("/home/developer", "/home/dev")).toBe("/home/developer");
    expect(shortPath("/srv/x", undefined)).toBe("/srv/x");
  });

  it("cuts a long cwd from the left so the repo name stays visible", async () => {
    const info: HeaderInfo = {
      cwd: `/home/dev/${"deep/".repeat(20)}projects/rewire`,
      home: "/home/dev",
    };
    const v = track(render(<Header info={info} />));
    setColumns(v.stdout, 40);
    v.stdout.emit("resize");
    const f = await waitFor(v, (x) => maxWidth(x) <= 40, "the header to fit 40 columns");
    expect(f).toMatch(/cwd: …\/[\w/]*projects\/rewire/);
  });

  it("fits in 40 columns and sanitizes config values", async () => {
    const info: HeaderInfo = {
      cwd: `/home/dev/${"very-long-directory/".repeat(8)}`,
      home: "/home/dev",
      models: {
        chat: `evil\x1b]52;c;aGk=\x07${"m".repeat(80)}`,
        spec: "s".repeat(50),
        implementer: "i".repeat(50),
        reviewers: ["r".repeat(50)],
      },
      skills: { active: 3, pending: 2 },
    };
    const v = track(render(<Header info={info} />));
    setColumns(v.stdout, 40);
    v.stdout.emit("resize");
    await waitFor(v, (f) => maxWidth(f) <= 40, "the header to fit 40 columns");
    const raw = v.lastFrame() ?? "";
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x07");
    expect(maxWidth(raw)).toBeLessThanOrEqual(40);
    expect(plain(raw)).toContain("Welcome to rewire");
  });
});

describe("status line", () => {
  it("fits 40 columns, dropping the shortcuts hint, then checkpoints, then the context size", () => {
    const parts = {
      model: "claude-chat",
      context: 12_345,
      checkpoints: "contract,tests",
      mode: "chat",
    };
    const wide = statusText(parts, 120);
    expect(wide).toMatch(
      /^claude-chat · ctx 12\.3k · checkpoints: contract,tests · chat +\? for shortcuts$/,
    );
    expect(stringWidth(wide)).toBe(120);
    const mid = statusText(parts, 70);
    expect(mid).toBe("claude-chat · ctx 12.3k · checkpoints: contract,tests · chat");
    expect(statusText(parts, 40)).toBe("claude-chat · ctx 12.3k · chat");
    expect(statusText({ ...parts, context: undefined }, 60)).toBe(
      "claude-chat · checkpoints: contract,tests · chat",
    );
    expect(statusText(parts, 25)).toBe("claude-chat · chat");
    expect(stringWidth(statusText(parts, 10))).toBeLessThanOrEqual(10);
    expect(statusText(parts, 0)).toBe("");
  });

  it("renders within 40 columns", () => {
    const el = (
      <StatusLine model={"x".repeat(60)} context={1} checkpoints="contract,tests" mode="chat" />
    );
    const v = track(render(el));
    setColumns(v.stdout, 40);
    v.stdout.emit("resize");
    v.rerender(el);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    expect(plain(v.lastFrame())).toContain("· chat");
  });

  it("goes chat -> thinking -> run: implement -> checkpoint: contract, and shows the last call's context size", async () => {
    let release: (t: ChatTurn) => void = () => {};
    const s = session(
      () =>
        new Promise<ChatTurn>((r) => {
          release = r;
        }),
    );
    const m = mountApp({ session: s });
    const v = m.v;
    await waitText(v, "· chat");
    expect(plain(v.lastFrame())).toContain("claude-chat · checkpoints: contract,tests · chat");
    v.stdin.write("hi");
    await waitText(v, "> hi");
    v.stdin.write("\r");
    await waitText(v, "· thinking");
    m.emit({ type: "usage", inputTokens: 1000, outputTokens: 500 });
    m.emit({ type: "usage", inputTokens: 2000, outputTokens: 300 });
    release({ text: "done" });
    await waitText(v, "ctx 2.3k"); // the last call, not a sum
    await waitText(v, "· chat");

    let pending: PendingPrompt | undefined;
    const { run, finish } = fakeRun(
      [
        evt({ type: "stage_start", stage: "spec" }),
        evt({ type: "stage_end", stage: "spec", ok: true }),
        evt({ type: "stage_start", stage: "implementer" }),
      ],
      () => pending,
    );
    m.rerender({ session: s, run });
    await waitText(v, "· run: implement");
    pending = {
      kind: "checkpoint",
      checkpoint: {
        kind: "contract",
        contract: {
          id: "C-1",
          title: "t",
          criteria: [],
          nonGoals: [],
          affectedAreas: [],
          openQuestions: [],
        },
      },
    } as unknown as PendingPrompt;
    await waitText(v, "· checkpoint: contract");
    finish({ status: "verified", runId: "r1", branch: "b", reportPath: "/r" });
    await waitText(v, "· chat");
  });

  it("shows checkpoints: off when none are set", async () => {
    const { v } = mountApp({ checkpoints: new Set() });
    await waitText(v, "checkpoints: off");
  });
});

describe("input box and shortcuts", () => {
  it("shows a bordered prompt with a placeholder while empty", async () => {
    const { v } = mountApp();
    const f = await waitText(v, "Ask about the code, or /run a task");
    expect(f).toMatch(/│ > Ask about the code, or \/run a task/);
    v.stdin.write("ab");
    const g = await waitText(v, "> ab");
    expect(g).not.toContain("Ask about the code, or /run a task");
  });

  it("grows with multi-line input", async () => {
    const { v } = mountApp();
    await waitText(v, "Ask about the code");
    v.stdin.write("one\\");
    await waitText(v, "> one\\");
    v.stdin.write("\r");
    v.stdin.write("two");
    const f = await waitText(v, "two");
    const lines = f.split("\n");
    const i = lines.findIndex((l) => l.includes("> one"));
    expect(lines[i + 1]).toMatch(/│ {3}two/);
  });

  it("? on an empty input toggles the shortcuts panel; any other key closes it", async () => {
    const { v } = mountApp();
    await waitText(v, "Ask about the code");
    v.stdin.write("?");
    const f = await waitText(v, "Shift+Enter");
    expect(f).toContain("↑/↓");
    expect(f).toContain("Ctrl-C");
    expect(f).toContain("@");
    expect(f).toContain("Ask about the code"); // the ? was not typed
    v.stdin.write("?");
    await waitFor(v, (x) => !x.includes("Shift+Enter"), "the panel to close");
    v.stdin.write("?");
    await waitText(v, "Shift+Enter");
    v.stdin.write("x");
    const g = await waitFor(v, (x) => !x.includes("Shift+Enter"), "the panel to close");
    expect(g).toContain("> x");
  });

  it("? is typed as a clarification answer", async () => {
    let pending: PendingPrompt | undefined = { kind: "clarify", questions: ["Which file?"] };
    const answers: unknown[] = [];
    const { run } = fakeRun([], () => pending);
    (run as unknown as { answer: (p: unknown, v: unknown) => boolean }).answer = (_p, a) => {
      answers.push(a);
      pending = undefined;
      return true;
    };
    const { v } = mountApp({ run });
    await waitText(v, "Which file?");
    v.stdin.write("?");
    const f = await waitText(v, "> ?");
    expect(f).not.toContain("Shift+Enter");
  });

  it("the shortcuts panel does not come back after the input was disabled", async () => {
    const m = mountApp();
    const v = m.v;
    await waitText(v, "Ask about the code");
    v.stdin.write("?");
    await waitText(v, "Shift+Enter");
    // A run hands in a checkpoint: the input is hidden and deaf while the panel owns the keys.
    let pending: PendingPrompt | undefined = {
      kind: "checkpoint",
      checkpoint: {
        kind: "contract",
        contract: {
          id: "C-1",
          title: "t",
          criteria: [],
          nonGoals: [],
          affectedAreas: [],
          openQuestions: [],
        },
      },
    } as unknown as PendingPrompt;
    const { run, finish } = fakeRun([], () => pending);
    m.rerender({ run });
    await waitText(v, "· checkpoint: contract");
    expect(plain(v.lastFrame())).not.toContain("Shift+Enter");
    pending = undefined;
    finish({ status: "verified", runId: "r1", branch: "b", reportPath: "/r" });
    const f = await waitText(v, "Ask about the code");
    expect(f).not.toContain("Shift+Enter");
  });

  it("? in non-empty input is typed", async () => {
    const { v } = mountApp();
    await waitText(v, "Ask about the code");
    v.stdin.write("why");
    await waitText(v, "> why");
    v.stdin.write("?");
    const f = await waitText(v, "> why?");
    expect(f).not.toContain("Shift+Enter");
  });
});
