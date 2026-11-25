import { CHECKPOINT_NOTE_MAX } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { useInput } from "ink";
import { type ReactElement, type ReactNode, useMemo, useRef, useState } from "react";
import { cleanView, DiffView, TestsView } from "./diff-view.js";
import { Card, cardInner, cutStyled, type Styled, StyledLine } from "./styled.js";
import { theme } from "./theme.js";
import { useColumns, useRows } from "./use-columns.js";

export type CheckpointPrompt = Extract<PendingPrompt, { kind: "checkpoint" }>;

export const NOTE_MAX = CHECKPOINT_NOTE_MAX;
const LIMIT = "revision limit reached; [a]pprove or [s]top";
/** Shown when a prompt was answered or replaced before this key arrived. */
export const STALE_PROMPT = "that prompt is no longer active";
/**
 * Screen rows outside the panel when none is given: the full board (8) and the status line.
 */
export const DEFAULT_OUTSIDE_ROWS = 9;
/** A card's lines besides its list: border (2), title, "… more", keys, revise box, message. */
const CARD_FIXED = 7;
/** A card's lines besides an open view's page: border (2), title, the view footer, keys, message. */
const VIEW_FIXED = 6;

/** Untrusted text made safe for display: capped, sanitized, then redacted. */
const clean = cleanView;

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
  /**
   * Screen rows used by everything else in the live frame (the board, the status line). Lists and
   * views are sized so the card plus these rows fit in the terminal's height.
   */
  outside?: number;
};

/**
 * Shows one checkpoint and takes its keys. Keys act only while `prompt` is the run's current
 * pending prompt; the revise box ignores everything but text, Enter and Esc.
 */
export function CheckpointPanel({
  run,
  prompt,
  revisionLimitReached = false,
  outside = DEFAULT_OUTSIDE_ROWS,
}: CheckpointPanelProps) {
  const cols = useColumns();
  const rows = useRows();
  const [mode, setMode] = useState<Mode>({ kind: "keys" });
  const [viewing, setViewing] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const modeRef = useRef<Mode>(mode);
  const cp = prompt.checkpoint;
  // Cleaning a 200 KB diff is not free: once per prompt, not on every key.
  const commitStat = useMemo(
    () => (cp.kind === "commit" ? diffStat(clean(cp.diff)) : undefined),
    [cp],
  );

  const setM = (m: Mode): void => {
    modeRef.current = m;
    setMode(m);
  };

  const send = (decision: Parameters<RunHandle["answer"]>[1]): void => {
    if (run.pending() !== prompt || !run.answer(prompt, decision)) setMessage(STALE_PROMPT);
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
      if (run.pending() !== prompt) setMessage(STALE_PROMPT);
      else if (revisionLimitReached) setMessage(LIMIT);
      else setM({ kind: "edit", value: "" });
    } else if (k === "v" && cp.kind !== "contract") setViewing((v) => !v);
  });

  const inner = cardInner(cols);
  const out: ReactElement[] = [];
  /** One card line of styled runs, cut to the card's content width. */
  const add = (key: string, segs: Styled[]): void => {
    out.push(<StyledLine key={key} segs={cutStyled(segs, inner)} />);
  };
  /** One cleaned, flattened line of untrusted text. */
  const one = (s: string): string => clean(s).replace(/[\n\t]+/g, " ");
  const hints = (keys: Array<[string, string]>): Styled[] =>
    keys.flatMap(([k, word], i) => [
      ...(i > 0 ? [{ text: " · ", dim: true }] : []),
      { text: k, bold: true, color: theme.user },
      { text: ` ${word}`, dim: true },
    ]);
  const isCurrent = (): boolean => run.pending() === prompt;
  const viewRows = Math.max(1, rows - VIEW_FIXED - outside);
  /** List lines (criteria, files) that fit; the rest are summed up in a "… more" line. */
  const cap = Math.max(1, Math.min(10, rows - CARD_FIXED - outside));
  const closeView = (): void => setViewing(false);
  let color: string;
  let body: ReactNode = null;

  if (cp.kind === "contract") {
    color = theme.accent;
    add("h", [{ text: one(`Contract checkpoint: ${cp.contract.title}`), bold: true, color }]);
    // Every criterion that fits: a contract is approved on all of them, so no fixed cap of 10.
    const ccap = Math.max(1, rows - CARD_FIXED - outside);
    cp.contract.criteria.slice(0, ccap).forEach((c, i) => {
      add(`c${i}`, [
        { text: `${one(c.id)} ` },
        { text: `[${c.kind}]`, color: c.kind === "change" ? theme.busy : theme.user },
        { text: ` ${one(c.statement)}` },
      ]);
    });
    if (cp.contract.criteria.length > ccap)
      add("cm", [
        {
          text: `  … ${cp.contract.criteria.length - ccap} more criteria (a taller terminal shows all)`,
          dim: true,
        },
      ]);
    if (revisionLimitReached) add("lim", [{ text: LIMIT, color: theme.busy }]);
    else
      add(
        "k",
        hints([
          ["a", "approve"],
          ["e", "revise"],
          ["s", "stop"],
        ]),
      );
  } else if (cp.kind === "tests") {
    color = theme.busy;
    add("h", [
      {
        text: `Tests checkpoint: ${cp.manifest.files.length} frozen test file(s)`,
        bold: true,
        color,
      },
    ]);
    if (viewing) {
      body = (
        <TestsView
          files={cp.files}
          width={inner}
          rows={viewRows}
          isActive={isCurrent}
          onClose={closeView}
        />
      );
    } else {
      cp.files.slice(0, cap).forEach((f, i) => {
        add(`f${i}`, [{ text: `  ${one(f.path)}` }]);
      });
      if (cp.files.length > cap)
        add("fm", [{ text: `  … ${cp.files.length - cap} more`, dim: true }]);
    }
  } else {
    color = "green";
    const stat = commitStat ?? { files: [] };
    add("h", [
      { text: `Commit checkpoint: ${stat.files.length} file(s) changed`, bold: true, color },
    ]);
    if (viewing) {
      body = (
        <DiffView
          diff={cp.diff}
          width={inner}
          rows={viewRows}
          isActive={isCurrent}
          onClose={closeView}
        />
      );
    } else {
      stat.files.slice(0, cap).forEach((f, i) => {
        const path = f.path.replace(/[\n\t]+/g, " ");
        add(
          `d${i}`,
          f.binary
            ? [{ text: `  ${path}  ` }, { text: "binary, omitted", dim: true }]
            : [
                { text: `  ${path}  ` },
                { text: `+${f.added}`, color: "green" },
                { text: " " },
                { text: `−${f.removed}`, color: "red" },
              ],
        );
      });
      if (stat.files.length > cap)
        add("dm", [{ text: `  … ${stat.files.length - cap} more`, dim: true }]);
    }
  }
  const tail: ReactElement[] = [];
  const addTail = (key: string, segs: Styled[]): void => {
    tail.push(<StyledLine key={key} segs={cutStyled(segs, inner)} />);
  };
  if (cp.kind !== "contract")
    addTail(
      "k",
      hints([
        ["a", "approve"],
        ["v", "view"],
        ["s", "stop"],
      ]),
    );
  if (mode.kind === "edit") {
    addTail("e", [{ text: one(`revise: ${mode.value}▌  (Enter sends, Esc cancels)`) }]);
  }
  if (message) addTail("m", [{ text: one(message), color: theme.error }]);
  return (
    <Card color={color} cols={cols}>
      {out}
      {body}
      {tail}
    </Card>
  );
}
