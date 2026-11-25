import { redact } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { Box, useInput } from "ink";
import { type ReactElement, useRef, useState } from "react";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { sanitize } from "./sanitize.js";
import { theme } from "./theme.js";
import { useColumns, useRows } from "./use-columns.js";

export type CheckpointPrompt = Extract<PendingPrompt, { kind: "checkpoint" }>;

export const NOTE_MAX = 2000;
const LIMIT = "revision limit reached; [a]pprove or [s]top";
const STALE = "that prompt is no longer active";
/** Content shown by `[v]iew` and the diff are cut here before processing; sanitize copes with a split escape. */
const MAX_TEXT = 200_000;

/** Untrusted text made safe for display: sanitized first, then redacted. */
const clean = (s: string): string => redact(sanitize(s.slice(0, MAX_TEXT)));

export type DiffStat = {
  files: Array<{ path: string; added: number; removed: number; binary: boolean }>;
};

/** File list and +/- counts from a (cleaned) unified diff, including `binary file omitted:` lines. */
export function diffStat(diff: string): DiffStat {
  const files: DiffStat["files"] = [];
  let cur: DiffStat["files"][number] | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), added: 0, removed: 0, binary: false };
      files.push(cur);
      inHunk = false;
    } else if (line.startsWith("binary file omitted: ")) {
      files.push({
        path: line.slice("binary file omitted: ".length),
        added: 0,
        removed: 0,
        binary: true,
      });
      cur = undefined;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (cur && inHunk) {
      if (line.startsWith("+")) cur.added++;
      else if (line.startsWith("-")) cur.removed++;
    }
  }
  return { files };
}

type Mode = { kind: "keys" } | { kind: "edit"; value: string };

export type CheckpointPanelProps = {
  run: Pick<RunHandle, "answer" | "pending">;
  prompt: CheckpointPrompt;
  /** True once the contract has been revised the pipeline's maximum (3) times: a further revise stops the run. */
  revisionLimitReached?: boolean;
};

/**
 * Shows one checkpoint and takes its keys. Keys act only while `prompt` is the run's current
 * pending prompt; the revise box ignores everything but text, Enter and Esc.
 */
export function CheckpointPanel({
  run,
  prompt,
  revisionLimitReached = false,
}: CheckpointPanelProps) {
  const cols = useColumns();
  const rows = useRows();
  const [mode, setMode] = useState<Mode>({ kind: "keys" });
  const [viewing, setViewing] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const modeRef = useRef<Mode>(mode);
  const cp = prompt.checkpoint;

  const setM = (m: Mode): void => {
    modeRef.current = m;
    setMode(m);
  };

  const send = (decision: Parameters<RunHandle["answer"]>[1]): void => {
    if (run.pending() !== prompt || !run.answer(prompt, decision)) setMessage(STALE);
    else setMessage(undefined);
  };

  useInput((input, key) => {
    const m = modeRef.current;
    if (m.kind === "edit") {
      if (key.escape) {
        setM({ kind: "keys" });
        setMessage(undefined);
      } else if (key.return) {
        const note = m.value.trim();
        if (note === "") setMessage("a revise note cannot be empty");
        else if (note.length > NOTE_MAX)
          setMessage(`revise note too long (${note.length} > ${NOTE_MAX} chars)`);
        else {
          setM({ kind: "keys" });
          send({ action: "revise", note });
        }
      } else if (key.backspace || key.delete) setM({ kind: "edit", value: m.value.slice(0, -1) });
      else if (!key.ctrl && !key.meta && !key.tab && input) {
        setM({ kind: "edit", value: m.value + input.replace(/[\r\n]+/g, " ") });
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    const k = input.toLowerCase();
    if (k === "a") send({ action: "approve" });
    else if (k === "s") send({ action: "stop" });
    else if (k === "e" && cp.kind === "contract") {
      if (run.pending() !== prompt) setMessage(STALE);
      else if (revisionLimitReached) setMessage(LIMIT);
      else setM({ kind: "edit", value: "" });
    } else if (k === "v" && cp.kind === "tests") setViewing((v) => !v);
  });

  const line = (
    text: string,
    props: { color?: string; bold?: boolean; dimColor?: boolean } = {},
  ) => (
    <Safe wrap="truncate" {...props}>
      {fit(clean(text), cols)}
    </Safe>
  );
  const out: ReactElement[] = [];
  const add = (key: string, el: ReactElement): void => {
    out.push(<Box key={key}>{el}</Box>);
  };

  if (cp.kind === "contract") {
    add("h", line(`Contract checkpoint: ${cp.contract.title}`, { bold: true }));
    cp.contract.criteria.forEach((c, i) => {
      add(`c${i}`, line(`  ${c.id} [${c.kind}] ${c.statement}`));
    });
    if (revisionLimitReached) add("lim", line(LIMIT, { color: theme.busy }));
    else add("k", line("[a]pprove [e]dit via chat [s]top", { color: theme.user }));
  } else if (cp.kind === "tests") {
    add(
      "h",
      line(`Tests checkpoint: ${cp.manifest.files.length} frozen test file(s)`, { bold: true }),
    );
    for (const [i, f] of cp.files.entries()) add(`f${i}`, line(`  ${f.path}`));
    if (viewing) {
      const budget = Math.max(3, Math.min(20, rows - 10));
      const lines: string[] = [];
      for (const f of cp.files) {
        lines.push(`--- ${f.path}`, ...clean(f.content).split("\n"));
        if (lines.length > budget) break;
      }
      lines.slice(0, budget).forEach((l, i) => {
        add(`v${i}`, line(l, { dimColor: true }));
      });
      if (lines.length > budget)
        add(
          "vm",
          line("… (truncated; the full tests are frozen in the worktree)", { dimColor: true }),
        );
    }
    add("k", line("[a]pprove [v]iew [s]top", { color: theme.user }));
  } else {
    const stat = diffStat(clean(cp.diff));
    add("h", line(`Commit checkpoint: ${stat.files.length} file(s) changed`, { bold: true }));
    const cap = Math.max(3, Math.min(10, rows - 10));
    stat.files.slice(0, cap).forEach((f, i) => {
      add(
        `d${i}`,
        line(`  ${f.path} ${f.binary ? "(binary, omitted)" : `+${f.added} -${f.removed}`}`),
      );
    });
    if (stat.files.length > cap)
      add("dm", line(`  … ${stat.files.length - cap} more`, { dimColor: true }));
    add("k", line("[a]pprove [s]top", { color: theme.user }));
  }

  if (mode.kind === "edit") {
    add("e", line(`revise: ${mode.value}▌  (Enter sends, Esc cancels)`));
  }
  if (message) add("m", line(message, { color: theme.error }));
  return <Box flexDirection="column">{out}</Box>;
}
