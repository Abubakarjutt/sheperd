import type { Contract } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type BoardState, initialBoard } from "../src/board.js";
import { Board } from "../src/board-view.js";
import { CheckpointPanel, type CheckpointPrompt, diffStat } from "../src/checkpoint.js";
import { width } from "../src/fit.js";
import { Transcript, type TranscriptEntry } from "../src/transcript.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const type = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await tick();
};

const contract: Contract = {
  id: "C-1",
  title: "Add parser",
  criteria: [
    { id: "AC-1", kind: "change", statement: "parse() returns tokens" },
    { id: "AC-2", kind: "preserve", statement: "lex() unchanged" },
  ],
  nonGoals: [],
  affectedAreas: [],
  openQuestions: [],
};
const contractPrompt: CheckpointPrompt = {
  kind: "checkpoint",
  checkpoint: { kind: "contract", contract },
};

function fakeRun(prompt: PendingPrompt | undefined, accept = true) {
  const answer = vi.fn((_p: PendingPrompt, _v: unknown) => accept);
  const handle = { pending: () => prompt, answer } as unknown as Pick<
    RunHandle,
    "answer" | "pending"
  >;
  return { handle, answer };
}

/** ink-testing-library's stdout has a fixed width: shadow it per test. */
function setColumns(stdout: unknown, n: number) {
  Object.defineProperty(stdout, "columns", { value: n, writable: true, configurable: true });
}

const maxWidth = (frame: string | undefined) =>
  Math.max(0, ...(frame ?? "").split("\n").map((l) => width(l)));

