import { redact, sanitizeTerminal } from "@rewire/core";
import type { ChatMessage } from "@rewire/providers";
import { z } from "zod";

/**
 * The structured session record: what a compacted chat keeps instead of a lossy summary.
 *
 * Items are written by the compactor (Task 4), which cleans every string (sanitize, then redact)
 * when it applies an operation; `renderRecord` therefore renders item text as-is. `observed` is
 * computed by code (`observe`), never by the model, and cleans its own entries. The rendered
 * text is untrusted: the caller fences it (`untrusted_session_record`).
 */

export const TEXT_MAX = 500;
export const QUOTE_MAX = 300;
export const EVIDENCE_MAX = 5;
export const ACTIVE_ITEMS_MAX = 200;
export const FILES_MAX = 200;
export const COMMANDS_MAX = 100;
export const ERRORS_MAX = 50;
export const CMD_MAX = 200;
export const PATH_MAX = 500;
export const ERROR_MESSAGE_MAX = 300;

/** A stored message's stable id (`m<n>`, assigned by `SessionStore`). */
export const MessageId = z.string().regex(/^m(?:0|[1-9]\d*)$/);

export const ITEM_KINDS = [
  "goal",
  "constraint",
  "preserve",
  "decision",
  "open_question",
  "preference",
  "next_step",
  "note",
] as const;

export const Evidence = z
  .object({ messageId: MessageId, quote: z.string().min(1).max(QUOTE_MAX) })
  .strict();

export const RecordItem = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(ITEM_KINDS),
    text: z.string().min(1).max(TEXT_MAX),
    reason: z.string().max(TEXT_MAX).optional(),
    source: z.enum(["user", "inferred"]),
    evidence: z.array(Evidence).max(EVIDENCE_MAX).optional(),
    status: z.enum(["active", "resolved", "superseded"]),
    supersededBy: z.string().min(1).max(64).optional(),
    createdAt: MessageId,
    updatedAt: MessageId,
  })
  .strict();
export type RecordItem = z.infer<typeof RecordItem>;

export const Observed = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().max(PATH_MAX),
            reads: z.number().int().nonnegative(),
            writes: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(FILES_MAX),
    commands: z
      .array(
        z
          .object({
            cmd: z.string().max(CMD_MAX),
            /** null when the result's exit line was cut off (truncated output). */
            exit: z.number().int().nullable(),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(COMMANDS_MAX),
    runs: z.array(
      z.object({ runId: z.string(), status: z.string(), reportPath: z.string() }).strict(),
    ),
    errors: z
      .array(
        z.object({ tool: z.string().max(64), message: z.string().max(ERROR_MESSAGE_MAX) }).strict(),
      )
      .max(ERRORS_MAX),
  })
  .strict();
export type Observed = z.infer<typeof Observed>;
export type ObservedRun = Observed["runs"][number];

export const SessionRecord = z
  .object({
    version: z.literal(1),
    items: z.array(RecordItem),
    observed: Observed,
    /** Resolved and superseded items. Unbounded; never rendered (reachable through recall). */
    archive: z.array(RecordItem),
    /** How many compactions produced this record. */
    compactions: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const active = r.items.filter((i) => i.status === "active").length;
    if (active > ACTIVE_ITEMS_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `at most ${ACTIVE_ITEMS_MAX} active items (got ${active})`,
      });
    }
    const seen = new Set<string>();
    for (const i of [...r.items, ...r.archive]) {
      if (seen.has(i.id)) {
        ctx.addIssue({ code: "custom", path: ["items"], message: `duplicate item id ${i.id}` });
      }
      seen.add(i.id);
    }
  });
export type SessionRecord = z.infer<typeof SessionRecord>;

