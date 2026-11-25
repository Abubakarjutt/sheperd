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
          <Safe key={name} color={COLOR[r.status]}>
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

/** Folds a run's events into a board and shows the pending checkpoint, if any. */
export function RunView({ run, onDone }: { run: RunHandle; onDone?: () => void }) {
  const [board, setBoard] = useState(initialBoard);
  const [pending, setPending] = useState<PendingPrompt | undefined>(() => run.pending());

  const last = useRef<PendingPrompt | undefined>(undefined);
  useEffect(() => {
    let live = true;
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
    run.done.then(
      () => live && onDone?.(),
      () => live && onDone?.(),
    );
    // Prompts have no event of their own, so poll.
    const sync = (): void => {
      const p = run.pending();
      if (p === last.current) return;
      last.current = p;
      setPending(p);
      if (isCheckpoint(p)) setBoard((b) => withFacts(b, p));
    };
    sync();
    const t = setInterval(sync, 50);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [run, onDone]);

  return (
    <Box flexDirection="column">
      <Board state={board} />
      {isCheckpoint(pending) ? <CheckpointPanel run={run} prompt={pending} /> : null}
    </Box>
  );
}