describe("CheckpointPanel keys", () => {
  it("a approves the contract", async () => {
    const { handle, answer } = fakeRun(contractPrompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    expect(lastFrame()).toContain("AC-1 [change] parse() returns tokens");
    expect(lastFrame()).toContain("[a]pprove [e] revise [s]top");
    await type(stdin, "a");
    expect(answer).toHaveBeenCalledWith(contractPrompt, { action: "approve" });
  });

  it("e then typing a note and Enter revises with the note", async () => {
    const { handle, answer } = fakeRun(contractPrompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    await type(stdin, "e");
    expect(lastFrame()).toContain("revise: ");
    await type(stdin, "AC-2 is a change");
    await type(stdin, "\r");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(contractPrompt, {
      action: "revise",
      note: "AC-2 is a change",
    });
  });

  it("while editing, a and s are text, not decisions; Esc cancels", async () => {
    const { handle, answer } = fakeRun(contractPrompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    await type(stdin, "e");
    await type(stdin, "as");
    expect(answer).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("revise: as");
    await type(stdin, "\x1b");
    await tick(60);
    expect(lastFrame()).not.toContain("revise:");
    await type(stdin, "s");
    expect(answer).toHaveBeenCalledWith(contractPrompt, { action: "stop" });
  });

  it("an empty note is rejected locally and a too-long note is rejected with a message", async () => {
    const { handle, answer } = fakeRun(contractPrompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    await type(stdin, "e");
    await type(stdin, "\r");
    expect(answer).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("cannot be empty");
    await type(stdin, "x".repeat(2001));
    await type(stdin, "\r");
    expect(answer).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("too long");
  });

  it("a stale prompt answers nothing and says so", async () => {
    const { handle, answer } = fakeRun({ kind: "clarify", questions: [] });
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    await type(stdin, "a");
    expect(answer).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("that prompt is no longer active");
  });

  it("answer returning false shows the stale message", async () => {
    const { handle } = fakeRun(contractPrompt, false);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={contractPrompt} />);
    await type(stdin, "a");
    expect(lastFrame()).toContain("that prompt is no longer active");
  });

  it("tests panel: lists files, [v]iew toggles sanitized and redacted content, a approves", async () => {
    const prompt: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: {
        kind: "tests",
        manifest: { files: [{ path: "t/a.test.ts", sha256: "0".repeat(64) }], criteriaToTests: {} },
        files: [
          {
            path: "t/\x1b[31ma.test.ts",
            content: "expect(1)\x1b]52;c;ZXZpbA==\x07.toBe(1)\nconst k = 'AKIAIOSFODNN7EXAMPLE'‮",
          },
        ],
      },
    };
    const { handle, answer } = fakeRun(prompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={prompt} />);
    expect(lastFrame()).toContain("1 frozen test file");
    expect(lastFrame()).toContain("[a]pprove [v]iew [s]top");
    expect(lastFrame()).not.toContain("expect(1)");
    await type(stdin, "v");
    const f = lastFrame() ?? "";
    expect(f).toContain("expect(1).toBe(1)");
    expect(f).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(f).not.toContain("\x1b]");
    expect(f).not.toContain("‮");
    await type(stdin, "v");
    expect(lastFrame()).not.toContain("expect(1)");
    await type(stdin, "a");
    expect(answer).toHaveBeenCalledWith(prompt, { action: "approve" });
  });

  it("commit panel: diff stat with binary omitted lines, hostile bytes inert, no e key", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old\x00",
      "+new\x1b[2J",
      "+more",
      "binary file omitted: img/\x1b]52;c;x\x07logo.png",
    ].join("\n");
    const prompt: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: { kind: "commit", diff },
    };
    const { handle, answer } = fakeRun(prompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={prompt} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("src/a.ts +2 -1");
    expect(f).toContain("img/logo.png (binary, omitted)");
    expect(f).not.toContain("\x1b");
    expect(f).toContain("[a]pprove [v]iew [s]top");
    await type(stdin, "e");
    expect(lastFrame()).not.toContain("revise:");
    await type(stdin, "s");
    expect(answer).toHaveBeenCalledWith(prompt, { action: "stop" });
  });

  it("commit panel: [v]iew shows the diff redacted, sanitized and capped to the rows (M4)", async () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+const k = 'AKIAIOSFODNN7EXAMPLE'\x1b]52;c;ZXZpbA==\x07;",
      ...Array.from({ length: 60 }, (_, i) => `+line ${i}`),
    ].join("\n");
    const prompt: CheckpointPrompt = { kind: "checkpoint", checkpoint: { kind: "commit", diff } };
    const { handle, answer } = fakeRun(prompt);
    const v = render(<CheckpointPanel run={handle} prompt={prompt} />);
    expect(v.lastFrame()).not.toContain("+line 0");
    await type(v.stdin, "v");
    const f = v.lastFrame() ?? "";
    expect(f).toContain("+const k = '[redacted]';");
    expect(f).toContain("+line 0");
    expect(f).not.toContain("+line 59");
    expect(f).toContain("… (truncated");
    expect(f).not.toContain("\x1b");
    await type(v.stdin, "v");
    expect(v.lastFrame()).not.toContain("+line 0");
    await type(v.stdin, "a");
    expect(answer).toHaveBeenCalledWith(prompt, { action: "approve" });
  });

  it("diffStat counts per file", () => {
    const s = diffStat("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n+c");
    expect(s.files).toEqual([{ path: "x", added: 2, removed: 1, binary: false }]);
  });
});

