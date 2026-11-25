import type { ChatMessage } from "@rewire/providers";
import { describe, expect, test } from "vitest";
import {
  emptyRecord,
  type Observed,
  observe,
  RecordItem,
  type RecordItem as RecordItemT,
  renderRecord,
  SessionRecord,
  type SessionRecord as SessionRecordT,
} from "../src/index.js";

const item = (over: Partial<RecordItemT> = {}): RecordItemT => ({
  id: "r1",
  kind: "decision",
  text: "use zod for the schemas",
  source: "user",
  evidence: [{ messageId: "m0", quote: "use zod" }],
  status: "active",
  createdAt: "m0",
  updatedAt: "m0",
  ...over,
});

const observed = (over: Partial<Observed> = {}): Observed => ({
  files: [],
  commands: [],
  runs: [],
  errors: [],
  ...over,
});

const record = (over: Partial<SessionRecordT> = {}): SessionRecordT => ({
  ...emptyRecord(),
  ...over,
});

describe("schemas", () => {
  test("a full record round-trips through JSON unchanged", () => {
    const r: SessionRecordT = {
      version: 1,
      items: [
        item(),
        item({
          id: "r2",
          kind: "note",
          source: "inferred",
          text: "the parser is slow",
          reason: "seen in the profile",
          evidence: undefined,
          createdAt: "m3",
          updatedAt: "m5",
        }),
      ],
      observed: observed({
        files: [{ path: "src/a.ts", reads: 2, writes: 1 }],
        commands: [{ cmd: "pnpm test", exit: 1, count: 3 }],
        runs: [{ runId: "20260101-000000-abcdef", status: "verified", reportPath: "r.md" }],
        errors: [{ tool: "read", message: "error: ENOENT" }],
      }),
      archive: [item({ id: "r0", status: "superseded", supersededBy: "r1" })],
      compactions: 2,
    };
    const json = JSON.parse(JSON.stringify(r));
    expect(SessionRecord.parse(json)).toEqual(JSON.parse(JSON.stringify(r)));
    expect(SessionRecord.parse(emptyRecord())).toEqual(emptyRecord());
  });

  test("invalid inputs are rejected", () => {
    const bad: unknown[] = [
      item({ text: "x".repeat(501) }),
      item({ text: "" }),
      item({ evidence: [{ messageId: "m1", quote: "q".repeat(301) }] }),
      item({ evidence: Array.from({ length: 6 }, () => ({ messageId: "m1", quote: "q" })) }),
      item({ evidence: [{ messageId: "1", quote: "q" }] }),
      item({ createdAt: "message 3" }),
      { ...item(), kind: "summary" },
      { ...item(), source: "tool" },
      { ...item(), status: "deleted" },
      { ...item(), extra: true },
    ];
    for (const b of bad) expect(RecordItem.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(RecordItem.safeParse(item({ text: "x".repeat(500) })).success).toBe(true);

    const tooMany = Array.from({ length: 201 }, (_, i) => item({ id: `r${i}` }));
    expect(SessionRecord.safeParse(record({ items: tooMany })).success).toBe(false);
    // The cap is on active items: the archive is unbounded.
    expect(SessionRecord.safeParse(record({ items: tooMany.slice(1) })).success).toBe(true);
    expect(SessionRecord.safeParse(record({ archive: tooMany.slice(0, 500) })).success).toBe(true);
    expect(SessionRecord.safeParse(record({ items: [item(), item()] })).success).toBe(false);
    expect(SessionRecord.safeParse({ ...record(), version: 2 }).success).toBe(false);
    expect(SessionRecord.safeParse({ ...record(), compactions: -1 }).success).toBe(false);
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, reads: 1 }));
    expect(SessionRecord.safeParse(record({ observed: observed({ files }) })).success).toBe(false);
    const commands = Array.from({ length: 101 }, (_, i) => ({ cmd: `c${i}`, exit: 0, count: 1 }));
    expect(SessionRecord.safeParse(record({ observed: observed({ commands }) })).success).toBe(
      false,
    );
    const errors = Array.from({ length: 51 }, () => ({ tool: "bash", message: "x" }));
    expect(SessionRecord.safeParse(record({ observed: observed({ errors }) })).success).toBe(false);
  });
});