export function emptyRecord(): SessionRecord {
  return {
    version: 1,
    items: [],
    observed: { files: [], commands: [], runs: [], errors: [] },
    archive: [],
    compactions: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------------------------

const clean = (s: string): string => redact(sanitizeTerminal(s));

/** The bash tool's last line (`packages/tools/src/bash.ts`); capOutput keeps the tail. */
const EXIT_LINE = /(?:^|\n)exit code (-?\d+)$/;

/**
 * Stored tool results carry no `isError` (the loop keeps only the content), so failures are
 * recognised by the exact shapes the loop, tools, skills and propose_run produce. Matched on the
 * first line of the result.
 */
const ERROR_FIRST_LINE: RegExp[] = [
  /^Tool call "[^"]*" was not executed: /, // loop: aborted or truncated arguments
  /^Unknown tool "/, // loop
  /^Invalid arguments for tool "/, // loop
  /^Tool \S+ failed: /, // loop: a tool threw
  /^rg failed \(exit code /, // grep, find
  /^\S+ is unavailable: ripgrep/, // grep, find
  /^(?:path|pattern|glob|command|old_string|content) is required$/, // tools
  /^command not allowed: /, // bash policy pre-check
  /^background processes are not allowed: /, // bash
  / is protected \(rule [^)]*\) in stage /, // tools: path_protected
  /^unknown skill\. /, // skill
  /^propose_run needs a non-empty task$/,
  /^the task is too long \(max /,
  /^the task contains control characters /,
  /^a run was already proposed in this turn$/,
];

/**
 * `errorResult` shapes (`<snake_case code>: msg` and `error: msg`). Only a one-line result counts:
 * a multi-line read of a file that starts with `some_key: 1` is file content, not an error. A
 * one-line file of that exact shape is a known false positive (it only adds an error entry).
 */
const ERROR_ONE_LINE = /^(?:error|[a-z][a-z0-9]*(?:_[a-z0-9]+)+): /;

function isErrorResult(content: string, isError: unknown): boolean {
  if (isError === true) return true;
  const first = content.split("\n", 1)[0] ?? "";
  if (ERROR_FIRST_LINE.some((re) => re.test(first))) return true;
  return !content.includes("\n") && ERROR_ONE_LINE.test(content);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The path-like argument of a reading tool: read `path`, grep `path` (when given), find `glob`. */
function pathArg(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "read" || tool === "grep") return str(args.path);
  if (tool === "find") return str(args.glob);
  return undefined;
}

/** Keep the `max` entries touched most recently, in first-seen order. */
function keepRecent<T>(entries: { value: T; last: number }[], max: number): T[] {
  if (entries.length <= max) return entries.map((e) => e.value);
  const cut = [...entries].sort((a, b) => b.last - a.last)[max - 1]?.last ?? 0;
  return entries.filter((e) => e.last >= cut).map((e) => e.value);
}

/**
 * Facts computed by code from stored messages: files read (read/grep/find arguments), bash
 * commands with their latest exit code and count, tool errors, and the given run outcomes
 * (`propose_run` itself records nothing: a run is a fact only once it has an outcome). Pure and
 * deterministic. Every stored string is sanitized, then redacted. A call with no stored result
 * (the turn ended first) records nothing.
 */
export function observe(
  messages: readonly ChatMessage[],
  opts: { runs?: readonly ObservedRun[] } = {},
): Observed {
  const results = new Map<string, { content: string; isError: unknown }>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId !== undefined && !results.has(m.toolCallId)) {
      results.set(m.toolCallId, {
        content: m.content,
        isError: (m as { isError?: unknown }).isError,
      });
    }
  }

  let tick = 0;
  const files = new Map<string, { value: Observed["files"][number]; last: number }>();
  const commands = new Map<string, { value: Observed["commands"][number]; last: number }>();
  const errors: Observed["errors"] = [];

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      const result = results.get(call.id);
      if (result === undefined) continue;
      tick++;
      const tool = call.name;
      const args = call.arguments ?? {};
      const exit = tool === "bash" ? EXIT_LINE.exec(result.content) : null;
      const failed = exit === null && isErrorResult(result.content, result.isError);

      if (tool === "bash" && !failed) {
        const cmd = clean(str(args.command) ?? "")
          .trim()
          .slice(0, CMD_MAX);
        const code = exit ? Number(exit[1]) : null;
        const prev = commands.get(cmd);
        if (prev) {
          prev.value.exit = code;
          prev.value.count++;
          prev.last = tick;
        } else {
          commands.set(cmd, { value: { cmd, exit: code, count: 1 }, last: tick });
        }
        continue;
      }
      if (failed) {
        const message = clean(result.content.split("\n", 1)[0] ?? "")
          .trim()
          .slice(0, ERROR_MESSAGE_MAX);
        errors.push({ tool: clean(tool).slice(0, 64), message });
        continue;
      }
      const raw = pathArg(tool, args);
      if (raw === undefined) continue;
      const path = clean(raw).trim().slice(0, PATH_MAX);
      if (path === "") continue;
      const prev = files.get(path);
      if (prev) {
        prev.value.reads++;
        prev.last = tick;
      } else {
        files.set(path, { value: { path, reads: 1 }, last: tick });
      }
    }
  }

  return {
    files: keepRecent([...files.values()], FILES_MAX),
    commands: keepRecent([...commands.values()], COMMANDS_MAX),
    runs: (opts.runs ?? []).map((r) => ({
      runId: clean(r.runId),
      status: clean(r.status),
      reportPath: clean(r.reportPath),
    })),
    errors: errors.slice(-ERRORS_MAX),
  };
}

