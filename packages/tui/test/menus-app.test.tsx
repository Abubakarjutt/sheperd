// Task 6 (Review Focus 5): the `/` command menu and the `@` file picker inside the App's input.
import type {
  ChatSession,
  ChatTurn,
  PendingPrompt,
  RunController,
  RunHandle,
} from "@rewire/session";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "../src/app.js";
import { InputBox } from "../src/input.js";

type View = ReturnType<typeof render>;
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");
const ESC = "\x1b";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

async function waitFor(v: View, ok: (frame: string) => boolean, what: string, ms = 15_000) {
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
/** The text in the input box: what follows the `> ` prompt, up to the cursor. */
const inputText = (f: string): string | undefined => /> (.*?)▌/.exec(f)?.[1];
const waitInput = (v: View, text: string) =>
  waitFor(v, (f) => inputText(f) === text, `input ${JSON.stringify(text)}`);
/** The frame from the input box down: the box, the menu or picker, and the status line. */
const belowInput = (f: string): string => f.slice(f.lastIndexOf("╭"));
const settle = () => new Promise((r) => setTimeout(r, 60));

/** A run that never finishes on its own; `pending` is read on every poll. */
function fakeRun(pending: () => PendingPrompt | undefined = () => undefined) {
  let finish: (o: unknown) => void = () => {};
  const done = new Promise((r) => {
    finish = r;
  });
  const answer = vi.fn((_p: PendingPrompt, _v: unknown) => true);
  const run = {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true, value: undefined };
        },
      }),
    },
    pending,
    answer,
    abort: () => {},
    done,
  } as unknown as RunHandle;
  return { run, answer, finish };
}

const views: View[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.unmount();
});

function mount(props: Partial<AppProps> = {}) {
  const sent: string[] = [];
  const session = {
    send: async (t: string): Promise<ChatTurn> => {
      sent.push(t);
      return { text: "ok" };
    },
    history: () => [],
    dispose: async () => {},
  } as unknown as ChatSession;
  const listFiles = vi.fn(async () => [
    "src/math.ts",
    "src/format.ts",
    "test/math.test.ts",
    "my dir/a b.ts",
    "README.md",
  ]);
  const v = render(
    <App
      session={session}
      runController={{} as RunController}
      config={{}}
      cwd="/home/dev/demo"
      home="/home/dev"
      listFiles={listFiles}
      {...props}
    />,
  );
  views.push(v);
  return { v, sent, listFiles };
}

describe("/ command menu", () => {
  it("/ then ru then Tab completes to /run ; Esc closes it with nothing sent", async () => {
    const { v, sent } = mount();
    v.stdin.write("/");
    let f = await waitText(v, "start a gated run directly");
    expect(f).toContain("/clear");
    v.stdin.write("ru");
    f = await waitInput(v, "/ru");
    expect(f).not.toContain("/clear");
    v.stdin.write(TAB);
    f = await waitInput(v, "/run ");
    // A space ends the name: the menu is closed.
    expect(f).not.toContain("start a gated run directly");

    // Esc closes an open menu and keeps the text; nothing is sent.
    for (let i = 0; i < 5; i++) v.stdin.write("\x7f");
    v.stdin.write("/cl");
    await waitText(v, "start a fresh session");
    v.stdin.write(ESC);
    f = await waitFor(v, (x) => !x.includes("start a fresh session"), "menu closed");
    expect(inputText(f)).toBe("/cl");
    await settle();
    expect(sent).toEqual([]);
    expect(plain(v.lastFrame())).not.toContain("unknown command");
  });

  it("↑/↓ move the selection; Enter completes an incomplete name", async () => {
    const { v } = mount();
    v.stdin.write("/");
    await waitText(v, "❯ /run");
    v.stdin.write(DOWN);
    await waitText(v, "❯ /skills");
    v.stdin.write(UP);
    await waitText(v, "❯ /run");
    v.stdin.write(UP); // wraps to the last command
    await waitText(v, "❯ /exit");
    v.stdin.write(ESC);
    v.stdin.write("\x7f/he");
    await waitText(v, "❯ /help");
    v.stdin.write("\r");
    await waitInput(v, "/help");
  });

  it("Enter on a complete name with no arguments runs it", async () => {
    const { v, sent } = mount();
    v.stdin.write("/help");
    await waitText(v, "❯ /help");
    v.stdin.write("\r");
    await waitText(v, "start a gated run directly"); // the /help note
    await waitFor(v, (f) => !f.includes("❯"), "menu closed");
    expect(sent).toEqual([]);
  });

  it("↑ recalls history while the menu is closed", async () => {
    const { v, sent } = mount();
    v.stdin.write("hello");
    await waitInput(v, "hello");
    v.stdin.write("\r");
    await waitFor(v, () => sent.length === 1, "sent");
    await waitText(v, "ok");
    v.stdin.write(UP);
    await waitInput(v, "hello");
  });

  it("lists only the in-run commands while a run is active", async () => {
    let finish: (o: unknown) => void = () => {};
    const done = new Promise((r) => {
      finish = r;
    });
    const run = {
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await done;
            return { done: true, value: undefined };
          },
        }),
      },
      pending: () => undefined,
      answer: () => true,
      abort: () => {},
      done,
    } as unknown as RunHandle;
    const { v } = mount({ run });
    v.stdin.write("/");
    const f = belowInput(await waitText(v, "/skills"));
    for (const name of ["/checkpoints", "/model", "/skip", "/help"]) expect(f).toContain(name);
    for (const name of ["/run", "/clear", "/resume", "/doctor", "/exit"]) {
      expect(f).not.toContain(name);
    }
    finish({});
  });
});

