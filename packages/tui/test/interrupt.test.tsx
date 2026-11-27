import { EventEmitter } from "node:events";
import type { ChatSession, ChatTurn, RunController, RunHandle } from "@rewire/session";
import type { Skill } from "@rewire/skills";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App, type InterruptTarget } from "../src/app.js";
import { renderTrustPrompt, renderTui } from "../src/index.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(15);
  }
}

/** Streams for Ink whose stdin can be typed into (Ink reads on 'readable'). */
function streams() {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: false,
    write: (s: string) => {
      frames.push(s);
      return true;
    },
  });
  const queue: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    resume: () => stdin,
    pause: () => stdin,
    read: () => queue.shift() ?? null,
  });
  const type = (s: string) => {
    queue.push(s);
    stdin.emit("readable");
  };
  return {
    opts: { stdout, stdin } as never as { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream },
    type,
    frames,
  };
}

function session(send: (t: string, signal?: AbortSignal) => Promise<ChatTurn>) {
  return {
    history: () => [],
    send,
    dispose: async () => {},
  } as unknown as ChatSession;
}

describe("App interrupt target", () => {
  it("reports idle, then a turn in flight that abortTurn aborts through send's signal", async () => {
    let target: InterruptTarget | undefined;
    let signal: AbortSignal | undefined;
    const s = session(
      (_t, sig) =>
        new Promise<ChatTurn>((_res, rej) => {
          signal = sig;
          sig?.addEventListener("abort", () => rej(new Error("the chat turn was aborted")));
        }),
    );
    const v = render(
      <App
        session={s}
        runController={{} as RunController}
        config={{}}
        bindInterrupt={(t) => {
          target = t;
        }}
      />,
    );
    await tick();
    expect(target?.activity()).toBe("idle");
    v.stdin.write("hi");
    await tick();
    v.stdin.write("\r");
    await tick(80);
    expect(target?.activity()).toBe("turn");
    expect(v.lastFrame()).toContain("esc to interrupt)");
    target?.abortTurn();
    await tick(80);
    expect(signal?.aborted).toBe(true);
    expect(target?.activity()).toBe("idle");
    expect(v.lastFrame()).not.toContain("esc to interrupt)");
    expect(v.lastFrame()).toContain("Interrupted by user");
    v.unmount();
  });

  it("reports a run and aborts it", async () => {
    let target: InterruptTarget | undefined;
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
    const v = render(
      <App
        session={session(async () => ({ text: "" }))}
        runController={{} as RunController}
        config={{}}
        run={run}
        bindInterrupt={(t) => {
          target = t;
        }}
      />,
    );
    await tick();
    expect(target?.activity()).toBe("run");
    expect(target?.run()).toBe(run);
    target?.abortRun();
    expect(aborted).toBe(1);
    v.unmount();
  });

  it("re-reads a skills getter on /skills", async () => {
    let name = "first";
    const info = (name: string) => ({
      found: [{ name, source: "user" } as Skill],
      active: [{ name, source: "user" } as Skill],
      pendingRepo: [],
      repo: "/r",
      trustFile: "/t",
    });
    const v = render(
      <App
        session={session(async () => ({ text: "" }))}
        runController={{} as RunController}
        config={{}}
        skills={() => info(name)}
      />,
    );
    await tick();
    for (const next of ["first", "second"]) {
      name = next;
      v.stdin.write("/skills");
      await tick();
      v.stdin.write("\r");
      await until(() => (v.lastFrame() ?? "").includes(`${next}  user · active`));
      // Esc closes the list (retried: the list's key handler attaches after its first frame).
      for (let i = 0; i < 10 && (v.lastFrame() ?? "").includes("user · active"); i++) {
        v.stdin.write("\x1b");
        await until(() => !(v.lastFrame() ?? "").includes("user · active"), 1500).catch(() => {});
      }
      expect(v.lastFrame()).not.toContain("user · active");
    }
    v.unmount();
  });
});

describe("renderTui Ctrl-C key", () => {
  it("turns the Ctrl-C key into onInterrupt, never into typed text", async () => {
    const s = streams();
    let presses = 0;
    const sent: string[] = [];
    let exit: (c: number) => void = () => {};
    const p = renderTui({
      session: session(async (t) => {
        sent.push(t);
        return { text: "" };
      }),
      runController: {} as RunController,
      config: {},
      onInterrupt: () => {
        presses++;
      },
      bindExit: (e) => {
        exit = e;
      },
      renderOptions: { ...s.opts, patchConsole: false },
    });
    await tick();
    s.type("\x03");
    await tick();
    expect(presses).toBe(1);
    s.type("\r"); // an empty line: nothing was inserted, so nothing is submitted
    await tick();
    expect(sent).toEqual([]);
    exit(0);
    expect(await p).toBe(0);
  });

  it("an exit during the first render (render error) rejects (M2) and still unmounts", async () => {
    const s = streams();
    const p = renderTui({
      session: {
        history: () => {
          throw new Error("boom");
        },
      } as unknown as ChatSession,
      runController: {} as RunController,
      config: {},
      onInterrupt: () => {},
      renderOptions: { ...s.opts, patchConsole: false },
    });
    await expect(p).rejects.toMatchObject({ code: "tui_render_failed" });
    await tick();
    // Unmounted: the key listener let go of stdin.
    expect((s.opts.stdin as unknown as EventEmitter).listenerCount("readable")).toBe(0);
  });
});

describe("renderTrustPrompt", () => {
  const found = [
    {
      name: "r1",
      description: "repo skill",
      source: "repo",
      dir: "/nonexistent",
      files: [],
      body: "",
      modelInvocable: true,
      sha256: "a".repeat(64),
    } as Skill,
  ];

  it("resolves false on n", async () => {
    const s = streams();
    const p = renderTrustPrompt({
      found,
      pendingRepo: found,
      repo: "/r",
      trustFile: "/t",
      renderOptions: { ...s.opts, patchConsole: false },
    });
    await tick();
    s.type("n");
    expect(await p).toBe(false);
  });

  it("resolves undefined when closed by exit (Ctrl-C), and reports the key", async () => {
    const s = streams();
    let exit: (c: number) => void = () => {};
    let presses = 0;
    const p = renderTrustPrompt({
      found,
      pendingRepo: found,
      repo: "/r",
      trustFile: "/t",
      onInterrupt: () => {
        presses++;
        exit(0);
      },
      bindExit: (e) => {
        exit = e;
      },
      renderOptions: { ...s.opts, patchConsole: false },
    });
    await tick();
    s.type("\x03");
    expect(await p).toBeUndefined();
    expect(presses).toBe(1);
  });

  it("rejects with tui_render_failed when the prompt throws while rendering", async () => {
    const s = streams();
    const bad = {
      ...found[0],
      get description(): string {
        throw new Error("bad description");
      },
    } as Skill;
    await expect(
      renderTrustPrompt({
        found: [bad],
        pendingRepo: [bad],
        repo: "/r",
        trustFile: "/t",
        renderOptions: { ...s.opts, patchConsole: false },
      }),
    ).rejects.toMatchObject({ code: "tui_render_failed" });
  });
});