/** A history in the exact shapes the loop stores: tool results carry no isError. */
function fixture(): ChatMessage[] {
  const a = (calls: [string, string, Record<string, unknown>][]): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: calls.map(([id, name, args]) => ({ id, name, arguments: args })),
  });
  const t = (id: string, content: string): ChatMessage => ({
    role: "tool",
    content,
    toolCallId: id,
  });
  return [
    { role: "user", content: "fix the wrap bug" },
    a([
      ["c1", "read", { path: "src/wrap.ts" }],
      ["c2", "grep", { pattern: "wrap(", path: "src" }],
      ["c3", "find", { glob: "**/*.test.ts" }],
    ]),
    t("c1", "export function wrap(s: string) {\n  return s;\n}"),
    t("c2", "src/wrap.ts:1:export function wrap(s: string) {"),
    t("c3", "test/wrap.test.ts"),
    a([
      ["c4", "bash", { command: "pnpm test" }],
      ["c5", "read", { path: "src/missing.ts" }],
    ]),
    t("c4", "stdout:\n1 failed\nexit code 1"),
    t("c5", "error: ENOENT: no such file or directory, open 'src/missing.ts'"),
    a([
      ["c6", "read", { path: "src/wrap.ts" }],
      ["c7", "bash", { command: "  git status  " }],
      ["c8", "bash", { command: "rm -rf /" }],
      ["c9", "propose_run", { task: "fix wrap" }],
    ]),
    t("c6", "export function wrap(s: string) {\n  return s;\n}"),
    t("c7", "stdout:\n## main\nexit code 0"),
    t("c8", "command not allowed: rm -rf / is denied by policy"),
    t("c9", "Proposal recorded. The user will be asked to confirm the run."),
    { role: "assistant", content: "[propose_run recorded: the user was asked to confirm the run]" },
    { role: "user", content: "and run the tests again" },
    a([
      ["c10", "bash", { command: "git status" }],
      ["c11", "bash", { command: "pnpm test" }],
      ["c12", "grep", { pattern: "x" }],
      ["c13", "skill", { name: "nope" }],
    ]),
    t("c10", "stdout:\n## main\nexit code 0"),
    t("c11", "stdout:\nall passed\nexit code 0"),
    t("c12", "src/x.ts:1:x"),
    t("c13", "unknown skill. Available skills: tdd"),
    // A call the loop never answered (turn limit) produces nothing.
    a([["c14", "read", { path: "src/never.ts" }]]),
    { role: "assistant", content: "done" },
  ];
}