describe("narrow terminals and resize (Review Focus 4)", () => {
  const busy = (): BoardState => {
    const s = initialBoard();
    s.rows.Spec = { status: "done", detail: "日本語の説明".repeat(10) };
    s.rows.Implement = {
      status: "running",
      detail: `edit: ${"src/very/long/path/".repeat(8)}file.ts \x1b]52;c;ZXZpbA==\x07`,
    };
    s.rows.Gates = {
      status: "failed",
      detail: "3/9 passed · failed: semgrep, gitleaks, dependency-audit, types",
    };
    return s;
  };

  const lines = (frame: string | undefined) => (frame ?? "").split("\n");

  it("board is exactly one line per stage at 40 columns, and long details end with an ellipsis", () => {
    const v = render(<Board state={busy()} />);
    setColumns(v.stdout, 40);
    v.rerender(<Board state={busy()} />);
    const ls = lines(v.lastFrame());
    expect(ls).toHaveLength(6); // nothing wrapped
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    for (const i of [0, 2, 3]) expect(ls[i]?.trimEnd().endsWith("…")).toBe(true);
    expect(v.lastFrame()).not.toContain("\x1b]52");
  });

  it("a resize from 120 to 40 to 5 keeps one line per stage and re-truncates", async () => {
    const v = render(<Board state={busy()} />);
    setColumns(v.stdout, 120);
    v.stdout.emit("resize");
    await tick();
    expect(lines(v.lastFrame())).toHaveLength(6);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(120);
    setColumns(v.stdout, 40);
    expect(() => v.stdout.emit("resize")).not.toThrow();
    await tick();
    expect(lines(v.lastFrame())).toHaveLength(6);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    expect(lines(v.lastFrame())[2]?.trimEnd().endsWith("…")).toBe(true);
    for (const n of [5, 1, 0]) {
      setColumns(v.stdout, n);
      expect(() => v.stdout.emit("resize")).not.toThrow();
      await tick();
    }
    // columns 0 is "unknown": falls back to 80, not blank
    expect(maxWidth(v.lastFrame())).toBeGreaterThan(10);
  });

  it("the contract panel is one line per row at 40 columns, including the revise box", async () => {
    const wide: Contract = {
      ...contract,
      criteria: [{ id: "AC-1", kind: "change", statement: "日本語".repeat(30) }],
    };
    const prompt: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: { kind: "contract", contract: wide },
    };
    const { handle } = fakeRun(prompt);
    const v = render(<CheckpointPanel run={handle} prompt={prompt} />);
    setColumns(v.stdout, 40);
    v.stdout.emit("resize");
    await tick();
    expect(lines(v.lastFrame())).toHaveLength(3); // title, one criterion, keys
    expect(lines(v.lastFrame())[1]?.trimEnd().endsWith("…")).toBe(true);
    await type(v.stdin, "e");
    await type(v.stdin, "z".repeat(100));
    const ls = lines(v.lastFrame());
    expect(ls).toHaveLength(4);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    expect(ls[3]?.trimEnd().endsWith("…")).toBe(true);
  });

  it("transcript one-line entries are truncated, not wrapped, at 40 columns and across a resize", async () => {
    const long = "src/very/long/path/".repeat(10);
    const entries: TranscriptEntry[] = [
      { kind: "user", text: `first ${long}\nsecond line` },
      { kind: "tool", summary: `read ${long}`, isError: false },
      { kind: "error", code: "some_code", message: long },
      { kind: "assistant", text: `${"word ".repeat(30)}` },
    ];
    // I3: finished entries are printed once through <Static>, cut to the width at the time they
    // are printed (a later resize does not re-flow them). So resize 120 -> 40 first, with an empty
    // transcript, then append the entries and check they print truncated at 40.
    const v = render(<Transcript entries={[]} />);
    setColumns(v.stdout, 120);
    v.stdout.emit("resize");
    await tick();
    setColumns(v.stdout, 40);
    expect(() => v.stdout.emit("resize")).not.toThrow();
    await tick();
    v.rerender(<Transcript entries={entries} />);
    await tick();
    const ls = lines(v.lastFrame());
    expect(ls[0]?.endsWith("…")).toBe(true); // user echo, first line
    expect(ls[1]).toContain("second line");
    expect(ls[2]?.endsWith("…")).toBe(true); // tool
    expect(ls[3]?.endsWith("…")).toBe(true); // error
    expect(ls.slice(0, 4).every((l) => width(l) <= 40)).toBe(true);
    expect(ls.length).toBeGreaterThan(5); // the assistant prose wraps over several lines
    for (const n of [5, 1, 0, 200]) {
      setColumns(v.stdout, n);
      expect(() => v.stdout.emit("resize")).not.toThrow();
      await tick();
    }
  });
});

