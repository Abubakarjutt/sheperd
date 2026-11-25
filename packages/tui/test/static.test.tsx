// I3: finished transcript entries are printed once through Ink's <Static>, so a transcript taller
// than the terminal is not rewritten (and duplicated into scrollback) on every keystroke. This
// renders with a TTY-like stdout and debug off (ink-testing-library forces debug mode, which
// repaints everything and so cannot see the difference).
import { EventEmitter } from "node:events";
import type { ChatSession } from "@rewire/session";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Polls until `ok()` holds (slow CI runners render late); fails the test at the deadline. */
async function waitFor(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(20);
  }
}

class TtyOut extends EventEmitter {
  isTTY = true;
  columns = 60;
  rows = 8;
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

function sessionWith(history: { role: "user" | "assistant"; content: string }[], reply = "ok") {
  return {
    send: async () => ({ text: reply }),
    history: () => history,
    dispose: async () => {},
  } as unknown as ChatSession;
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe("transcript in <Static> (I3)", () => {
  it("a transcript taller than the screen is written once, not on every keystroke", async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `line-${i}-marker`,
    }));
    const stdout = new TtyOut();
    const stdin = new TtyIn();
    const app = render(
      <App session={sessionWith(history)} runController={{} as never} config={{}} />,
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
    try {
      const out = () => stdout.chunks.join("");
      await waitFor(() => out().includes("line-29-marker"), "the transcript");
      for (const ch of "typing") {
        stdin.send(ch);
        await tick(30);
      }
      await waitFor(() => out().includes("typing"), "the typed text");
      await tick(100); // let any (wrong) full repaint land before counting
      const all = out();
      expect(all).toContain("typing");
      expect(count(all, "line-0-marker")).toBe(1);
      expect(count(all, "line-29-marker")).toBe(1);
    } finally {
      app.unmount();
    }
  });
});
