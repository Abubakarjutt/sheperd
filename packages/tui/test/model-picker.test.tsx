// Force Ink's colour output on (before ink/chalk load) so the red refusal is checkable.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  return previous;
});

import type {
  ChatSession,
  ChatTurn,
  ContextStatus,
  PendingPrompt,
  RunController,
  RunHandle,
} from "@rewire/session";
import { render } from "ink-testing-library";
import { useState } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "../src/app.js";
import { ListPicker, type ListPickerItem, moveSelection } from "../src/list-picker.js";
import type {
  RoutingControlDep,
  RoutingModel,
  RoutingPick,
  RoutingRole,
  RoutingSource,
  RoutingView,
} from "../src/routing.js";

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

const SGR = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type View = {
  lastFrame: () => string | undefined;
  stdin: { write: (s: string) => void };
};

/** Polls until the frame passes `ok`; fails with the last frame after `ms`. */
async function waitFor(v: View, ok: (f: string) => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok(plain(v.lastFrame()))) return;
    await tick(15);
  }
  throw new Error(`timed out waiting for ${what}; last frame:\n${plain(v.lastFrame())}`);
}
const waitText = (v: View, needle: string) => waitFor(v, (f) => f.includes(needle), needle);

/**
 * Presses `key` until `ok` holds. A panel's key handler attaches in an effect after its frame is
 * drawn, so a key sent at once can arrive before anything listens; a key that was handled shows
 * its effect well within one attempt, so a key is never pressed twice once it took effect.
 */
async function pressUntil(v: View, key: string, ok: (f: string) => boolean, what: string) {
  for (let i = 0; i < 10; i++) {
    v.stdin.write(key);
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if (ok(plain(v.lastFrame()))) return;
      await tick(15);
    }
  }
  await waitFor(v, ok, what);
}
const pressFor = (v: View, key: string, needle: string) =>
  pressUntil(v, key, (f) => f.includes(needle), needle);

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
/** The selected row: the marker, then the label. */
const selectedRow = (f: string): string =>
  f.split("\n").find((l) => l.trimStart().startsWith("❯")) ?? "";

/** Types a line and submits it once the input shows it. */
async function enter(v: View, text: string) {
  v.stdin.write(text);
  await waitText(v, text);
  await pressUntil(v, KEY.enter, (f) => !f.includes(`${text}▌`), `${text} submitted`);
}

function fakeSession(
  opts: { status?: ContextStatus; send?: (t: string) => Promise<ChatTurn> } = {},
) {
  const sent: string[] = [];
  const dispose = vi.fn(async () => {});
  const session = {
    send: (t: string) => {
      sent.push(t);
      return (opts.send ?? (async () => ({ text: "ok" })))(t);
    },
    history: () => [],
    id: () => "s1",
    dispose,
    ...(opts.status ? { contextStatus: async () => opts.status } : {}),
  } as unknown as ChatSession;
  return { session, sent, dispose };
}

const status = (limit: number): ContextStatus =>
  ({ estimate: 1_000, limit: { limit, reason: "window" } }) as unknown as ContextStatus;

const ref = (provider: string, model: string): RoutingModel => ({ provider, model });
const QWEN = ref("ollama", "qwen3:8b");
const LLAMA = ref("ollama", "llama3.1:8b");
const CLAUDE = ref("anthropic", "claude-sonnet");

/** A routingControl fake with mutable routing; `set` is scripted per test. */
function control(
  o: {
    available?: RoutingModel[];
    set?: (role: RoutingRole, r: RoutingModel | undefined) => RoutingPick | Promise<RoutingPick>;
  } = {},
) {
  const routing: RoutingView = {
    spec: QWEN,
    "test-writer": QWEN,
    implementer: QWEN,
    reviewer: LLAMA,
    verifier: LLAMA,
    independence: "cross-family",
  };
  const sources: Partial<Record<RoutingRole, RoutingSource>> = { reviewer: "file" };
  const calls: Array<[RoutingRole, RoutingModel | undefined]> = [];
  const dep: RoutingControlDep = {
    current: () => ({ ...routing }),
    available: () => o.available ?? [QWEN, LLAMA, CLAUDE],
    source: (role) => sources[role] ?? "auto",
    family: (r) => (r.model.startsWith("qwen") ? "qwen" : (r.model.split(/[-.:\d]/)[0] ?? "x")),
    set: (role, r) => {
      calls.push([role, r]);
      if (o.set) return o.set(role, r);
      if (r) {
        routing[role] = r;
        sources[role] = "session";
      }
      return { ok: true, routing: { ...routing }, note: `${role} is now ${r?.model ?? "default"}` };
    },
  };
  return { dep, routing, sources, calls };
}

