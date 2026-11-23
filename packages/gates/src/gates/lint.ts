import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BIOME_CONFIGS, ESLINT_CONFIGS } from "@rewire/pack-typescript";
import type { Gate, GateContext, GateOutput } from "../types.js";
import { baseFileList, baseText, GateExec, localBin } from "./shared.js";

const MAX_LINES = 50;

const err = (summary: string): GateOutput => ({ status: "error", summary, details: null });
const fail = (summary: string, details: unknown = null): GateOutput => ({
  status: "fail",
  summary,
  details,
});

function lintScript(text: string): string | undefined {
  try {
    const s = (JSON.parse(text) as { scripts?: { lint?: unknown } }).scripts?.lint;
    return typeof s === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** The lint command as it existed at baseRef (same detection order as the pack), or null. */
async function baselineLint(
  ctx: GateContext,
  g: GateExec,
): Promise<{ cmd: string[] | null; script?: string }> {
  const files = await baseFileList(ctx, g);
  if (files.includes("package.json")) {
    const script = lintScript(await baseText(ctx, g, "package.json"));
    if (script !== undefined) return { cmd: [ctx.pack.packageManager, "run", "lint"], script };
  }
  if (files.some((f) => BIOME_CONFIGS.includes(f))) return { cmd: ["npx", "biome", "check", "."] };
  if (files.some((f) => ESLINT_CONFIGS.includes(f))) {
    return { cmd: ["npx", "eslint", "."] };
  }
  return { cmd: null };
}

export const lintGate: Gate = {
  name: "lint",
  category: "broken",
  async run(ctx) {
    const g = new GateExec(ctx);
    let base: Awaited<ReturnType<typeof baselineLint>>;
    try {
      base = await baselineLint(ctx, g);
    } catch (e) {
      return err(
        `cannot read lint config at ${ctx.baseRef}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // A linter that existed at baseRef cannot be removed or weakened: the command and the lint
    // script come from baseRef, never from the (implementer-writable) worktree.
    let cmd = ctx.pack.lintCommand;
    if (base.cmd !== null) {
      if (cmd === null)
        return fail(`a linter existed at ${ctx.baseRef} but none is configured now`);
      cmd = base.cmd;
      if (base.script !== undefined) {
        let now: string | undefined;
        try {
          now = lintScript(await readFile(join(ctx.worktree, "package.json"), "utf8"));
        } catch {
          now = undefined;
        }
        if (now !== base.script) {
          return fail(`lint script differs from baseRef (${ctx.baseRef})`, {
            baseline: base.script,
            now,
          });
        }
      }
    }
    if (cmd === null) return { status: "pass", summary: "no linter configured", details: null };
    let argv = [...cmd];
    if (argv[0] === "npx") {
      // Local .bin first; never npx, which may download.
      const bin = argv.slice(1).find((a) => !a.startsWith("-"));
      const idx = bin === undefined ? -1 : argv.indexOf(bin);
      const local = bin === undefined ? undefined : localBin(ctx.worktree, bin);
      if (!local) {
        return err(
          `${bin ?? "linter"} not installed in project — run ${ctx.pack.packageManager} install`,
        );
      }
      argv = [local, ...argv.slice(idx + 1)];
    }
    const r = await g.exec(argv);
    if (r.timedOut) return err("lint timed out");
    if (r.exitCode === 0) return { status: "pass", summary: "lint clean", details: null };
    const lines = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "");
    return fail(`lint exited ${r.exitCode}`, {
      exitCode: r.exitCode,
      output: lines.slice(0, MAX_LINES),
    });
  },
};