describe("RunView", () => {
  it("folds events into the board and shows the pending checkpoint; answering works", async () => {
    const { RunView } = await import("../src/board-view.js");
    const events = [
      { runId: "r", ts: "2026-01-01T00:00:00.000Z", type: "stage_start", stage: "spec" },
      { runId: "r", ts: "2026-01-01T00:00:00.000Z", type: "stage_end", stage: "spec", ok: true },
    ];
    let release: () => void = () => {};
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    const answer = vi.fn(() => true);
    const t0 = Date.now();
    const run = {
      events: (async function* () {
        yield* events;
        await gateOpen;
      })(),
      // The checkpoint arrives after the spec stage has ended, as in a real run.
      pending: () => (Date.now() - t0 > 60 ? contractPrompt : undefined),
      answer,
      abort: () => {},
      done: gateOpen.then(() => ({})),
    } as unknown as RunHandle;
    const v = render(<RunView run={run} />);
    await tick(150);
    const f = v.lastFrame() ?? "";
    expect(f).toContain("✓ Spec");
    expect(f).toContain("1 change · 1 preserve");
    expect(f).toContain("[a]pprove [e] revise [s]top");
    await type(v.stdin, "a");
    expect(answer).toHaveBeenCalledWith(contractPrompt, { action: "approve" });
    release();
    v.unmount();
  });

  const evt = (e: Record<string, unknown>) => ({
    runId: "r",
    ts: "2026-01-01T00:00:00.000Z",
    ...e,
  });

  function liveRun(events: unknown[], pending: () => PendingPrompt | undefined) {
    let finish: (o: unknown) => void = () => {};
    const done = new Promise<unknown>((r) => {
      finish = r;
    });
    const pendingSpy = vi.fn(pending);
    const run = {
      // Like the real EventStream: every iteration replays from the start.
      events: {
        [Symbol.asyncIterator]: async function* () {
          yield* events;
          await done;
        },
      },
      pending: pendingSpy,
      answer: vi.fn(() => true),
      abort: () => {},
      done,
    } as unknown as RunHandle;
    return { run, finish, pendingSpy };
  }

  it("a parent re-render with an inline onDone does not double the counts", async () => {
    const { RunView } = await import("../src/board-view.js");
    const { run, finish } = liveRun(
      [
        evt({ type: "finding", stage: "security", finding: { id: "f1" } }),
        evt({ type: "finding", stage: "security", finding: { id: "f2" } }),
      ],
      () => undefined,
    );
    const v = render(<RunView run={run} onDone={() => {}} />);
    await tick(100);
    expect(v.lastFrame()).toContain("2 findings");
    v.rerender(<RunView run={run} onDone={() => {}} />);
    v.rerender(<RunView run={run} onDone={() => {}} />);
    await tick(100);
    expect(v.lastFrame()).toContain("2 findings");
    expect(v.lastFrame()).not.toContain("4 findings");
    finish({});
    v.unmount();
  });

  it("stops polling pending() once done settles, and reports the outcome", async () => {
    const { RunView } = await import("../src/board-view.js");
    const { run, finish, pendingSpy } = liveRun([], () => undefined);
    const onDone = vi.fn();
    const v = render(<RunView run={run} onDone={onDone} />);
    await tick(120);
    finish({ status: "verified" });
    await tick(60);
    const calls = pendingSpy.mock.calls.length;
    await tick(200);
    expect(pendingSpy.mock.calls.length).toBe(calls);
    expect(onDone).toHaveBeenCalledWith({ status: "verified" });
    v.unmount();
  });

  it("a fresh prompt gets a fresh panel (no stale message) and revision limit hides [e]", async () => {
    const { RunView } = await import("../src/board-view.js");
    const second: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: { kind: "contract", contract },
    };
    let current: PendingPrompt | undefined = contractPrompt;
    const revise = evt({
      type: "checkpoint",
      stage: "spec",
      kind: "contract",
      decision: { action: "revise", note: "n" },
    });
    const { run, finish } = liveRun([revise, revise, revise], () => current);
    const v = render(<RunView run={run} />);
    await tick(120);
    expect(v.lastFrame()).toContain("revision limit reached; [a]pprove or [s]top");
    expect(v.lastFrame()).not.toContain("[e] revise");
    await type(v.stdin, "e");
    expect(v.lastFrame()).not.toContain("revise:");
    // a message on the first panel must not survive onto the next prompt
    current = { kind: "clarify", questions: [] };
    await tick(100);
    await type(v.stdin, "a");
    current = second;
    await tick(100);
    expect(v.lastFrame()).not.toContain("no longer active");
    finish({});
    v.unmount();
  });

  it("App appends the outcome message to the transcript when the run is done", async () => {
    const { App } = await import("../src/app.js");
    const { run, finish } = liveRun([], () => undefined);
    const session = { send: async () => ({ text: "" }), history: () => [] };
    const v = render(
      <App session={session as never} runController={{} as never} config={{}} run={run} />,
    );
    await tick(100);
    finish({ status: "verified", runId: "r1", branch: "rewire/r1", reportPath: "/x/report.md" });
    await tick(100);
    const f = v.lastFrame() ?? "";
    expect(f).toContain("Run r1 verified.");
    expect(f).toContain("Branch: rewire/r1");
    expect(f).not.toContain("working"); // the input is usable again
  });
});