function mount(props: Partial<AppProps> & { session: ChatSession }) {
  return render(<App runController={{} as RunController} config={{}} {...props} />);
}

/** Opens the picker with `/model` and waits for step 1. */
async function open(v: View, cmd = "/model") {
  await enter(v, cmd);
  await waitText(v, "Choose a role");
}

describe("moveSelection", () => {
  it("wraps both ways", () => {
    expect(moveSelection(5, 0, -1)).toBe(4);
    expect(moveSelection(5, 4, 1)).toBe(0);
    expect(moveSelection(5, 2, 1)).toBe(3);
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});

function Harness({
  items,
  start = 0,
  onSelect = () => {},
}: {
  items: ListPickerItem[];
  start?: number;
  onSelect?: (i: number) => void;
}) {
  const [sel, setSel] = useState(start);
  return (
    <ListPicker
      title="Pick one"
      items={items}
      selected={sel}
      onMove={setSel}
      onSelect={onSelect}
      onCancel={() => {}}
    />
  );
}

describe("ListPicker", () => {
  it("scrolls a long list so the selection stays visible", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ label: `item-${i}` }));
    const v = render(<Harness items={items} start={15} />);
    await waitText(v, "item-15");
    const f = plain(v.lastFrame());
    expect(selectedRow(f)).toContain("item-15");
    expect(f).not.toContain("item-0 ");
    expect(f).toContain("16/20");
    v.unmount();
  });

  it("sanitizes labels and details", async () => {
    const items = [{ label: "evil\x1b[2Jname", detail: "bell\x07 \x1b]52;c;aGk=\x07here" }];
    const v = render(<Harness items={items} />);
    await waitText(v, "evil");
    const raw = v.lastFrame() ?? "";
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x07");
    expect(raw).not.toContain("\x1b]52");
    v.unmount();
  });

  it("Enter on a disabled row does nothing; ↓ and j, ↑ and k move", async () => {
    const onSelect = vi.fn();
    const items = [{ label: "one", disabled: true }, { label: "two" }, { label: "three" }];
    const v = render(<Harness items={items} onSelect={onSelect} />);
    await waitText(v, "three");
    await pressUntil(v, "j", (f) => selectedRow(f).includes("two"), "j moves down");
    await pressUntil(v, "k", (f) => selectedRow(f).includes("one"), "k moves up");
    v.stdin.write(KEY.enter);
    await tick(100);
    expect(onSelect).not.toHaveBeenCalled();
    await pressUntil(v, KEY.up, (f) => selectedRow(f).includes("three"), "↑ wraps to the end");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("one"), "↓ wraps to the start");
    v.unmount();
  });
});

