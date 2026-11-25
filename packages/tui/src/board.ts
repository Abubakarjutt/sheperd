import type { RunEvent } from "@rewire/core";

export const STAGES = ["Spec", "Tests", "Implement", "Gates", "Review", "Commit"] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = "pending" | "running" | "done" | "failed";
export type StageRow = { status: StageStatus; detail: string };

export type BoardState = {
  rows: Record<StageName, StageRow>;
  /** Latest status per gate name (a fix round re-runs gates). */
  gates: Record<string, "pass" | "fail" | "error">;
  findings: number;
  upheld: number;
  refuted: number;
  round: number;
  redOk: boolean;
  frozen: boolean;
  testCount?: number;
  /** Reviewer/verifier stages that have started and not ended. */
  reviewOpen: string[];
  reviewFailed: boolean;
  /** `revise` decisions seen at the contract checkpoint. */
  revisions: number;
  ended?: "verified" | "escalated";
};

const row = (status: StageStatus = "pending", detail = ""): StageRow => ({ status, detail });

export const initialBoard = (): BoardState => ({
  rows: {
    Spec: row(),
    Tests: row(),
    Implement: row(),
    Gates: row(),
    Review: row(),
    Commit: row(),
  },
  gates: {},
  findings: 0,
  upheld: 0,
  refuted: 0,
  round: 0,
  redOk: false,
  frozen: false,
  reviewOpen: [],
  reviewFailed: false,
  revisions: 0,
});

/** Reviewer and verifier stage names (packages/reviewers: routing.ts, verifier.ts). */
const REVIEW_STAGES = new Set(["security", "spec-compliance", "silent-failure", "verifier"]);

/** Pipeline stage names that own a board row. */
const STAGE_ROW: Record<string, StageName> = {
  spec: "Spec",
  "test-writer": "Tests",
  implementer: "Implement",
};

const set = (s: BoardState, name: StageName, patch: Partial<StageRow>): BoardState => ({
  ...s,
  rows: { ...s.rows, [name]: { ...s.rows[name], ...patch } },
});

function testsDetail(s: BoardState): string {
  const parts: string[] = [];
  if (s.testCount !== undefined)
    parts.push(`${s.testCount} test file${s.testCount === 1 ? "" : "s"}`);
  if (s.redOk) parts.push("red ✓");
  if (s.frozen) parts.push("frozen");
  return parts.join(" · ");
}

function gatesDetail(g: BoardState["gates"]): string {
  const all = Object.entries(g);
  const passed = all.filter(([, v]) => v === "pass").length;
  const bad = all.filter(([, v]) => v !== "pass").map(([k]) => k);
  return `${passed}/${all.length} passed${bad.length > 0 ? ` · failed: ${bad.join(", ")}` : ""}`;
}

const reviewStatus = (s: BoardState): StageStatus => (s.reviewFailed ? "failed" : "running");

function reviewDetail(s: BoardState): string {
  return `${s.findings} finding${s.findings === 1 ? "" : "s"} · ${s.upheld} upheld · ${s.refuted} refuted`;
}

/** Gates stop being "running" once review starts or the run ends, if nothing failed. */
function settleGates(s: BoardState): BoardState {
  const g = s.rows.Gates;
  return g.status === "running" ? set(s, "Gates", { status: "done" }) : s;
}

/**
 * Folds one run event into the board. Mapping from the brief's names to the real events:
 * `stage_start`/`stage_end` exist only for spec, test-writer and implementer; gates are
 * `gate_result` (pass/fail/error), review is `finding` and `verdict`, the fix loop is `fix_round`,
 * commit is `run_end` or an approved `commit` checkpoint, and `escalation` fails the stage that
 * was running. Criteria counts come from the checkpoint payload (`withCheckpoint`).
 */