describe("observe", () => {
  test("files, commands, runs and errors from a realistic history", () => {
    const runs = [
      { runId: "20260101-000000-abcdef", status: "verified", reportPath: ".rewire/runs/x/r.md" },
    ];
    const o = observe(fixture(), { runs });
    expect(o.files).toEqual([
      { path: "src/wrap.ts", reads: 2 },
      { path: "src", reads: 1 },
      { path: "**/*.test.ts", reads: 1 },
    ]);
    expect(o.commands).toEqual([
      { cmd: "pnpm test", exit: 0, count: 2 },
      { cmd: "git status", exit: 0, count: 2 },
    ]);
    expect(o.runs).toEqual(runs);
    expect(o.errors).toEqual([
      { tool: "read", message: "error: ENOENT: no such file or directory, open 'src/missing.ts'" },
      { tool: "bash", message: "command not allowed: rm -rf / is denied by policy" },
      { tool: "skill", message: "unknown skill. Available skills: tdd" },
    ]);
  });

  test("pure and deterministic: same input, same output; the input is not mutated", () => {
    const h = fixture();
    const copy = structuredClone(h);
    expect(observe(h)).toEqual(observe(h));
    expect(h).toEqual(copy);
    expect(observe([])).toEqual(observed());
  });

  test("a bash result whose exit line was cut off records the command with exit null", () => {
    const o = observe([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "b", name: "bash", arguments: { command: "yes | head -c 9999999" } }],
      },
      { role: "tool", toolCallId: "b", content: "stdout:\ny\ny\n[truncated 123 bytes]" },
    ]);
    expect(o.commands).toEqual([{ cmd: "yes | head -c 9999999", exit: null, count: 1 }]);
    expect(o.errors).toEqual([]);
  });

  test("caps: files 200, commands 100, errors 50, keeping the most recent", () => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 260; i++) {
      h.push({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `r${i}`, name: "read", arguments: { path: `f${i}` } },
          { id: `b${i}`, name: "bash", arguments: { command: `echo ${i}` } },
          { id: `e${i}`, name: "read", arguments: {} },
        ],
      });
      h.push({ role: "tool", toolCallId: `r${i}`, content: "x" });
      h.push({ role: "tool", toolCallId: `b${i}`, content: "exit code 0" });
      h.push({ role: "tool", toolCallId: `e${i}`, content: "path is required" });
    }
    const o = observe(h);
    expect(o.files).toHaveLength(200);
    expect(o.files[0]?.path).toBe("f60");
    expect(o.files.at(-1)?.path).toBe("f259");
    expect(o.commands).toHaveLength(100);
    expect(o.commands[0]?.cmd).toBe("echo 160");
    expect(o.errors).toHaveLength(50);
  });

  test("commands are cut to 200 chars and error messages are capped", () => {
    const long = `echo ${"a".repeat(400)}`;
    const o = observe([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "b", name: "bash", arguments: { command: long } },
          { id: "r", name: "read", arguments: { path: "x" } },
        ],
      },
      { role: "tool", toolCallId: "b", content: "exit code 0" },
      { role: "tool", toolCallId: "r", content: `error: ${"z".repeat(1000)}` },
    ]);
    expect(o.commands[0]?.cmd).toBe(long.slice(0, 200));
    expect(o.errors[0]?.message.length).toBeLessThanOrEqual(300);
    expect(SessionRecord.safeParse(record({ observed: o })).success).toBe(true);
  });

  test("hostile strings are cleaned (sanitize, then redact) before they are stored", () => {
    const esc = "\u001b[31m";
    const osc = "\u001b]8;;http://evil\u0007";
    const bidi = "‮";
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const o = observe([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "b", name: "bash", arguments: { command: `${esc}echo ${key}${osc}${bidi}` } },
          { id: "r", name: "read", arguments: { path: `src/${bidi}${esc}evil.ts` } },
          { id: "e", name: "read", arguments: { path: "y" } },
        ],
      },
      { role: "tool", toolCallId: "b", content: "exit code 0" },
      { role: "tool", toolCallId: "r", content: "x" },
      { role: "tool", toolCallId: "e", content: `error: ${osc}${key}${esc}${bidi}` },
    ]);
    const all = JSON.stringify(o);
    for (const bad of ["\\u001b", "\u001b", "\u0007", "\u202e"]) expect(all).not.toContain(bad);
    expect(all).not.toContain("sk-ant-");
    expect(o.commands[0]?.cmd).toBe("echo [redacted]");
    expect(o.files[0]?.path).toBe("src/evil.ts");
    expect(o.errors[0]?.message).toBe("error: [redacted]");
  });

  test("a bash failure without an exit line (the tool did not run) is an error, not a command", () => {
    const o = observe([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "b", name: "bash", arguments: { command: "sleep 1 &" } },
          { id: "u", name: "nope", arguments: {} },
          { id: "x", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "b",
        content: "sandbox_escape: x (the action did not complete)",
      },
      { role: "tool", toolCallId: "u", content: 'Unknown tool "nope". Available: read, bash' },
      { role: "tool", toolCallId: "x", content: 'Tool call "bash" was not executed: run aborted.' },
    ]);
    expect(o.commands).toEqual([]);
    expect(o.errors.map((e) => e.tool)).toEqual(["bash", "nope", "bash"]);
  });

  test("file contents that merely look like an error line in a multi-line read are not errors", () => {
    const o = observe([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "r", name: "read", arguments: { path: "a.yaml" } }],
      },
      { role: "tool", toolCallId: "r", content: "some_key: 1\nother: 2" },
    ]);
    expect(o.errors).toEqual([]);
    expect(o.files).toEqual([{ path: "a.yaml", reads: 1 }]);
  });
});

