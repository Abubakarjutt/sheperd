import { RewireError } from "@rewire/core";
import type { ChatEvent, ChatSession, ChatTurn, RunController } from "@rewire/session";
import { PROPOSAL_NOTE, TURN_LIMIT_NOTE } from "@rewire/session";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { Safe } from "../src/safe.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeSession(opts: {
  send?: (text: string) => Promise<ChatTurn>;
  history?: { role: "user" | "assistant" | "tool"; content: string }[];
}) {
  const sent: string[] = [];
  const session = {
    send: (text: string) => {
      sent.push(text);
      return (opts.send ?? (async () => ({ text: "ok" })))(text);
    },
    history: () => opts.history ?? [],
  } as unknown as ChatSession;
  return { session, sent };
}

function mount(session: ChatSession) {
  let emit: (e: ChatEvent) => void = () => {};
  const view = render(
    <App
      session={session}
      runController={{} as RunController}
      config={{}}
      subscribe={(l) => {
        emit = l;
        return () => {};
      }}
    />,
  );
  return { ...view, emit: (e: ChatEvent) => emit(e) };
}

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await tick();
};

describe("tui transcript", () => {
  it("typing hello and Enter sends it and shows the user line", async () => {
    const { session, sent } = fakeSession({ send: async () => ({ text: "hi there" }) });
    const { stdin, lastFrame } = mount(session);
    await tick();
    await type(stdin, "hello");
    await type(stdin, "\r");
    await tick();
    expect(sent).toEqual(["hello"]);
    expect(lastFrame()).toContain("> hello");
    expect(lastFrame()).toContain("hi there");
  });

  it("renders a tool-call event as a bullet line, and a red cross on error", async () => {
    const { session } = fakeSession({});
    const { emit, lastFrame } = mount(session);
    await tick();
    emit({ type: "tool_call", tool: "read", summary: "read src/math.ts", isError: false });
    emit({ type: "tool_call", tool: "bash", summary: "bash rm x", isError: true });
    await tick();
    expect(lastFrame()).toContain("● Read(src/math.ts)");
    expect(lastFrame()).toContain("✗ Bash(rm x)");
  });

  it("renders escape sequences in assistant text, tool summaries, errors and history inert", async () => {
    const evil = "a\x1b[31mred\x1b]52;c;ZXZpbA==\x07\x1b[2Jb\x1b";
    const { session } = fakeSession({
      send: async () => ({ text: `reply ${evil}` }),
      history: [{ role: "assistant", content: `old ${evil}` }],
    });
    const { stdin, emit, lastFrame } = mount(session);
    await tick();
    emit({ type: "tool_call", tool: "read", summary: `read ${evil}`, isError: false });
    await type(stdin, "q");
    await type(stdin, "\r");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("reply aredb");
    expect(frame).toContain("old aredb");
    expect(frame).toContain("Read(aredb)");
    // ink-testing-library frames carry no styling of their own, so no ESC byte may appear at all.
    expect(frame).not.toContain("\x1b");
    expect(frame).not.toContain("\x07");
    expect(frame).not.toContain("52;c;");
  });

  it("Safe keeps no ESC byte (SGR, C1 and OSC) and a bare Text would", async () => {
    const evil = "x\x1b[31mred\x1b[0m \u009b2J \u009d52;c;ZXZpbA==\u009c\x1b]52;c;ZXZpbA==\x07y";
    const safe = render(<Safe>{evil}</Safe>);
    expect(safe.lastFrame()).not.toContain("\x1b");
    expect(safe.lastFrame()).not.toContain("\u009b");
    expect(safe.lastFrame()).toContain("xred");
    const bare = render(<Text>{evil}</Text>);
    expect(bare.lastFrame()).toContain("\x1b"); // guards the check: Ink keeps SGR itself
  });

  it("redacts secrets in error text", async () => {
    const { session } = fakeSession({
      send: async () => {
        throw new Error("boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
      },
    });
    const { stdin, lastFrame } = mount(session);
    await tick();
    await type(stdin, "a");
    await type(stdin, "\r");
    await tick();
    expect(lastFrame()).toContain("boom");
    expect(lastFrame()).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("shows a send rejection as a red error line with its code and stays usable", async () => {
    let n = 0;
    const { session, sent } = fakeSession({
      send: async () => {
        if (n++ === 0) throw new RewireError("session_corrupt", "bad file\x1b[2J", "hint");
        return { text: "fine" };
      },
    });
    const { stdin, lastFrame } = mount(session);
    await tick();
    await type(stdin, "a");
    await type(stdin, "\r");
    await tick();
    expect(lastFrame()).toContain("session_corrupt: bad file");
    expect(lastFrame()).not.toContain("\x1b[2J");
    await type(stdin, "b");
    await type(stdin, "\r");
    await tick();
    expect(sent).toEqual(["a", "b"]);
    expect(lastFrame()).toContain("fine");
  });

  it("runs one send at a time: input is busy while a turn is in flight", async () => {
    let release: (t: ChatTurn) => void = () => {};
    const { session, sent } = fakeSession({
      send: () => new Promise<ChatTurn>((r) => (release = r)),
    });
    const { stdin, lastFrame } = mount(session);
    await tick();
    await type(stdin, "one");
    await type(stdin, "\r");
    expect(lastFrame()).toContain("esc to interrupt)");
    await type(stdin, "two");
    await type(stdin, "\r");
    expect(sent).toEqual(["one"]);
    release({ text: "done" });
    await tick();
    expect(lastFrame()).toContain("done");
    expect(lastFrame()).not.toContain("esc to interrupt)");
  });

  it("a trailing backslash plus Enter inserts a newline instead of sending", async () => {
    const { session, sent } = fakeSession({});
    const { stdin } = mount(session);
    await tick();
    await type(stdin, "a\\");
    await type(stdin, "\r");
    await type(stdin, "b");
    await type(stdin, "\r");
    expect(sent).toEqual(["a\nb"]);
  });

  it("hides persisted placeholder notes when replaying history", async () => {
    const { session } = fakeSession({
      history: [
        { role: "user", content: "do it" },
        { role: "assistant", content: PROPOSAL_NOTE },
        { role: "assistant", content: TURN_LIMIT_NOTE },
        { role: "tool", content: "tool out" },
        { role: "assistant", content: "real answer" },
      ],
    });
    const { lastFrame } = mount(session);
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("> do it");
    expect(f).toContain("real answer");
    expect(f).not.toContain("propose_run");
    expect(f).not.toContain("tool-call limit");
    expect(f).not.toContain("tool out");
  });
});
