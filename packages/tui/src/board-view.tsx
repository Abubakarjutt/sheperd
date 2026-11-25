import { MAX_REVISIONS, type RunEvent, redact } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { Box } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  type BoardState,
  currentStage,
  initialBoard,
  reduceBoard,
  STAGES,
  type StageStatus,
  withCheckpoint,
} from "./board.js";
import { CheckpointPanel, type CheckpointPrompt } from "./checkpoint.js";
import { sanitize } from "./sanitize.js";
import { SPINNER_GLYPHS, SPINNER_TICK_MS } from "./spinner.js";
import { Card, cardInner, cutStyled, type Styled, StyledLine } from "./styled.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

const GLYPH: Record<Exclude<StageStatus, "running">, string> = {
  pending: "○",
  done: "✓",
  failed: "✗",
};
const COLOR: Record<StageStatus, string | undefined> = {
  pending: theme.dim,
  running: theme.busy,
  done: "green",
  failed: theme.error,
};

/** Untrusted detail text: sanitized, redacted, then folded onto one line. */
const oneLine = (s: string): string => redact(sanitize(s)).replace(/[\n\t]+/g, " ");

/**
 * The stage board, in a round-bordered card: one line per stage (a status glyph, with a spinner
 * while running, the stage name and its dim detail), each cut to the terminal width.
 */
export function Board({ state }: { state: BoardState }) {
  const cols = useColumns();
  const inner = cardInner(cols);
  const label = Math.max(...STAGES.map((s) => s.length));
  const running = STAGES.some((s) => state.rows[s].status === "running");
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_GLYPHS.length), SPINNER_TICK_MS);
    return () => clearInterval(t);
  }, [running]);
  return (
    <Card color={theme.border} cols={cols}>
      {STAGES.map((name) => {
        const r = state.rows[name];
        const glyph =
          r.status === "running" ? (SPINNER_GLYPHS[frame] ?? SPINNER_GLYPHS[0]) : GLYPH[r.status];
        const segs: Styled[] = [
          { text: glyph, color: COLOR[r.status] },
          { text: ` ${name.padEnd(label)}`, ...(r.status === "pending" ? { dim: true } : {}) },
        ];
        if (r.detail) segs.push({ text: `  ${oneLine(r.detail)}`, dim: true });
        return <StyledLine key={name} segs={cutStyled(segs, inner)} />;
      })}
      {state.ended === "escalated" ? (
        <StyledLine segs={cutStyled([{ text: "run escalated", color: theme.error }], inner)} />
      ) : null}
    </Card>
  );
}

function isCheckpoint(p: PendingPrompt | undefined): p is CheckpointPrompt {
  return p?.kind === "checkpoint";
}

function withFacts(b: BoardState, p: CheckpointPrompt): BoardState {
  const cp = p.checkpoint;
  if (cp.kind === "contract") {
    const changes = cp.contract.criteria.filter((c) => c.kind === "change").length;
    return withCheckpoint(b, {
      kind: "contract",
      changes,
      preserves: cp.contract.criteria.length - changes,
    });
  }
  if (cp.kind === "tests")
    return withCheckpoint(b, { kind: "tests", files: cp.manifest.files.length });
  return b;
}

/** What `RunHandle.done` resolves with. */
export type RunDone = Awaited<RunHandle["done"]>;

/**
 * Folds a run's events into a board and shows the pending checkpoint, if any. `onPending` hears
 * every change of the pending prompt (the App routes clarifications to the input box).
 */
export function RunView({
  run,
  onDone,
  onPending,
  onStage,
}: {
  run: RunHandle;
  onDone?: (outcome: RunDone) => void;
  onPending?: (p: PendingPrompt | undefined) => void;
  /** Hears the current stage ({@link currentStage}) whenever it changes (the status line). */
  onStage?: (stage: string | undefined) => void;
}) {
  const [board, setBoard] = useState(initialBoard);
  const [pending, setPending] = useState<PendingPrompt | undefined>(undefined);
  // Remounts the panel for each new prompt, so its message/edit state never carries over.
  const [promptKey, setPromptKey] = useState(0);
  const last = useRef<PendingPrompt | undefined>(undefined);
  // Held in a ref so an inline callback never restarts the effect (a restart replays the events).
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const pendingRef = useRef(onPending);
  pendingRef.current = onPending;
  const stageRef = useRef(onStage);
  stageRef.current = onStage;
  const stage = currentStage(board);
  useEffect(() => {
    stageRef.current?.(stage);
  }, [stage]);

  useEffect(() => {
    let live = true;
    // `events` replays from the start, so a new handle (or a restart) begins from a clean board.
    setBoard(initialBoard());
    setPending(undefined);
    last.current = undefined;
    (async () => {
      try {
        for await (const e of run.events as AsyncIterable<RunEvent>) {
          if (!live) return;
          setBoard((b) => reduceBoard(b, e));
        }
      } catch {
        // the stream ended abnormally; `done` carries the outcome
      }
    })();
    // Prompts have no event of their own, so poll until the run is done.
    const sync = (): void => {
      const p = run.pending();
      if (p === last.current) return;
      last.current = p;
      setPending(p);
      pendingRef.current?.(p);
      if (p) setPromptKey((k) => k + 1);
      if (isCheckpoint(p)) setBoard((b) => withFacts(b, p));
    };
    sync();
    const t = setInterval(sync, 50);
    run.done.then(
      (o) => {
        clearInterval(t);
        if (live) doneRef.current?.(o);
      },
      () => clearInterval(t),
    );
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [run]);

  return (
    <Box flexDirection="column">
      <Board state={board} />
      {isCheckpoint(pending) ? (
        <CheckpointPanel
          key={promptKey}
          run={run}
          prompt={pending}
          revisionLimitReached={board.revisions >= MAX_REVISIONS}
        />
      ) : null}
    </Box>
  );
}
