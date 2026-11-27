// Force Ink's colour output on (before ink/chalk load) so the SGR assertions are not vacuous.
// Restored in afterAll; vitest isolates each test file in its own module graph.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  return previous;
});

import type { PendingPrompt, RunHandle } from "@rewire/session";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type BoardState, initialBoard } from "../src/board.js";
import { Board, RunView } from "../src/board-view.js";
import { CheckpointPanel, type CheckpointPrompt } from "../src/checkpoint.js";
import {
  cleanView,
  DiffView,
  GUTTER_MAX_DIGITS,
  parseDiff,
  TestsView,
  VIEW_MAX_TEXT,
} from "../src/diff-view.js";
import { SPINNER_TICK_MS } from "../src/spinner.js";

/** Wall-clock budget for render-time guards: they catch pathological (e.g. quadratic) slowdowns, not benchmark. CI runners are ~3x slower than a dev machine. */
const PERF_BUDGET_MS = process.env.CI ? 10_000 : 1500;

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

const ESC = "\x1b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const ONE_SGR = new RegExp(`^${ESC}\\[[0-9;]*m`);
const SGR_RUN = new RegExp(`^(?:${ESC}\\[[0-9;]*m)+`);
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type View = { lastFrame: () => string | undefined };
/** Polls until the frame passes `ok`; fails with the last frame after `ms`. */
async function waitFor(v: View, ok: (plainFrame: string) => boolean, what: string, ms = 15_000) {
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
 * drawn, so on a slow runner a key sent at once can arrive before anything listens; a key that
 * was handled shows its effect well within one attempt, so a toggle is never pressed twice.
 */
async function pressUntil(v: View, key: string, ok: (plainFrame: string) => boolean, what: string) {
  for (let i = 0; i < 10; i++) {
    v.stdin.write(key);
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if (ok(plain(v.lastFrame()))) return;
      await tick(25);
    }
  }
  await waitFor(v, ok, what);
}
const pressFor = (v: View, key: string, needle: string) =>
  pressUntil(v, key, (f) => f.includes(needle), needle);

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  esc: "\x1b",
};

/** The rendered (raw, with SGR) line whose plain text contains `needle`. */
const rawLine = (f: string | undefined, needle: string): string =>
  (f ?? "").split("\n").find((l) => plain(l).includes(needle)) ?? "";

function setColumns(stdout: unknown, n: number) {
  Object.defineProperty(stdout, "columns", { value: n, writable: true, configurable: true });
}
const maxWidth = (frame: string | undefined) =>
  Math.max(
    0,
    ...plain(frame)
      .split("\n")
      .map((l) => stringWidth(l)),
  );

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +20,4 @@ function f() {",
  " keep",
  "-old",
  "+new",
  "+more",
  " tail",
  "binary file omitted: img/logo.png",
].join("\n");

/** SGR codes in force at the start of `needle` in `line` (all SGR before it). */
const sgrBefore = (line: string, needle: string): string => {
  let raw = "";
  let i = 0;
  // Walk the raw line, tracking the plain text, until the needle starts.
  const target = plain(line).indexOf(needle);
  let seen = 0;
  while (i < line.length && seen < target) {
    const m = ONE_SGR.exec(line.slice(i));
    if (m) {
      raw += m[0];
      i += m[0].length;
    } else {
      i++;
      seen++;
    }
  }
  const m = SGR_RUN.exec(line.slice(i));
  return raw + (m?.[0] ?? "");
};