describe("/model picker", () => {
  it("/model and /models open step 1: each role, its model, family and source", async () => {
    const { session } = fakeSession();
    const { dep } = control();
    for (const cmd of ["/model", "/models"]) {
      const v = mount({ session, routingControl: dep });
      await open(v, cmd);
      const f = plain(v.lastFrame());
      expect(f).toMatch(/chat & spec\s+ollama:qwen3:8b · qwen · auto/);
      expect(f).toMatch(/test-writer\s+ollama:qwen3:8b · qwen · auto/);
      expect(f).toMatch(/implementer\s+ollama:qwen3:8b · qwen · auto/);
      expect(f).toMatch(/reviewer\s+ollama:llama3\.1:8b · llama · models\.toml/);
      expect(f).toMatch(/verifier\s+ollama:llama3\.1:8b · llama · auto/);
      expect(selectedRow(f)).toContain("chat & spec");
      v.unmount();
    }
  });

  it("step 2 lists default and the available models, the current one marked and selected", async () => {
    const { session } = fakeSession();
    const { dep } = control();
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressUntil(v, "j", (f) => selectedRow(f).includes("test-writer"), "j");
    await pressUntil(v, "j", (f) => selectedRow(f).includes("implementer"), "j");
    await pressUntil(v, "j", (f) => selectedRow(f).includes("reviewer"), "j");
    await pressFor(v, KEY.enter, "Model for reviewer");
    const f = plain(v.lastFrame());
    expect(f).toContain("default");
    expect(f).toMatch(/ollama:qwen3:8b\s+qwen/);
    expect(f).toMatch(/anthropic:claude-sonnet\s+claude/);
    expect(f).toMatch(/ollama:llama3\.1:8b\s+llama · current/);
    expect(selectedRow(f)).toContain("ollama:llama3.1:8b");
    expect(f).not.toContain("Choose a role");
    v.unmount();
  });

  it("Esc in step 2 returns to step 1 on the same role; Esc in step 1 closes", async () => {
    const { session } = fakeSession();
    const { dep, calls } = control();
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressUntil(v, KEY.up, (f) => selectedRow(f).includes("verifier"), "↑ wraps");
    await pressFor(v, KEY.enter, "Model for verifier");
    await pressFor(v, KEY.esc, "Choose a role");
    expect(selectedRow(plain(v.lastFrame()))).toContain("verifier");
    await pressUntil(v, KEY.esc, (f) => !f.includes("Choose a role"), "the picker to close");
    await waitText(v, "Ask about the code");
    expect(calls).toEqual([]);
    v.unmount();
  });

  it("Enter applies the pick, shows the note and closes", async () => {
    const { session } = fakeSession();
    const { dep, calls } = control();
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressUntil(v, "j", (f) => selectedRow(f).includes("test-writer"), "j");
    await pressFor(v, KEY.enter, "Model for test-writer");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("anthropic:claude"), "↓");
    await pressFor(v, KEY.enter, "test-writer is now claude-sonnet");
    expect(calls).toEqual([["test-writer", CLAUDE]]);
    await waitFor(v, (f) => !f.includes("Model for"), "the picker to close");
    v.unmount();
  });

  it("the default row passes undefined", async () => {
    const { session } = fakeSession();
    const { dep, calls } = control();
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    // The current model (qwen, index 1) is selected: ↑ once is `default`.
    await pressUntil(v, KEY.up, (f) => selectedRow(f).includes("default"), "↑ to default");
    await pressFor(v, KEY.enter, "spec is now default");
    expect(calls).toEqual([["spec", undefined]]);
    v.unmount();
  });

  it("a refusal is shown in red and nothing is installed", async () => {
    const reason = "refused: reviewer llama would share the implementer's family";
    const { session, sent } = fakeSession();
    const { dep } = control({ set: () => ({ ok: false, reason }) });
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    await pressFor(v, KEY.enter, reason);
    const raw = v.lastFrame() ?? "";
    const line = raw.split("\n").find((l) => l.includes("refused:")) ?? "";
    expect(line).toContain("\x1b[31m");
    await enter(v, "hi");
    await waitFor(v, () => sent.length === 1, "the turn on the same session");
    expect(sent).toEqual(["hi"]);
    v.unmount();
  });

  it("a spec pick installs the new session: status line, limit and next turn follow it", async () => {
    const old = fakeSession({ status: status(32_000) });
    const next = fakeSession({ status: status(77_000) });
    const c = control();
    c.dep.set = async (role, r) => {
      if (r) c.routing[role] = r;
      return {
        ok: true,
        routing: { ...c.routing },
        note: "chat model: anthropic:claude-sonnet",
        session: next.session,
      };
    };
    const v = mount({ session: old.session, routingControl: c.dep });
    await waitText(v, "qwen3:8b · ctx 1k/32k");
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("llama"), "↓");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("claude"), "↓");
    await pressFor(v, KEY.enter, "chat model: anthropic:claude-sonnet");
    await waitText(v, "claude-sonnet · ctx 1k/77k");
    await waitFor(v, () => old.dispose.mock.calls.length === 1, "the old session disposed");
    await enter(v, "hello");
    await waitFor(v, () => next.sent.length === 1, "the turn on the new session");
    expect(old.sent).toEqual([]);
    v.unmount();
  });

  it("after a spec pick, the header printed by /clear shows the new routing", async () => {
    const { session } = fakeSession();
    const fresh = fakeSession();
    const c = control();
    const v = mount({
      session,
      routingControl: c.dep,
      models: { chat: "qwen3:8b", spec: "qwen3:8b", implementer: "qwen3:8b" },
      sessions: {
        create: async () => fresh.session,
        resume: async () => fresh.session,
        list: async () => [],
      },
    });
    await waitText(v, "chat: qwen3:8b");
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("llama"), "↓");
    await pressUntil(v, KEY.down, (f) => selectedRow(f).includes("claude"), "↓");
    await pressFor(v, KEY.enter, "spec is now claude-sonnet");
    await enter(v, "/clear");
    await waitText(v, "chat: claude-sonnet");
    await waitText(v, "run: spec claude-sonnet · impl qwen3:8b · review llama3.1:8b");
    v.unmount();
  });

  it("keys typed while the picker is open (and while it applies) never reach the input", async () => {
    const { session, sent } = fakeSession();
    let release: (p: RoutingPick) => void = () => {};
    const c = control({
      set: () =>
        new Promise<RoutingPick>((r) => {
          release = r;
        }),
    });
    const v = mount({ session, routingControl: c.dep });
    await open(v);
    v.stdin.write("xyz");
    await tick(100);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    v.stdin.write("abc");
    await pressFor(v, KEY.enter, "applying");
    v.stdin.write("qqq");
    v.stdin.write(KEY.enter);
    v.stdin.write(KEY.esc);
    await tick(100);
    expect(c.calls.length).toBe(1);
    release({ ok: true, routing: c.dep.current(), note: "done picking" });
    await waitText(v, "done picking");
    await waitText(v, "Ask about the code");
    const f = plain(v.lastFrame());
    for (const s of ["xyz", "abc", "qqq"]) expect(f).not.toContain(s);
    v.stdin.write(KEY.enter);
    await tick(100);
    expect(sent).toEqual([]);
    v.unmount();
  });

  it("during a run, /model shows the routing and refuses to pick", async () => {
    const { session } = fakeSession();
    const done = new Promise(() => {});
    const run = {
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await done;
            return { done: true, value: undefined };
          },
        }),
      },
      pending: (): PendingPrompt | undefined => undefined,
      answer: () => true,
      abort: () => {},
      done,
    } as unknown as RunHandle;
    const { dep, calls } = control();
    const v = mount({ session, routingControl: dep, run });
    await enter(v, "/model");
    await waitText(v, "model picks are refused while a run is active");
    const f = plain(v.lastFrame());
    expect(f).toContain("spec: ollama:qwen3:8b");
    expect(f).not.toContain("Choose a role");
    expect(calls).toEqual([]);
    v.unmount();
  });

  it("a set that throws is shown as an error, and the picker closes", async () => {
    const { session } = fakeSession();
    const { dep } = control({
      set: () => {
        throw new Error("boom in set");
      },
    });
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    await pressFor(v, KEY.enter, "boom in set");
    await waitText(v, "Ask about the code");
    v.unmount();
  });

  it("model names with terminal escapes render sanitized", async () => {
    const { session } = fakeSession();
    const evil = ref("ollama", "evil\x1b[2J\x1b]52;c;aGk=\x07model");
    const { dep } = control({ available: [QWEN, evil] });
    const v = mount({ session, routingControl: dep });
    await open(v);
    await pressFor(v, KEY.enter, "Model for chat & spec");
    await waitText(v, "evil");
    const raw = v.lastFrame() ?? "";
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b]52");
    v.unmount();
  });
});