describe("renderRecord", () => {
  const full = (): SessionRecordT =>
    record({
      items: [
        item({ id: "n1", kind: "note", source: "inferred", text: "note one", evidence: undefined }),
        item({ id: "q1", kind: "open_question", text: "which runner?", evidence: undefined }),
        item({
          id: "c1",
          kind: "constraint",
          text: "keep the public API",
          reason: "downstream users",
          evidence: [
            { messageId: "m12", quote: "keep the API" },
            { messageId: "m14", quote: "API" },
          ],
        }),
        item({ id: "g1", kind: "goal", text: "fix wrap" }),
        item({ id: "p1", kind: "preserve", text: "tests pass", evidence: undefined }),
        item({
          id: "d1",
          kind: "decision",
          source: "inferred",
          text: "patch in place",
          evidence: undefined,
        }),
        item({ id: "pr1", kind: "preference", text: "small commits" }),
        item({ id: "s1", kind: "next_step", source: "inferred", text: "run tests" }),
        item({ id: "x1", kind: "goal", text: "old goal", status: "resolved" }),
      ],
      observed: observed({
        files: [{ path: "src/a.ts", reads: 2, writes: 1 }],
        commands: [{ cmd: "pnpm test", exit: 1, count: 3 }],
        runs: [{ runId: "R1", status: "escalated", reportPath: "r.md" }],
        errors: [{ tool: "read", message: "error: ENOENT" }],
      }),
      archive: [item({ id: "a1", kind: "goal", text: "ARCHIVED-SECRET" })],
    });

  test("sections in order, tags with evidence ids, only active items, never the archive", () => {
    const { text, overBudget, dropped } = renderRecord(full(), 10_000);
    expect(overBudget).toBe(false);
    expect(dropped).toEqual({ observed: 0, notes: 0, inferred: 0 });
    expect(text).toBe(
      [
        "## Goal",
        "- [user m0] fix wrap",
        "",
        "## Constraints & must-keep-working",
        "- [user m12 m14] keep the public API — downstream users",
        "- [user] tests pass",
        "",
        "## Decisions",
        "- [inferred] patch in place",
        "",
        "## Open questions",
        "- [user] which runner?",
        "",
        "## Preferences",
        "- [user m0] small commits",
        "",
        "## Next step",
        "- [inferred m0] run tests",
        "",
        "## Notes",
        "- [inferred] note one",
        "",
        "## Observed",
        "- file src/a.ts (read 2, written 1)",
        "- command `pnpm test` (exit 1, ×3)",
        "- run R1 escalated (r.md)",
        "- error read: error: ENOENT",
      ].join("\n"),
    );
    expect(text).not.toContain("ARCHIVED-SECRET");
    expect(text).not.toContain("old goal");
    // Stable: same record, same text.
    expect(renderRecord(full(), 10_000).text).toBe(text);
  });

  test("an empty record renders to nothing", () => {
    expect(renderRecord(emptyRecord(), 100)).toEqual({
      text: "",
      overBudget: false,
      dropped: { observed: 0, notes: 0, inferred: 0 },
    });
  });

  test("the budget drops observed entries oldest first, then inferred notes, then other inferred items", () => {
    const r = record({
      items: [
        item({ id: "u1", kind: "constraint", text: "USER-ONE" }),
        item({ id: "n1", kind: "note", source: "inferred", text: "NOTE-OLD" }),
        item({ id: "i1", kind: "decision", source: "inferred", text: "INFERRED-OLD" }),
        item({ id: "n2", kind: "note", source: "inferred", text: "NOTE-NEW" }),
        item({ id: "i2", kind: "decision", source: "inferred", text: "INFERRED-NEW" }),
      ],
      observed: observed({
        files: [
          { path: "FILE-OLD", reads: 1 },
          { path: "FILE-NEW", reads: 1 },
        ],
        commands: [
          { cmd: "CMD-OLD", exit: 0, count: 1 },
          { cmd: "CMD-NEW", exit: 0, count: 1 },
        ],
      }),
    });
    const fullText = renderRecord(r, 100_000).text;
    const tokens = (s: string): number => Math.ceil(s.length / 4);

    // Just under the full size: the oldest observed entries go first.
    const one = renderRecord(r, tokens(fullText) - 1);
    expect(one.overBudget).toBe(false);
    expect(one.dropped.observed).toBeGreaterThan(0);
    expect(one.text).not.toContain("FILE-OLD");
    expect(one.text).toContain("INFERRED-OLD");
    expect(tokens(one.text)).toBeLessThanOrEqual(tokens(fullText) - 1);

    // Without observed: notes go (oldest first) before other inferred items.
    const noObs = record({ ...r, observed: observed() });
    const noObsText = renderRecord(noObs, 100_000).text;
    const two = renderRecord(r, tokens(noObsText) - 1);
    expect(two.dropped.observed).toBe(4);
    expect(two.text).not.toContain("## Observed");
    expect(two.text).not.toContain("NOTE-OLD");
    expect(two.text).toContain("INFERRED-OLD");

    // Down to the user item: every inferred item is gone, the user item stays.
    const three = renderRecord(
      r,
      tokens("## Constraints & must-keep-working\n- [user m0] USER-ONE"),
    );
    expect(three.overBudget).toBe(false);
    expect(three.dropped).toEqual({ observed: 4, notes: 2, inferred: 2 });
    expect(three.text).toBe("## Constraints & must-keep-working\n- [user m0] USER-ONE");
  });

  test("user items are never dropped: over budget, all are rendered and overBudget is set", () => {
    const users = Array.from({ length: 30 }, (_, i) =>
      item({ id: `u${i}`, kind: "constraint", text: `user constraint ${i} ${"x".repeat(100)}` }),
    );
    const r = record({
      items: [...users, item({ id: "i", kind: "note", source: "inferred", text: "drop me" })],
      observed: observed({ files: [{ path: "a", reads: 1 }] }),
    });
    const out = renderRecord(r, 50);
    expect(out.overBudget).toBe(true);
    for (let i = 0; i < 30; i++) expect(out.text).toContain(`user constraint ${i} `);
    expect(out.text).not.toContain("drop me");
    expect(out.dropped).toEqual({ observed: 1, notes: 1, inferred: 0 });
  });

  test("hostile item text is rendered as-is (items are cleaned when applied, Task 4)", () => {
    const hostile = "\u001b]8;;http://x\u0007click‮ sk-ant-api03-zzzzzzzzzzzzzzzzzzzz";
    const out = renderRecord(record({ items: [item({ text: hostile })] }), 1000);
    expect(out.text).toContain(hostile);
  });
});