describe("DiffView colours and gutter", () => {
  it("+ green, - red, @@ cyan, file header bold with only the path, binary dim italic", () => {
    const v = render(<DiffView diff={DIFF} width={80} rows={20} />);
    const f = v.lastFrame() ?? "";
    expect(plain(f)).not.toContain("diff --git");
    expect(plain(f)).not.toContain("+++ b/");
    expect(plain(f)).not.toContain("--- a/");
    expect(sgrBefore(rawLine(f, "src/a.ts"), "src/a.ts")).toContain("\x1b[1m");
    expect(sgrBefore(rawLine(f, "@@ -10,3"), "@@")).toContain("\x1b[36m");
    expect(sgrBefore(rawLine(f, "+new"), "+new")).toContain("\x1b[32m");
    expect(sgrBefore(rawLine(f, "-old"), "-old")).toContain("\x1b[31m");
    const keep = sgrBefore(rawLine(f, " keep"), "keep");
    expect(keep).not.toContain(`${ESC}[31m`);
    expect(keep).not.toContain(`${ESC}[32m`);
    const bin = sgrBefore(rawLine(f, "binary file omitted"), "binary");
    expect(bin).toContain("\x1b[2m");
    expect(bin).toContain("\x1b[3m");
    v.unmount();
  });

  it("the gutter shows old and new line numbers from the hunk header, right-aligned and dim", () => {
    const v = render(<DiffView diff={DIFF} width={80} rows={20} />);
    const f = plain(v.lastFrame());
    const at = (needle: string) => f.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(at(" keep")).toMatch(/^10 20 {2}keep/);
    expect(at("-old")).toMatch(/^11 {4}-old/);
    expect(at("+new")).toMatch(/^ {3}21 \+new/);
    expect(at("+more")).toMatch(/^ {3}22 \+more/);
    expect(at(" tail")).toMatch(/^12 23 {2}tail/);
    expect(sgrBefore(rawLine(v.lastFrame(), "+new"), "21")).toContain("\x1b[2m");
    v.unmount();
  });

  it("parseDiff: a --- or +++ line inside a hunk is content, not a header", () => {
    const lines = parseDiff("diff --git a/x b/x\n@@ -1,2 +1,2 @@\n--- removed dashes\n+++ added\n");
    expect(lines.map((l) => l.kind)).toEqual(["file", "hunk", "del", "add"]);
  });

  it("tabs become 4 spaces and long lines are cut with an ellipsis, never wrapped", () => {
    const diff = `diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+\tx${"y".repeat(200)}`;
    const v = render(<DiffView diff={diff} width={40} rows={10} />);
    const f = plain(v.lastFrame());
    expect(f).toContain("+    xy");
    expect(f).not.toContain("\t");
    expect(
      f
        .split("\n")
        .find((l) => l.includes("+    x"))
        ?.endsWith("…"),
    ).toBe(true);
    expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
    v.unmount();
  });

  it("is cleaned once over the whole diff: OSC 52 inert, sk-ant key and SGR-split key redacted", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -1,3 +1,3 @@",
      "-copy \x1b]52;c;ZXZpbA==\x07 me",
      "+const k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';",
      `+const j = 'sk-ant-api03-${"A".repeat(20)}\x1b[31m${"B".repeat(20)}';`,
    ].join("\n");
    const v = render(<DiffView diff={diff} width={120} rows={20} />);
    const f = v.lastFrame() ?? "";
    expect(f).not.toContain("\x1b]");
    expect(f).not.toContain("\x07");
    expect(plain(f)).toContain("-copy  me");
    expect(plain(f)).not.toContain("sk-ant-api03-abc");
    expect(plain(f)).not.toContain("AAAAAAAAAA");
    expect(plain(f)).not.toContain("BBBBBBBBBB");
    expect(plain(f)).toContain("+const k = '[redacted]';");
    expect(plain(f)).toContain("+const j = '[redacted]';");
    v.unmount();
  });
});

