import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { RewireError } from "@rewire/core";
import type { ExecResult } from "@rewire/sandbox";
import type { GateContext } from "../types.js";

/** Resolve `git` once per PATH on the host; pinned to an absolute path (#25). */
const gitCache = new Map<string, string>();
export function resolveGit(pathEnv: string | undefined = process.env.PATH): string {
  const key = pathEnv ?? "";
  const hit = gitCache.get(key);
  if (hit) return hit;
  for (const dir of key.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "git");
    try {
      accessSync(p, constants.X_OK);
      gitCache.set(key, p);
      return p;
    } catch {
      // keep looking
    }
  }
  throw new RewireError("binary_missing", "command not found: git");
}

/** `<worktree>/node_modules/.bin/<bin>` if it exists and is executable (never npx, which may download). */
export function localBin(worktree: string, bin: string): string | undefined {
  const p = join(worktree, "node_modules", ".bin", bin);
  try {
    accessSync(p, constants.X_OK);
    return p;
  } catch {
    return undefined;
  }
}

/**
 * SandboxClient.exec takes `timeoutMs` but no AbortSignal, so a gate cannot kill its child on
 * abort. Instead every exec is bounded by the time left of the gate's own budget
 * (policy.gateTimeoutMs, measured from the gate's start): the sandbox kills the child at about
 * the same moment the runner records the gate as timed out, so no exec outlives its gate. No
 * new exec is started once the signal is aborted.
 */
export class GateExec {
  private readonly started = Date.now();
  constructor(private readonly ctx: GateContext) {}

  async exec(argv: string[]): Promise<ExecResult> {
    if (this.ctx.signal?.aborted) throw new Error("aborted");
    const left = this.ctx.policy.gateTimeoutMs - (Date.now() - this.started);
    return this.ctx.client.exec(argv, {
      timeoutMs: Math.max(1, left),
      cwd: this.ctx.worktree,
    });
  }

  /** Run git (pinned absolute path) in the worktree. Non-zero exit is a thrown Error. */
  async git(args: string[]): Promise<string> {
    const r = await this.exec([resolveGit(), "--no-optional-locks", ...args]);
    if (r.timedOut) throw new Error(`git ${args[0]} timed out`);
    if (r.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  }
}

export function pathspecs(globs: string[]): string[] {
  return globs.map((g) => `:(glob)${g}`);
}

const splitZ = (s: string): string[] => s.split("\0").filter((x) => x !== "");

function checkRef(ref: string): void {
  if (ref === "" || ref.startsWith("-")) throw new Error(`invalid baseRef: ${ref}`);
}

/**
 * Test files that differ from baseRef: modified, deleted or staged tracked files plus untracked
 * (non-ignored) files, all under the policy test globs.
 */
export async function changedTestFiles(ctx: GateContext, g: GateExec): Promise<string[]> {
  checkRef(ctx.baseRef);
  const specs = pathspecs(ctx.policy.testGlobs);
  const diff = await g.git([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--relative",
    ctx.baseRef,
    "--",
    ...specs,
  ]);
  const others = await g.git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs]);
  return [...new Set([...splitZ(diff), ...splitZ(others)])].sort();
}

/** Every tracked or untracked (non-ignored) path under the test globs. */
export async function testGlobFiles(ctx: GateContext, g: GateExec): Promise<string[]> {
  const out = await g.git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspecs(ctx.policy.testGlobs),
  ]);
  return [...new Set(splitZ(out))].sort();
}
