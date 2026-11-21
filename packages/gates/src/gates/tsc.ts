import type { Gate } from "../types.js";
import { GateExec, localBin } from "./shared.js";

const MAX_LINES = 50;

export const tscGate: Gate = {
  name: "tsc",
  category: "broken",
  async run(ctx) {
    const tsc = localBin(ctx.worktree, "tsc");
    if (!tsc) {
      return {
        status: "error",
        summary: `typescript not installed in project — run ${ctx.pack.packageManager} install`,
        details: null,
      };
    }
    const r = await new GateExec(ctx).exec([tsc, "--noEmit", "-p", ctx.pack.tsconfig]);
    if (r.timedOut) return { status: "error", summary: "tsc timed out", details: null };
    const lines = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "");
    if (r.exitCode === 0) return { status: "pass", summary: "tsc clean", details: null };
    return {
      status: "fail",
      summary: `tsc exited ${r.exitCode} with ${lines.length} output line(s)`,
      details: { exitCode: r.exitCode, diagnostics: lines.slice(0, MAX_LINES) },
    };
  },
};