describe("DiffView scrolling", () => {
  const long = [
    "diff --git a/x b/x",
    "@@ -1,0 +1,100 @@",
    ...Array.from({ length: 100 }, (_, i) => `+line ${i}`),
  ].join("\n");
  // 102 lines: the file header, the hunk header and 100 added lines.

  it("↑/↓ by a line, PgUp/PgDn and space/b by a page, g/G to the ends, never past them", async () => {
    const v = render(<DiffView diff={long} width={60} rows={10} />);
    expect(plain(v.lastFrame())).toContain("lines 1–10 of 102 · ↑↓ scroll · esc close");
    v.stdin.write(KEY.up);
    await tick();
    expect(plain(v.lastFrame())).toContain("lines 1–10 of 102");
    v.stdin.write(KEY.down);
    await waitText(v, "lines 2–11 of 102");
    v.stdin.write(KEY.pageDown);
    await waitText(v, "lines 12–21 of 102");
    v.stdin.write(" ");
    await waitText(v, "lines 22–31 of 102");
    v.stdin.write("b");
    await waitText(v, "lines 12–21 of 102");
    v.stdin.write(KEY.pageUp);
    await waitText(v, "lines 2–11 of 102");
    v.stdin.write("G");
    await waitText(v, "lines 93–102 of 102");
    expect(plain(v.lastFrame())).toContain("+line 99");
    expect(plain(v.lastFrame())).not.toContain("+line 89");
    v.stdin.write(KEY.down);
    await tick();
    v.stdin.write(KEY.pageDown);
    await tick();
    expect(plain(v.lastFrame())).toContain("lines 93–102 of 102");
    v.stdin.write("g");
    await waitText(v, "lines 1–10 of 102");
    expect(plain(v.lastFrame())).toContain("+line 0");
    v.stdin.write(KEY.pageUp);
    await tick();
    expect(plain(v.lastFrame())).toContain("lines 1–10 of 102");
    v.unmount();
  });

  it("keys are ignored while not active, and Esc calls onClose", async () => {
    let active = false;
    const onClose = vi.fn();
    const v = render(
      <DiffView diff={long} width={60} rows={10} isActive={() => active} onClose={onClose} />,
    );
    v.stdin.write(KEY.down);
    v.stdin.write("G");
    await tick();
    v.stdin.write(KEY.esc);
    await tick(80);
    expect(plain(v.lastFrame())).toContain("lines 1–10 of 102");
    expect(onClose).not.toHaveBeenCalled();
    active = true;
    v.stdin.write("G");
    await waitText(v, "lines 93–102 of 102");
    v.stdin.write(KEY.esc);
    await waitFor(v, () => onClose.mock.calls.length > 0, "onClose");
    v.unmount();
  });

  it("a short diff shows everything and does not scroll", async () => {
    const v = render(<DiffView diff={DIFF} width={80} rows={50} />);
    // file, index (meta), hunk, 5 hunk lines, binary
    expect(plain(v.lastFrame())).toContain("lines 1–9 of 9");
    v.stdin.write("G");
    await tick();
    expect(plain(v.lastFrame())).toContain("lines 1–9 of 9");
    v.unmount();
  });
});

