import type { Gate } from "../types.js";
import { GateExec, localBin } from "./shared.js";

const MAX_LINES = 50;

export const lintGate: Gate = {
  name: "lint",
  category: "broken",
  async run(ctx) {
    const cmd = ctx.pack.lintCommand;
    if (cmd === null) return { status: "pass", summary: "no linter configured", details: null };
    let argv = [...cmd];
    if (argv[0] === "npx") {
      // Local .bin first; never npx, which may download.
      const bin = argv.slice(1).find((a) => !a.startsWith("-"));
      const idx = bin === undefined ? -1 : argv.indexOf(bin);
      const local = bin === undefined ? undefined : localBin(ctx.worktree, bin);
      if (!local) {
        return {
          status: "error",
          summary: `${bin ?? "linter"} not installed in project — run ${ctx.pack.packageManager} install`,
          details: null,
        };
      }
      argv = [local, ...argv.slice(idx + 1)];
    }
    const r = await new GateExec(ctx).exec(argv);
    if (r.timedOut) return { status: "error", summary: "lint timed out", details: null };
    if (r.exitCode === 0) return { status: "pass", summary: "lint clean", details: null };
    const lines = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "");
    return {
      status: "fail",
      summary: `lint exited ${r.exitCode}`,
      details: { exitCode: r.exitCode, output: lines.slice(0, MAX_LINES) },
    };
  },
};
