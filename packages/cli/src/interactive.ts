import { RewireError } from "@rewire/core";

/**
 * Ctrl-C in the interactive TUI: one pure state machine, fed by both Ink's Ctrl-C key (raw mode
 * turns the key into input, not SIGINT) and `process.on("SIGINT")` (a signal from outside, or a
 * press while no Ink tree holds raw mode).
 *
 * - a second press within {@link DOUBLE_PRESS_MS} of the previous one, in any state: exit 130;
 * - a run is active: abort the run (the TUI stays open);
 * - a chat turn is in flight: abort the turn (the TUI stays open);
 * - idle: exit 0.
 *
 * One physical press never counts twice: a press from the other source within
 * {@link SAME_PRESS_MS} of the previous press is the same press seen twice, and is ignored.
 */

/** A second press within this many ms of the previous press force-quits (exit 130). */
export const DOUBLE_PRESS_MS = 1000;
/** A press from the other source this close to the previous one is the same press. */
export const SAME_PRESS_MS = 50;

/** What a Ctrl-C would interrupt now. */
export type Activity = "run" | "turn" | "idle";
export type PressSource = "key" | "signal";
export type CtrlCAction =
  | { kind: "abort_run" }
  | { kind: "abort_turn" }
  | { kind: "exit"; code: 0 | 130 }
  | { kind: "duplicate" };
/** The previous counted press. */
export type CtrlCMemo = { at: number; source: PressSource } | undefined;

/** The pure transition: what this press does, and the memo for the next one. */
export function ctrlC(
  memo: CtrlCMemo,
  activity: Activity,
  source: PressSource,
  now: number,
): { action: CtrlCAction; memo: CtrlCMemo } {
  if (memo !== undefined) {
    const since = now - memo.at;
    if (memo.source !== source && since >= 0 && since < SAME_PRESS_MS) {
      return { action: { kind: "duplicate" }, memo };
    }
    if (since >= 0 && since <= DOUBLE_PRESS_MS) {
      return { action: { kind: "exit", code: 130 }, memo: { at: now, source } };
    }
  }
  const next = { at: now, source };
  if (activity === "run") return { action: { kind: "abort_run" }, memo: next };
  if (activity === "turn") return { action: { kind: "abort_turn" }, memo: next };
  return { action: { kind: "exit", code: 0 }, memo: next };
}

export type InterruptDeps = {
  activity: () => Activity;
  abortRun: () => void;
  abortTurn: () => void;
  exit: (code: 0 | 130) => void;
  /** Default `Date.now` (fake timers mock it). */
  now?: () => number;
};

/** Holds the memo and applies each press's action. */
export class Interrupter {
  private memo: CtrlCMemo;
  constructor(private readonly deps: InterruptDeps) {}

  press(source: PressSource): CtrlCAction {
    const r = ctrlC(this.memo, this.deps.activity(), source, (this.deps.now ?? Date.now)());
    this.memo = r.memo;
    const a = r.action;
    if (a.kind === "abort_run") this.deps.abortRun();
    else if (a.kind === "abort_turn") this.deps.abortTurn();
    else if (a.kind === "exit") this.deps.exit(a.code);
    return a;
  }
}

/** Both stdin and stdout are terminals: the only case the TUI opens in. */
export const isInteractive = (io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } }) =>
  io.stdin.isTTY === true && io.stdout.isTTY === true;

export const tuiRequiresTty = (): RewireError =>
  new RewireError(
    "tui_requires_tty",
    "the interactive session needs a terminal: stdin and stdout must both be TTYs",
    'for scripts use rewire run "<task>" --headless',
  );