describe("TestsView", () => {
  const files = [
    {
      path: "t/\x1b[31ma.test.ts",
      content: [
        "const a = 1;",
        "copy \x1b]52;c;ZXZpbA==\x07 me",
        "const k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';",
        `const j = 'sk-ant-api03-${"A".repeat(20)}\x1b[31m${"B".repeat(20)}';`,
        "\tindented",
      ].join("\n"),
    },
    { path: "t/b.test.ts", content: "it('b', () => {});" },
  ];

  it("bold path headers, highlighted contents, cleaned (sanitize then redact)", () => {
    const v = render(<TestsView files={files} width={100} rows={30} />);
    const f = v.lastFrame() ?? "";
    expect(sgrBefore(rawLine(f, "t/a.test.ts"), "t/a.test.ts")).toContain("\x1b[1m");
    expect(sgrBefore(rawLine(f, "t/b.test.ts"), "t/b.test.ts")).toContain("\x1b[1m");
    // `const` is a keyword: magenta in the syntax palette.
    expect(sgrBefore(rawLine(f, "const a = 1"), "const")).toContain("\x1b[35m");
    expect(f).not.toContain("\x1b]");
    expect(f).not.toContain("\x07");
    expect(plain(f)).toContain("copy  me");
    expect(plain(f)).not.toContain("sk-ant-api03-abc");
    expect(plain(f)).not.toContain("AAAAAAAAAA");
    expect(plain(f)).not.toContain("BBBBBBBBBB");
    expect(plain(f)).toContain("    indented");
    expect(plain(f)).toContain("lines 1–8 of 8");
    v.unmount();
  });

  it("scrolls in the same frame", async () => {
    const big = [
      { path: "t/c.test.ts", content: Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n") },
    ];
    const v = render(<TestsView files={big} width={60} rows={5} />);
    expect(plain(v.lastFrame())).toContain("lines 1–5 of 51");
    v.stdin.write("G");
    await waitText(v, "lines 47–51 of 51");
    expect(plain(v.lastFrame())).toContain("x49");
    v.unmount();
  });
});

function fakeRun(prompt: PendingPrompt | undefined) {
  const answer = vi.fn((_p: PendingPrompt, _v: unknown) => true);
  const handle = { pending: () => prompt, answer } as unknown as Pick<
    RunHandle,
    "answer" | "pending"
  >;
  return { handle, answer };
}

describe("checkpoint views", () => {
  const commit: CheckpointPrompt = {
    kind: "checkpoint",
    checkpoint: { kind: "commit", diff: DIFF },
  };

  it("commit [v]iew is a coloured DiffView; Esc closes it and answers nothing", async () => {
    const { handle, answer } = fakeRun(commit);
    const v = render(<CheckpointPanel run={handle} prompt={commit} />);
    expect(plain(v.lastFrame())).not.toContain("esc close");
    await pressFor(v, "v", "esc close");
    expect(sgrBefore(rawLine(v.lastFrame(), "+new"), "+new")).toContain("\x1b[32m");
    v.stdin.write(KEY.esc);
    await waitFor(v, (f) => !f.includes("esc close"), "the view to close");
    expect(plain(v.lastFrame())).toContain("Commit checkpoint");
    expect(answer).not.toHaveBeenCalled();
    v.unmount();
  });

  it("view keys do nothing once the panel's prompt is no longer current", async () => {
    let current: PendingPrompt | undefined = commit;
    const answer = vi.fn(() => true);
    const handle = { pending: () => current, answer } as unknown as Pick<
      RunHandle,
      "answer" | "pending"
    >;
    const long = `diff --git a/x b/x\n@@ -1,0 +1,80 @@\n${Array.from({ length: 80 }, (_, i) => `+l${i}`).join("\n")}`;
    const prompt: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: { kind: "commit", diff: long },
    };
    current = prompt;
    const v = render(<CheckpointPanel run={handle} prompt={prompt} />);
    await pressFor(v, "v", "esc close");
    current = { kind: "clarify", questions: [] };
    v.stdin.write("G");
    await tick(60);
    expect(plain(v.lastFrame())).toMatch(/lines 1–\d+ of 82/);
    v.unmount();
  });

  it("Esc closing a view inside a RunView does not abort the run", async () => {
    let finish: (o: unknown) => void = () => {};
    const done = new Promise<unknown>((r) => {
      finish = r;
    });
    const abort = vi.fn();
    const answer = vi.fn(() => true);
    const run = {
      events: {
        // biome-ignore lint/correctness/useYield: an event stream with no events until done
        [Symbol.asyncIterator]: async function* () {
          await done;
        },
      },
      pending: () => commit,
      answer,
      abort,
      done,
    } as unknown as RunHandle;
    const v = render(<RunView run={run} />);
    await waitText(v, "Commit checkpoint");
    await pressFor(v, "v", "esc close");
    // The view's key handler attaches in an effect after the frame shows: on a slow runner a key
    // sent at once can land before it, so press again until the view has closed.
    for (let i = 0; i < 20 && plain(v.lastFrame()).includes("esc close"); i++) {
      v.stdin.write(KEY.esc);
      await tick(100);
    }
    await waitFor(v, (f) => !f.includes("esc close"), "the view to close");
    await tick(60);
    expect(abort).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(plain(v.lastFrame())).toContain("Commit checkpoint");
    finish({});
    v.unmount();
  });
});

