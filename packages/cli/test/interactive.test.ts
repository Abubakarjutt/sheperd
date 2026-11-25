import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Activity,
  ctrlC,
  DOUBLE_PRESS_MS,
  Interrupter,
  SAME_PRESS_MS,
} from "../src/interactive.js";

function machine(activity: Activity = "idle") {
  const calls: string[] = [];
  const state = { activity };
  const m = new Interrupter({
    activity: () => state.activity,
    abortRun: () => calls.push("abort_run"),
    abortTurn: () => calls.push("abort_turn"),
    exit: (code) => calls.push(`exit ${code}`),
  });
  return { m, calls, state };
}

describe("Ctrl-C state machine (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  test("idle + Ctrl-C exits 0", () => {
    const { m, calls } = machine("idle");
    m.press("key");
    expect(calls).toEqual(["exit 0"]);
  });

  test("running + Ctrl-C aborts the run and does not exit", () => {
    const { m, calls } = machine("run");
    m.press("key");
    expect(calls).toEqual(["abort_run"]);
    vi.advanceTimersByTime(DOUBLE_PRESS_MS + 1);
    m.press("signal");
    expect(calls).toEqual(["abort_run", "abort_run"]);
  });

  test("a chat turn in flight + Ctrl-C aborts the turn and does not exit", () => {
    const { m, calls } = machine("turn");
    m.press("key");
    expect(calls).toEqual(["abort_turn"]);
  });

  test("two presses within 1000 ms exit 130, in any state", () => {
    for (const activity of ["run", "turn", "idle"] as const) {
      const { m, calls } = machine(activity);
      m.press("key");
      vi.advanceTimersByTime(DOUBLE_PRESS_MS - 1);
      m.press("key");
      expect(calls.at(-1)).toBe("exit 130");
      expect(calls).toHaveLength(2);
    }
  });

  test("a second press after 1000 ms is a fresh first press", () => {
    const { m, calls, state } = machine("run");
    m.press("key");
    state.activity = "idle"; // the run ended as interrupted
    vi.advanceTimersByTime(DOUBLE_PRESS_MS + 1);
    m.press("key");
    expect(calls).toEqual(["abort_run", "exit 0"]);
  });

  test("one press seen as both the Ink key and SIGINT counts once", () => {
    const { m, calls } = machine("run");
    m.press("key");
    vi.advanceTimersByTime(SAME_PRESS_MS - 10);
    expect(m.press("signal").kind).toBe("duplicate");
    expect(calls).toEqual(["abort_run"]);
    // A real second press (well after the duplicate window) still force-quits.
    vi.advanceTimersByTime(300);
    m.press("key");
    expect(calls).toEqual(["abort_run", "exit 130"]);
  });

  test("two presses from the same source are never deduplicated", () => {
    const { m, calls } = machine("run");
    m.press("signal");
    m.press("signal");
    expect(calls).toEqual(["abort_run", "exit 130"]);
  });

  test("the pure transition keeps the memo on a duplicate", () => {
    const first = ctrlC(undefined, "idle", "signal", 10);
    expect(first.action).toEqual({ kind: "exit", code: 0 });
    const dup = ctrlC(first.memo, "idle", "key", 20);
    expect(dup.action.kind).toBe("duplicate");
    expect(dup.memo).toEqual(first.memo);
  });
});
