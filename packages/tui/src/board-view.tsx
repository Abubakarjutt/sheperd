import type { RunEvent } from "@rewire/core";
import type { PendingPrompt, RunHandle } from "@rewire/session";
import { Box } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  type BoardState,
  initialBoard,
  reduceBoard,
  STAGES,
  type StageStatus,
  withCheckpoint,
} from "./board.js";
import { CheckpointPanel, type CheckpointPrompt } from "./checkpoint.js";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** Mirrors the pipeline's MAX_REVISIONS (orchestrator.ts): the 4th revise is treated as stop. */
const MAX_REVISIONS = 3;

const GLYPH: Record<StageStatus, string> = { pending: "○", running: "◐", done: "✓", failed: "✗" };
const COLOR: Record<StageStatus, string | undefined> = {
  pending: theme.dim,
  running: theme.busy,
  done: "green",
  failed: theme.error,
};

/** The stage board: one line per stage, each cut to the terminal width. */
export function Board({ state }: { state: BoardState }) {
  const cols = useColumns();
  const label = Math.max(...STAGES.map((s) => s.length));
  return (
    <Box flexDirection="column">
      {STAGES.map((name) => {
        const r = state.rows[name];
        const line = `${GLYPH[r.status]} ${name.padEnd(label)}${r.detail ? `  ${r.detail}` : ""}`;
        return (
          <Safe key={name} wrap="truncate" color={COLOR[r.status]}>
            {fit(line, cols)}
          </Safe>
        );
      })}
      {state.ended === "escalated" ? (
        <Safe color={theme.error}>{fit("run escalated", cols)}</Safe>
      ) : null}
    </Box>
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
}: {
  run: RunHandle;
  onDone?: (outcome: RunDone) => void;
  onPending?: (p: PendingPrompt | undefined) => void;
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