describe("@ file picker", () => {
  it("@src/ma then Tab inserts @src/math.ts ", async () => {
    const { v, listFiles } = mount();
    v.stdin.write("look at @src/ma");
    const f = await waitText(v, "math.ts");
    expect(f).toContain("src/");
    expect(f).not.toContain("README.md");
    v.stdin.write(TAB);
    await waitInput(v, "look at @src/math.ts ");
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it("Enter inserts too, quoting a path with a space; Esc closes", async () => {
    const { v, sent } = mount();
    v.stdin.write("@ab");
    await waitText(v, "a b.ts");
    v.stdin.write("\r");
    await waitInput(v, '@"my dir/a b.ts" ');
    v.stdin.write("@READ");
    await waitText(v, "README.md");
    v.stdin.write(ESC);
    await waitFor(v, (f) => !f.includes("README.md"), "picker closed");
    expect(inputText(plain(v.lastFrame()))).toBe('@"my dir/a b.ts" @READ');
    await settle();
    expect(sent).toEqual([]);
  });

  it("a@b does not open the picker", async () => {
    const { v, sent } = mount({ listFiles: async () => ["b.ts", "src/b.ts"] });
    v.stdin.write("mail a@b");
    await waitInput(v, "mail a@b");
    await settle();
    expect(plain(v.lastFrame())).not.toContain("b.ts");
    v.stdin.write("\r");
    await waitFor(v, () => sent.length === 1, "sent");
    expect(sent).toEqual(["mail a@b"]);
  });

  it("lists the files once per session and again after /clear", async () => {
    const listFiles = vi.fn(async () => ["src/math.ts"]);
    const sessions = {
      create: async () =>
        ({
          send: async () => ({ text: "ok" }),
          history: () => [],
          dispose: async () => {},
        }) as unknown as ChatSession,
      resume: async () => {
        throw new Error("no");
      },
      list: async () => [],
    };
    const { v } = mount({ listFiles, sessions });
    v.stdin.write("@ma");
    await waitText(v, "math.ts");
    v.stdin.write(ESC);
    v.stdin.write(" @ma");
    await waitText(v, "math.ts");
    expect(listFiles).toHaveBeenCalledTimes(1);
    v.stdin.write(ESC);
    for (let i = 0; i < 8; i++) v.stdin.write("\x7f");
    await waitFor(v, (f) => inputText(f) === undefined, "input cleared");
    v.stdin.write("/clear");
    await waitText(v, "❯ /clear");
    v.stdin.write("\r");
    await waitText(v, "new session");
    v.stdin.write("@ma");
    await waitText(v, "math.ts");
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("fits the menu and the picker in 40 columns", async () => {
    const long = `${"very-long-directory-name/".repeat(4)}a-rather-long-file-name.ts`;
    const { v } = mount({ listFiles: async () => [long, "src/math.ts"] });
    Object.defineProperty(v.stdout, "columns", { value: 40, configurable: true });
    v.stdout.emit("resize");
    v.stdin.write("/");
    let f = belowInput(await waitText(v, "/checkpoints"));
    expect(f).toContain("❯ /run");
    for (const line of f.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40);
    v.stdin.write(ESC);
    v.stdin.write("\x7f@rather");
    f = belowInput(await waitText(v, "a-rather"));
    expect(f).toContain("…");
    for (const line of f.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("Esc priority", () => {
  it("reports an open popup (LiveTurn is then not interruptible) and Esc closes it first", async () => {
    const onPopup = vi.fn();
    const onSubmit = vi.fn();
    const v = render(
      <InputBox busy={false} onSubmit={onSubmit} onPopup={onPopup} files={["src/math.ts"]} />,
    );
    views.push(v);
    v.stdin.write("/");
    await waitFor(v, () => onPopup.mock.lastCall?.[0] === true, "menu open reported");
    v.stdin.write(ESC);
    await waitFor(v, () => onPopup.mock.lastCall?.[0] === false, "menu closed reported");
    v.stdin.write("\x7f@ma");
    await waitFor(v, () => onPopup.mock.lastCall?.[0] === true, "picker open reported");
    v.stdin.write(ESC);
    await waitFor(v, () => onPopup.mock.lastCall?.[0] === false, "picker closed reported");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("fix round 1", () => {
  it("a clarify answer never opens the menu or the picker: / and @ are typed and sent as is", async () => {
    const prompt: PendingPrompt = { kind: "clarify", questions: ["Which file?"] };
    const { run, answer, finish } = fakeRun(() => prompt);
    const { v, listFiles } = mount({ run });
    await waitText(v, "Which file?");
    v.stdin.write("/he");
    await waitInput(v, "/he");
    v.stdin.write(TAB);
    await settle();
    let f = belowInput(plain(v.lastFrame()));
    expect(inputText(f)).toBe("/he");
    expect(f).not.toContain("this list");
    for (let i = 0; i < 3; i++) v.stdin.write("\x7f");
    v.stdin.write("@RE");
    await waitInput(v, "@RE");
    v.stdin.write(TAB);
    await settle();
    f = belowInput(plain(v.lastFrame()));
    expect(inputText(f)).toBe("@RE");
    expect(f).not.toContain("README.md");
    expect(listFiles).not.toHaveBeenCalled();
    v.stdin.write("\r");
    await waitFor(v, () => answer.mock.calls.length === 1, "answered");
    expect(answer).toHaveBeenCalledWith(prompt, ["@RE"]);
    finish({});
  });

  it("↑/↓ keep browsing history through slash entries; an edit reopens the menu", async () => {
    const { v } = mount();
    for (const line of ["first", "/help", "/model"]) {
      v.stdin.write(line);
      await waitInput(v, line);
      v.stdin.write("\r");
      await waitFor(v, (f) => inputText(f) === undefined, `sent ${line}`);
    }
    v.stdin.write(UP);
    let f = await waitInput(v, "/model");
    expect(belowInput(f)).not.toContain("❯");
    v.stdin.write(UP);
    await waitInput(v, "/help");
    v.stdin.write(UP);
    await waitInput(v, "first");
    v.stdin.write(DOWN);
    f = await waitInput(v, "/help");
    expect(belowInput(f)).not.toContain("❯");
    v.stdin.write("\x7f"); // an edit: `/hel` opens the menu again
    await waitText(v, "❯ /help");
  });

  it("Enter on a partial name: a command with args gets the space; one without closes the menu", async () => {
    const { v, sent } = mount();
    v.stdin.write("/che");
    await waitText(v, "❯ /checkpoints");
    v.stdin.write("\r");
    await waitInput(v, "/checkpoints ");
    for (let i = 0; i < 13; i++) v.stdin.write("\x7f");
    v.stdin.write("/mo");
    await waitText(v, "❯ /model");
    v.stdin.write("\r");
    const f = await waitInput(v, "/model");
    expect(belowInput(f)).not.toContain("❯");
    v.stdin.write("\r");
    await waitText(v, "model routing is not available here");
    expect(sent).toEqual([]);
  });
});
