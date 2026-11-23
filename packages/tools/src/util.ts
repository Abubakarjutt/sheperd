import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { RewireError } from "@rewire/core";
import type { ToolResult } from "@rewire/loop";

export const ok = (content: string): ToolResult => ({ content, isError: false });
export const fail = (content: string): ToolResult => ({ content, isError: true });

export type ToolContext = { stage: string };

/**
 * Maps any thrown value to an error result; tools never throw. Sandbox failures
 * that mean "the action did not happen" say so explicitly.
 */
export function errorResult(e: unknown, ctx: ToolContext): ToolResult {
  if (e instanceof RewireError) {
    if (e.code === "path_protected") return fail(`${e.message} in stage ${ctx.stage}`);
    if (
      e.code === "sandbox_unavailable" ||
      e.code === "binary_missing" ||
      e.code === "sandbox_escape"
    ) {
      return fail(`${e.code}: ${e.message} (the action did not complete)`);
    }
    return fail(`${e.code}: ${e.message}`);
  }
  return fail(`error: ${e instanceof Error ? e.message : String(e)}`);
}

export function protectedMessage(canonical: string, rule: string, stage: string): string {
  return `${canonical} is protected (rule ${rule}) in stage ${stage}`;
}

export function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function intArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

/** Keep the first and last half of an oversized string with an omission marker. */
export function capOutput(s: string, max = 30_000): string {
  if (s.length <= max) return s;
  const half = max / 2;
  return `${s.slice(0, half)}\n[… ${s.length - max} chars omitted …]\n${s.slice(-half)}`;
}

/**
 * Clear-message pre-check only; the sandbox is the enforcement boundary (#21).
 * Returns an error message, or undefined when the path is a plausible worktree-relative path.
 */
export function relativePathProblem(path: string): string | undefined {
  if (isAbsolute(path)) return `path must be relative to the worktree root: ${path}`;
  const n = normalize(path);
  if (n === ".." || n.startsWith("../")) {
    return `path must be relative to the worktree root and must not escape it: ${path}`;
  }
  return undefined;
}

/** Resolve `rg` once on the host; pinned to an absolute path (#25). */
export function resolveRg(pathEnv: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "rg");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
