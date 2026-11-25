// I1: an in-flight turn taller than the terminal must not be re-printed into scrollback. Finished
// items (tool lines with their results, complete Markdown blocks) move to <Static> as they finish,
// and the live rest is capped to the terminal rows. Rendered with a TTY-like stdout and debug off,
// as in static.test.tsx (ink-testing-library forces debug mode, which repaints everything).
import { EventEmitter } from "node:events";
import { RewireError } from "@rewire/core";
import type { ChatEvent, ChatSession, ChatTurn } from "@rewire/session";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { LiveTurn, newLive } from "../src/live-turn.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

class TtyOut extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  write = (s: string) => {
    this.chunks.push(s);
    return true;
  };
}

class TtyIn extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  send(s: string) {
    this.data = s;
    this.emit("readable");
    this.emit("data", s);
  }
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
/** Ink's full-screen clear (cursor home, erase down): used only when a frame overflows. */
const HOME = "\x1b[1;1H";

type Turn = (text: string, signal: AbortSignal, emit: (e: ChatEvent) => void) => Promise<ChatTurn>;

const apps: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.unmount();
});

function mount(turn: Turn) {
  let listener: (e: ChatEvent) => void = () => {};
  const emit = (e: ChatEvent) => listener(e);
  const session = {
    history: () => [],
    dispose: async () => {},
    send: (text: string, signal: AbortSignal) => turn(text, signal, emit),
  } as unknown as ChatSession;
  const stdout = new TtyOut();
  const stdin = new TtyIn();
  const app = render(
    <App
      session={session}
      runController={{} as never}
      config={{}}
      subscribe={(l) => {
        listener = l;
        return () => {};
      }}
    />,
    {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new TtyOut() as never,
      debug: false,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  const out = () => stdout.chunks.join("");
  return { stdout, stdin, out };
}

async function send(m: ReturnType<typeof mount>, text: string) {
  for (const ch of text) {
    m.stdin.send(ch);
    await sleep(15);
  }
  await waitFor(() => m.out().includes(text), "the typed text");
  m.stdin.send("\r");
}

/**
 * 8 tool calls (each emitted with its result, as the session does), then a 60-paragraph reply.
 * Only the block still streaming is drawn live; the last one is closed by the caller's usage
 * event right after it arrives, so every marker is a finished block when it is first drawn.
 */
async function busyTurn(emit: (e: ChatEvent) => void) {
  for (let k = 0; k < 8; k++) {
    emit({
      type: "tool_call",
      callId: `c${k}`,
      tool: "read",
      summary: `read f${k}-tool-marker.ts`,
      isError: false,
    });
    emit({
      type: "tool_result",
      callId: `c${k}`,
      tool: "read",
      preview: [`prev-${k}-a`, `prev-${k}-b`, `prev-${k}-c`, `prev-${k}-d`],
      more: 3,
      isError: false,
    });
    await sleep(40); // spinner ticks and throttled flushes happen in between
  }
  // The reply streams in 6 chunks of 10 paragraphs. Each chunk ends with the start of the next
  // paragraph, so its complete paragraphs are finished blocks the moment they arrive.
  for (let j = 0; j < 6; j++) {
    const paras = Array.from({ length: 10 }, (_, i) => `reply-line-${j * 10 + i}-marker\n\n`);
    emit({
      type: "assistant_delta",
      text: `${j > 0 ? "y\n\n" : ""}${paras.join("")}${j < 5 ? "y" : ""}`,
    });
    if (j < 5) await sleep(140);
  }
}

describe("live turn in a real terminal frame (I1)", () => {
  it("writes each tool line and each reply line once in a 24-row terminal", async () => {
    const m = mount(async (_t, _s, emit) => {
      await busyTurn(emit);
      emit({ type: "usage", inputTokens: 10, outputTokens: 900 });
      return { text: "ignored: the reply streamed" };
    });
    await send(m, "go");
    await waitFor(() => m.out().includes("reply-line-59-marker"), "the end of the reply");
    await waitFor(
      () => m.out().slice(-300).includes("> Ask about"),
      "the turn to end (input back)",
    );
    await sleep(200); // let any (wrong) repaint land before counting
    const all = m.out();
    for (let k = 0; k < 8; k++) {
      expect(count(all, `f${k}-tool-marker.ts`), `tool ${k}`).toBe(1);
      expect(count(all, `prev-${k}-d`), `preview ${k}`).toBe(1);
    }
    for (let n = 0; n < 60; n++) expect(count(all, `reply-line-${n}-marker`), `line ${n}`).toBe(1);
    expect(all).not.toContain(HOME);
    // In order: the tools, then the reply.
    expect(all.indexOf("f7-tool-marker")).toBeLessThan(all.indexOf("reply-line-0-marker"));
    expect(all.indexOf("reply-line-0-marker")).toBeLessThan(all.indexOf("reply-line-59-marker"));
  }, 30_000);

  it("Esc after streamed blocks keeps them once, in order, then the Interrupted line", async () => {
    const m = mount(
      (_t, signal, emit) =>
        new Promise<ChatTurn>((_res, rej) => {
          signal.addEventListener("abort", () => rej(new RewireError("aborted", "aborted")));
          void busyTurn(emit);
        }),
    );
    await send(m, "go");
    await waitFor(() => m.out().includes("reply-line-29-marker"), "half the reply");
    await waitFor(() => {
      m.stdin.send("\x1b");
      return m.out().includes("Interrupted by user");
    }, "the interrupt");
    await sleep(800); // the fake keeps emitting; those late events must be dropped
    const all = m.out();
    for (let k = 0; k < 8; k++) expect(count(all, `f${k}-tool-marker.ts`), `tool ${k}`).toBe(1);
    for (let n = 0; n < 30; n++) expect(count(all, `reply-line-${n}-marker`), `line ${n}`).toBe(1);
    expect(all.indexOf("reply-line-29-marker")).toBeLessThan(all.indexOf("Interrupted by user"));
    // Late events after the interrupt are not printed (M4).
    expect(all).not.toContain("reply-line-59-marker");
    expect(all).not.toContain(HOME);
  }, 30_000);

  it("caps a block still streaming to the terminal height (no full-screen repaint)", async () => {
    let finish: (t: ChatTurn) => void = () => {};
    const m = mount(
      (_t, _s, emit) =>
        new Promise<ChatTurn>((res) => {
          finish = res;
          void (async () => {
            // One open code fence: a single block that cannot be split until it closes.
            emit({ type: "assistant_delta", text: "```ts\n" });
            for (let i = 0; i < 60; i++) {
              emit({ type: "assistant_delta", text: `const code${i} = ${i};\n` });
              await sleep(10);
            }
          })();
        }),
    );
    await send(m, "go");
    await waitFor(() => m.out().includes("code59"), "the whole block");
    await sleep(300);
    const live = m.out();
    expect(live).not.toContain(HOME);
    // The tail is what shows: the last line is on screen, the first scrolled out of the cap.
    const lastFrame = live.slice(live.lastIndexOf("code59") - 2000);
    expect(lastFrame).toContain("code59");
    finish({ text: "" });
    await waitFor(
      () => m.out().slice(-300).includes("> Ask about"),
      "the turn to end (input back)",
    );
    await sleep(200);
    expect(m.out()).not.toContain(HOME);
  }, 30_000);
});

describe("terminal size subscription (I2)", () => {
  it("keeps one resize listener for 20 mounted tool lines, with no listener-leak warning", async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    const stdout = new TtyOut();
    let state = newLive("Thinking", Date.now());
    state = {
      ...state,
      items: Array.from({ length: 20 }, (_, i) => ({
        kind: "tool" as const,
        callId: `c${i}`,
        summary: `read f${i}.ts`,
        isError: false,
      })),
    };
    const app = render(
      <LiveTurn state={state} onInterrupt={() => {}} interruptible={false} maxRows={500} />,
      {
        stdout: stdout as never,
        stdin: new TtyIn() as never,
        stderr: new TtyOut() as never,
        debug: false,
        // Ink defaults to non-interactive under CI (is-in-ci) and then writes only at exit.
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    try {
      await waitFor(() => stdout.chunks.join("").includes("f19.ts"), "the tool lines");
      expect(stdout.listenerCount("resize")).toBeLessThanOrEqual(2);
      stdout.columns = 40;
      stdout.emit("resize");
      await sleep(100);
      await new Promise((r) => setImmediate(r));
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      app.unmount();
      process.off("warning", onWarning);
    }
    expect(stdout.listenerCount("resize")).toBe(0);
  });
});