describe("cards and board at 40 columns", () => {
  const contract: CheckpointPrompt = {
    kind: "checkpoint",
    checkpoint: {
      kind: "contract",
      contract: {
        id: "C-1",
        title: "日本語".repeat(20),
        criteria: [
          { id: "AC-1", kind: "change", statement: "x".repeat(100) },
          { id: "AC-2", kind: "preserve", statement: "lex() unchanged" },
        ],
        nonGoals: [],
        affectedAreas: [],
        openQuestions: [],
      },
    },
  };
  const tests: CheckpointPrompt = {
    kind: "checkpoint",
    checkpoint: {
      kind: "tests",
      manifest: { files: [{ path: "t/a.test.ts", sha256: "0".repeat(64) }], criteriaToTests: {} },
      files: [
        { path: `t/${"deep/".repeat(20)}a.test.ts`, content: `const a = '${"z".repeat(200)}';` },
      ],
    },
  };
  const commit: CheckpointPrompt = {
    kind: "checkpoint",
    checkpoint: {
      kind: "commit",
      diff: `diff --git a/${"p/".repeat(40)}f.ts b/${"p/".repeat(40)}f.ts\n@@ -1 +1 @@\n-${"o".repeat(100)}\n+${"n".repeat(100)}`,
    },
  };

  for (const [name, prompt] of [
    ["contract", contract],
    ["tests", tests],
    ["commit", commit],
  ] as const) {
    it(`the ${name} card fits 40 columns, closed and with its view open`, async () => {
      const { handle } = fakeRun(prompt);
      const v = render(<CheckpointPanel run={handle} prompt={prompt} />);
      setColumns(v.stdout, 40);
      v.stdout.emit("resize");
      await tick();
      expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
      expect(plain(v.lastFrame())).toMatch(/^╭─+╮$/m);
      expect(plain(v.lastFrame())).toContain("a approve");
      if (name !== "contract") {
        await pressUntil(v, "v", (f) => /lines 1–\d+ of \d+/.test(f), "the view footer");
        expect(maxWidth(v.lastFrame())).toBeLessThanOrEqual(40);
      }
      v.unmount();
    });
  }

  it("card titles take the border colour; key letters are bold; badges and stat are coloured", () => {
    const c = render(<CheckpointPanel run={fakeRun(contract).handle} prompt={contract} />);
    const cf = c.lastFrame() ?? "";
    expect(plain(cf)).toContain("a approve · e revise · s stop");
    expect(sgrBefore(rawLine(cf, "a approve"), "a approve")).toContain("\x1b[1m");
    expect(rawLine(cf, "[change]")).toMatch(new RegExp(`${ESC}\\[3\\dm\\[change\\]`));
    expect(rawLine(cf, "[preserve]")).toMatch(new RegExp(`${ESC}\\[3\\dm\\[preserve\\]`));
    c.unmount();
    const t = render(<CheckpointPanel run={fakeRun(tests).handle} prompt={tests} />);
    const tf = t.lastFrame() ?? "";
    expect(sgrBefore(rawLine(tf, "Tests checkpoint"), "Tests checkpoint")).toContain("\x1b[33m");
    expect(rawLine(tf, "╭")).toContain("\x1b[33m");
    expect(plain(tf)).toContain("a approve · v view · s stop");
    t.unmount();
    const d = render(<CheckpointPanel run={fakeRun(commit).handle} prompt={commit} />);
    const df = d.lastFrame() ?? "";
    expect(sgrBefore(rawLine(df, "Commit checkpoint"), "Commit checkpoint")).toContain("\x1b[32m");
    expect(rawLine(df, "+1")).toContain("\x1b[32m+1");
    expect(rawLine(df, "−1")).toContain("\x1b[31m−1");
    d.unmount();
  });

  it("the board fits 40 columns in a round border with coloured status glyphs", async () => {
    const s: BoardState = initialBoard();
    s.rows.Spec = { status: "done", detail: "日本語の説明".repeat(10) };
    s.rows.Tests = { status: "failed", detail: "boom" };
    s.rows.Implement = { status: "running", detail: "x".repeat(100) };
    const v = render(<Board state={s} />);
    setColumns(v.stdout, 40);
    v.stdout.emit("resize");
    await tick();
    const f = v.lastFrame() ?? "";
    expect(maxWidth(f)).toBeLessThanOrEqual(40);
    expect(plain(f)).toMatch(/^╭─+╮$/m);
    expect(rawLine(f, "Spec")).toContain("\x1b[32m✓");
    expect(rawLine(f, "Tests")).toContain("\x1b[31m✗");
    expect(plain(rawLine(f, "Review"))).toContain("○ Review");
    expect(sgrBefore(rawLine(f, "boom"), "boom")).toContain("\x1b[2m");
    v.unmount();
  });
});