// ---------------------------------------------------------------------------------------------
// renderRecord
// ---------------------------------------------------------------------------------------------

const SECTIONS: { title: string; kinds: RecordItem["kind"][] }[] = [
  { title: "Goal", kinds: ["goal"] },
  { title: "Constraints & must-keep-working", kinds: ["constraint", "preserve"] },
  { title: "Decisions", kinds: ["decision"] },
  { title: "Open questions", kinds: ["open_question"] },
  { title: "Preferences", kinds: ["preference"] },
  { title: "Next step", kinds: ["next_step"] },
  { title: "Notes", kinds: ["note"] },
];

export type RenderResult = {
  /** Compact Markdown; untrusted, so the caller fences it. Empty for an empty record. */
  text: string;
  /** True when the user items alone exceed the budget (they are all rendered anyway). */
  overBudget: boolean;
  /** Entries left out to fit the budget. */
  dropped: { observed: number; notes: number; inferred: number };
};

function itemLine(i: RecordItem): string {
  const ids = (i.evidence ?? []).map((e) => e.messageId);
  const tag = [i.source, ...ids].join(" ");
  return `- [${tag}] ${i.text}${i.reason ? ` — ${i.reason}` : ""}`;
}

type ObservedLine = { line: string; rank: number; order: number };

function observedLines(o: Observed): ObservedLine[] {
  const out: ObservedLine[] = [];
  const add = (lines: string[], order: number): void => {
    lines.forEach((line, i) => {
      out.push({ line, rank: i / lines.length, order });
    });
  };
  add(
    o.files.map(
      (f) =>
        `- file ${f.path} (read ${f.reads}${f.writes !== undefined ? `, written ${f.writes}` : ""})`,
    ),
    0,
  );
  add(
    o.commands.map((c) => `- command \`${c.cmd}\` (exit ${c.exit ?? "unknown"}, ×${c.count})`),
    1,
  );
  add(
    o.runs.map((r) => `- run ${r.runId} ${r.status} (${r.reportPath})`),
    2,
  );
  add(
    o.errors.map((e) => `- error ${e.tool}: ${e.message}`),
    3,
  );
  return out;
}

const tokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Render the active items as compact Markdown sections (Goal, Constraints & must-keep-working,
 * Decisions, Open questions, Preferences, Next step, Notes), then `## Observed`. Each item is
 * `- [<source> <evidence ids>] text — reason`. The archive is never rendered.
 *
 * To fit `budgetTokens` (chars / 4) entries are dropped in this order: observed entries oldest
 * first (interleaved across files, commands, runs and errors by their relative age), then
 * inferred notes oldest first, then the other inferred items oldest first. `user` items are
 * never dropped: when they alone exceed the budget they are all rendered and `overBudget` is set.
 */
export function renderRecord(record: SessionRecord, budgetTokens: number): RenderResult {
  const active = record.items.filter((i) => i.status === "active");
  const drop = new Set<RecordItem>();
  const obs = observedLines(record.observed);
  // Drop order for observed: oldest relative position first, ties by category.
  const obsOrder = obs
    .map((o, idx) => ({ ...o, idx }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((o) => o.idx);
  const dropObs = new Set<number>();

  const build = (): string => {
    const parts: string[] = [];
    for (const s of SECTIONS) {
      const lines = active.filter((i) => s.kinds.includes(i.kind) && !drop.has(i)).map(itemLine);
      if (lines.length > 0) parts.push(`## ${s.title}\n${lines.join("\n")}`);
    }
    const o = obs.filter((_, i) => !dropObs.has(i)).map((x) => x.line);
    if (o.length > 0) parts.push(`## Observed\n${o.join("\n")}`);
    return parts.join("\n\n");
  };

  const notes = active.filter((i) => i.source === "inferred" && i.kind === "note");
  const others = active.filter((i) => i.source === "inferred" && i.kind !== "note");
  const dropped = { observed: 0, notes: 0, inferred: 0 };
  let text = build();
  for (const idx of obsOrder) {
    if (tokens(text) <= budgetTokens) break;
    dropObs.add(idx);
    dropped.observed++;
    text = build();
  }
  for (const [list, key] of [
    [notes, "notes"],
    [others, "inferred"],
  ] as const) {
    for (const i of list) {
      if (tokens(text) <= budgetTokens) break;
      drop.add(i);
      dropped[key]++;
      text = build();
    }
  }
  return { text, overBudget: tokens(text) > budgetTokens, dropped };
}
