import type { Contract } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { type BoardState, initialBoard } from "../src/board.js";
import { Board } from "../src/board-view.js";
import { CheckpointPanel, type CheckpointPrompt, diffStat } from "../src/checkpoint.js";
import { width } from "../src/fit.js";

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
    expect(lastFrame()).toContain("[a]pprove [e]dit via chat [s]top");
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
      checkpoint: { kind: "commit", diff, reportPreview: "" },
    };
    const { handle, answer } = fakeRun(prompt);
    const { stdin, lastFrame } = render(<CheckpointPanel run={handle} prompt={prompt} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("src/a.ts +2 -1");
    expect(f).toContain("img/logo.png (binary, omitted)");
    expect(f).not.toContain("\x1b");
    expect(f).toContain("[a]pprove [s]top");
    await type(stdin, "e");
    expect(lastFrame()).not.toContain("revise:");
    await type(stdin, "s");
    expect(answer).toHaveBeenCalledWith(prompt, { action: "stop" });
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

  it("board lines are at most 40 columns wide", () => {
    const v = render(<Board state={busy()} />);
    setColumns(v.stdout, 40);
    v.rerender(<Board state={busy()} />);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    expect(maxWidth(v.lastFrame())).toBeGreaterThan(30); // truncated, not blank
    expect(v.lastFrame()).not.toContain("\x1b]52");
  });

  it("a resize from 120 to 40 mid-render does not throw and re-truncates", async () => {
    const v = render(<Board state={busy()} />);
    setColumns(v.stdout, 120);
    v.stdout.emit("resize");
    await tick();
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(120);
    setColumns(v.stdout, 40);
    expect(() => v.stdout.emit("resize")).not.toThrow();
    await tick();
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    setColumns(v.stdout, 5);
    expect(() => v.stdout.emit("resize")).not.toThrow();
    await tick();
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(5);
  });

  it("the checkpoint panel truncates at 40 columns, including CJK criteria and the revise box", async () => {
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
    await type(v.stdin, "e");
    await type(v.stdin, "z".repeat(100));
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
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
    expect(f).toContain("[a]pprove [e]dit via chat [s]top");
    await type(v.stdin, "a");
    expect(answer).toHaveBeenCalledWith(contractPrompt, { action: "approve" });
    release();
    v.unmount();
  });
});