export function reduceBoard(state: BoardState, e: RunEvent): BoardState {
  switch (e.type) {
    case "stage_start": {
      if (REVIEW_STAGES.has(e.stage)) {
        const s = settleGates(state);
        const open = [...s.reviewOpen, e.stage];
        return set({ ...s, reviewOpen: open }, "Review", {
          status: s.reviewFailed ? "failed" : "running",
          detail: s.rows.Review.detail,
        });
      }
      const name = STAGE_ROW[e.stage];
      if (!name) return state;
      let s = set(state, name, {
        status: "running",
        detail: name === "Implement" && state.round > 0 ? `round ${state.round}` : "",
      });
      if (name === "Implement" && !s.frozen) {
        s = { ...s, frozen: true };
        s = set(s, "Tests", { detail: testsDetail(s) });
      }
      return s;
    }
    case "stage_end": {
      if (REVIEW_STAGES.has(e.stage)) {
        const i = state.reviewOpen.indexOf(e.stage);
        const open = i < 0 ? state.reviewOpen : state.reviewOpen.filter((_, j) => j !== i);
        const reviewFailed = state.reviewFailed || !e.ok;
        const status: StageStatus = reviewFailed ? "failed" : open.length > 0 ? "running" : "done";
        return set({ ...state, reviewOpen: open, reviewFailed }, "Review", { status });
      }
      const name = STAGE_ROW[e.stage];
      if (!name) return state;
      let s = set(state, name, { status: e.ok ? "done" : "failed" });
      if (name === "Tests" && e.ok) {
        s = { ...s, redOk: true };
        s = set(s, "Tests", { detail: testsDetail(s) });
      }
      return s;
    }
    case "tool_call": {
      if (REVIEW_STAGES.has(e.stage)) {
        return set(state, "Review", {
          detail: `${e.isError ? "✗ " : ""}${e.stage}/${e.tool}: ${e.summary}`,
        });
      }
      const name = STAGE_ROW[e.stage];
      if (!name || state.rows[name].status !== "running") return state;
      const mark = e.isError ? "✗ " : "";
      return set(state, name, { detail: `${mark}${e.tool}: ${e.summary}` });
    }
    case "gate_result": {
      const gates = { ...state.gates, [e.result.gate]: e.result.status };
      const failed = Object.values(gates).some((v) => v !== "pass");
      return set({ ...state, gates }, "Gates", {
        status: failed ? "failed" : "running",
        detail: gatesDetail(gates),
      });
    }
    case "finding": {
      const s0 = settleGates(state);
      const s = { ...s0, findings: s0.findings + 1 };
      return set(s, "Review", { status: reviewStatus(s), detail: reviewDetail(s) });
    }
    case "verdict": {
      const s0 = settleGates(state);
      const s = {
        ...s0,
        upheld: s0.upheld + (e.verdict.verdict === "upheld" ? 1 : 0),
        refuted: s0.refuted + (e.verdict.verdict === "refuted" ? 1 : 0),
      };
      return set(s, "Review", { status: reviewStatus(s), detail: reviewDetail(s) });
    }
    case "fix_round": {
      // A new round re-runs the implementer, gates and review from scratch.
      const base = initialBoard();
      return {
        ...state,
        round: e.round,
        gates: {},
        findings: 0,
        upheld: 0,
        refuted: 0,
        reviewOpen: [],
        reviewFailed: false,
        rows: {
          ...state.rows,
          Implement: row("running", `round ${e.round}`),
          Gates: base.rows.Gates,
          Review: base.rows.Review,
        },
      };
    }
    case "checkpoint": {
      if (e.kind === "contract" && e.decision.action === "revise") {
        return { ...state, revisions: state.revisions + 1 };
      }
      if (e.kind === "tests" && e.decision.action === "approve") {
        const s = { ...state, frozen: true };
        return set(s, "Tests", { detail: testsDetail(s) });
      }
      if (e.kind === "commit" && e.decision.action === "approve") {
        return set(settleReview(state), "Commit", { status: "running", detail: "approved" });
      }
      return state;
    }
    case "escalation": {
      const rows = { ...state.rows };
      for (const n of STAGES) {
        if (rows[n].status === "running") {
          rows[n] = { ...rows[n], status: "failed" };
        }
      }
      return { ...state, rows, ended: "escalated" };
    }
    case "run_end": {
      if (e.status === "escalated") return { ...state, ended: "escalated" };
      let s: BoardState = { ...settleReview(state), ended: "verified" };
      s = set(s, "Commit", { status: "done", detail: "committed" });
      return s;
    }
    default:
      return state;
  }
}

function settleReview(s: BoardState): BoardState {
  const settled = settleGates(s);
  const r = settled.rows.Review.status;
  return r === "running" || r === "pending" ? set(settled, "Review", { status: "done" }) : settled;
}

/** Details only a checkpoint payload carries: criteria counts, test file count. */
export type CheckpointFacts =
  | { kind: "contract"; changes: number; preserves: number }
  | { kind: "tests"; files: number };

export function withCheckpoint(state: BoardState, f: CheckpointFacts): BoardState {
  if (f.kind === "contract") {
    return set(state, "Spec", { detail: `${f.changes} change · ${f.preserves} preserve` });
  }
  const s = { ...state, testCount: f.files };
  return set(s, "Tests", { detail: testsDetail(s) });
}

/**
 * The stage a run is in, lower-cased for the status line: the last row that is running, else the
 * last row that has started; undefined before any stage starts.
 */
export function currentStage(state: BoardState): string | undefined {
  const rows = [...STAGES].reverse();
  const name =
    rows.find((n) => state.rows[n].status === "running") ??
    rows.find((n) => state.rows[n].status !== "pending");
  return name?.toLowerCase();
}