describe("fix round 1", () => {
  it("a secret straddling the 200k cap is redacted whole, not cut to a prefix", () => {
    const key = `sk-ant-api03-${"Q".repeat(40)}`;
    for (const before of [8, 13, 20, 30]) {
      // The padding ends in a space: a key glued to a word is part of that word, never a secret.
      const text = `${"x".repeat(VIEW_MAX_TEXT - before - 1)} ${key} tail`;
      const out = cleanView(text);
      expect(out.length).toBeLessThanOrEqual(VIEW_MAX_TEXT);
      expect(out).not.toContain("sk-ant");
      expect(out).not.toContain("QQQ");
    }
  });

  it("a truncated hunk adds no trailing blank context row", () => {
    const lines = parseDiff("diff --git a/x b/x\n@@ -1,5 +1,5 @@\n a\n-b\n+c\n");
    expect(lines.map((l) => l.kind)).toEqual(["file", "hunk", "ctx", "del", "add"]);
    const v = render(
      <DiffView diff={"diff --git a/x b/x\n@@ -1,5 +1,5 @@\n a\n-b\n+c\n"} width={60} rows={20} />,
    );
    expect(plain(v.lastFrame())).toContain("lines 1–5 of 5");
    v.unmount();
  });

  it("malformed hunk headers: no NaN, no Infinity, and a capped gutter", () => {
    for (const header of [
      "@@ -a,b +c,d @@",
      "@@ -1,x +1,y @@",
      `@@ -${"9".repeat(30)},2 +${"9".repeat(400)},2 @@`,
      "@@ -1000000,2 +1000000,2 @@",
    ]) {
      const diff = `diff --git a/x b/x\n${header}\n ctx\n-old\n+new\nnot diff`;
      const lines = parseDiff(diff);
      for (const l of lines) {
        if ("old" in l && l.old !== undefined) expect(Number.isSafeInteger(l.old)).toBe(true);
        if ("new" in l && l.new !== undefined) expect(Number.isSafeInteger(l.new)).toBe(true);
      }
      const v = render(<DiffView diff={diff} width={80} rows={20} />);
      const f = plain(v.lastFrame());
      expect(f).not.toContain("NaN");
      expect(f).not.toContain("Infinity");
      expect(f).not.toContain("e+");
      // unnumbered: the content starts the line, with no gutter
      expect(f).toMatch(/^\+new$/m);
      expect(f).toMatch(/^-old$/m);
      v.unmount();
    }
    // The largest numbered header keeps the gutter within its digit cap.
    const big = parseDiff("diff --git a/x b/x\n@@ -999999,2 +999999,2 @@\n a\n b");
    const v = render(
      <DiffView
        diff={"diff --git a/x b/x\n@@ -999999,2 +999999,2 @@\n a\n b"}
        width={80}
        rows={20}
      />,
    );
    expect(big.some((l) => "new" in l && l.new === 1_000_000)).toBe(true);
    const row =
      plain(v.lastFrame())
        .split("\n")
        .find((l) => l.endsWith(" b")) ?? "";
    expect(row).toBe("1000000 1000000  b");
    expect(row.split(" ")[0]?.length).toBeLessThanOrEqual(GUTTER_MAX_DIGITS);
    v.unmount();
  });

  it("the board spinner interval is cleared on unmount and when nothing is running", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const s = initialBoard();
      s.rows.Implement = { status: "running", detail: "" };
      const v = render(<Board state={s} />);
      await tick();
      const ids = set.mock.results
        .filter((_, i) => set.mock.calls[i]?.[1] === SPINNER_TICK_MS)
        .map((r) => r.value);
      expect(ids).toHaveLength(1);
      const idle = initialBoard();
      idle.rows.Implement = { status: "done", detail: "" };
      v.rerender(<Board state={idle} />);
      await tick();
      expect(clear.mock.calls.map((c) => c[0])).toContain(ids[0]);
      v.rerender(<Board state={s} />);
      await tick();
      const again = set.mock.results
        .filter((_, i) => set.mock.calls[i]?.[1] === SPINNER_TICK_MS)
        .map((r) => r.value);
      expect(again).toHaveLength(2);
      v.unmount();
      expect(clear.mock.calls.map((c) => c[0])).toContain(again[1]);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  function setRows(stdout: unknown, n: number) {
    Object.defineProperty(stdout, "rows", { value: n, writable: true, configurable: true });
  }

  function runWith(prompt: CheckpointPrompt) {
    let finish: (o: unknown) => void = () => {};
    const done = new Promise<unknown>((r) => {
      finish = r;
    });
    const run = {
      events: {
        // biome-ignore lint/correctness/useYield: an event stream with no events until done
        [Symbol.asyncIterator]: async function* () {
          await done;
        },
      },
      pending: () => prompt,
      answer: vi.fn(() => true),
      abort: vi.fn(),
      done,
    } as unknown as RunHandle;
    return { run, finish };
  }

  const height = (f: string | undefined) => (f ?? "").split("\n").length;

  it("at 12 rows the board folds to one line and a card never exceeds the height", async () => {
    const many: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: {
        kind: "contract",
        contract: {
          id: "C",
          title: "t",
          criteria: Array.from({ length: 12 }, (_, i) => ({
            id: `AC-${i}`,
            kind: "change" as const,
            statement: `s${i}`,
          })),
          nonGoals: [],
          affectedAreas: [],
          openQuestions: [],
        },
      },
    };
    const { run, finish } = runWith(many);
    const v = render(<RunView run={run} />);
    await waitText(v, "Contract checkpoint");
    expect(plain(v.lastFrame())).toContain("╭"); // full board at the default 24 rows
    expect(plain(v.lastFrame()).match(/╭/g)).toHaveLength(2);
    setRows(v.stdout, 12);
    v.stdout.emit("resize");
    await waitFor(v, (f) => (f.match(/╭/g) ?? []).length === 1, "the one-line board");
    // one row is left for the App's status line
    expect(height(v.lastFrame())).toBeLessThanOrEqual(11);
    expect(plain(v.lastFrame())).toMatch(/○ Spec\s+○ Tests/);
    expect(plain(v.lastFrame())).toContain("more criteria · v view all");
    expect(plain(v.lastFrame())).toContain("a approve");
    expect(plain(v.lastFrame())).not.toContain("AC-11");
    // v opens every criterion in the scroll frame; the last one is reachable.
    await pressFor(v, "v", "of 12 · ↑↓ scroll");
    expect(height(v.lastFrame())).toBeLessThanOrEqual(11);
    v.stdin.write("G");
    await waitText(v, "AC-11 [change] s11");
    expect(height(v.lastFrame())).toBeLessThanOrEqual(11);
    expect(run.answer).not.toHaveBeenCalled();
    v.stdin.write(KEY.esc);
    await waitFor(v, (f) => !f.includes("↑↓ scroll"), "the view to close");
    expect(plain(v.lastFrame())).toContain("more criteria · v view all");
    expect(run.abort).not.toHaveBeenCalled();
    finish({});
    v.unmount();
  });

  it("view keys are ignored while the contract's revise box takes text", async () => {
    const prompt: CheckpointPrompt = {
      kind: "checkpoint",
      checkpoint: {
        kind: "contract",
        contract: {
          id: "C",
          title: "t",
          criteria: Array.from({ length: 40 }, (_, i) => ({
            id: `AC-${i}`,
            kind: "preserve" as const,
            statement: `s${i}`,
          })),
          nonGoals: [],
          affectedAreas: [],
          openQuestions: [],
        },
      },
    };
    const { handle, answer } = fakeRun(prompt);
    const v = render(<CheckpointPanel run={handle} prompt={prompt} />);
    await pressFor(v, "v", "of 40 · ↑↓ scroll");
    v.stdin.write("e");
    await waitText(v, "revise: ");
    v.stdin.write("G g");
    await waitText(v, "revise: G g");
    expect(plain(v.lastFrame())).toMatch(/lines 1–\d+ of 40/);
    v.stdin.write(KEY.esc);
    await waitFor(v, (f) => !f.includes("revise:"), "the revise box to close");
    expect(plain(v.lastFrame())).toContain("of 40 · ↑↓ scroll");
    expect(answer).not.toHaveBeenCalled();
    v.unmount();
  });

  it("at 12 rows an open diff view keeps the frame within the height", async () => {
    const diff = `diff --git a/x b/x\n@@ -1,0 +1,80 @@\n${Array.from({ length: 80 }, (_, i) => `+l${i}`).join("\n")}`;
    const prompt: CheckpointPrompt = { kind: "checkpoint", checkpoint: { kind: "commit", diff } };
    const { run, finish } = runWith(prompt);
    const v = render(<RunView run={run} />);
    await waitText(v, "Commit checkpoint");
    setRows(v.stdout, 12);
    v.stdout.emit("resize");
    await pressFor(v, "v", "esc close");
    expect(height(v.lastFrame())).toBeLessThanOrEqual(11);
    v.stdin.write("G");
    await waitText(v, "of 82");
    await waitFor(v, (f) => f.includes("+l79"), "the last line");
    expect(height(v.lastFrame())).toBeLessThanOrEqual(11);
    finish({});
    v.unmount();
  });

  it("a 200k diff renders, and jumps to the end, within 1500 ms", async () => {
    const body: string[] = [];
    let n = 0;
    let file = 0;
    while (n < VIEW_MAX_TEXT) {
      const head = `diff --git a/src/f${file}.ts b/src/f${file}.ts\n@@ -1,40 +1,40 @@`;
      body.push(head);
      n += head.length + 1;
      for (let i = 0; i < 40; i++) {
        const l = `${i % 3 === 0 ? "+" : i % 3 === 1 ? "-" : " "}\tconst v${i} = "${"z".repeat(40)}";`;
        body.push(l);
        n += l.length + 1;
      }
      file++;
    }
    const diff = body.join("\n");
    expect(diff.length).toBeGreaterThanOrEqual(VIEW_MAX_TEXT);
    const t0 = performance.now();
    const v = render(<DiffView diff={diff} width={100} rows={30} />);
    expect(plain(v.lastFrame())).toContain("lines 1–30 of");
    v.stdin.write("G");
    await waitFor(v, (f) => !f.includes("lines 1–30 of"), "the jump to the end");
    expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
    v.unmount();
  });
});
