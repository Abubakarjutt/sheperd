import { accessSync, constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, matchesGlob } from "node:path";
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

/** The worktree's real path; every path comparison against runner or git output uses this. */
export const realRootOf = (ctx: GateContext): Promise<string> => realpath(ctx.worktree);

/**
 * SandboxClient.exec takes `timeoutMs` but no AbortSignal, so a gate cannot kill its child on
 * abort. Instead every exec is bounded by the time left until the gate's deadline (set by the
 * runner when the gate starts, `ctx.deadline`; otherwise computed from construction time, so
 * construct a GateExec first thing in `run()`): the sandbox kills the child at about the moment
 * the runner records a timeout, so no exec outlives its gate. No new exec starts once the
 * signal is aborted.
 */
export class GateExec {
  private readonly deadline: number;
  constructor(private readonly ctx: GateContext) {
    this.deadline = ctx.deadline ?? Date.now() + ctx.policy.gateTimeoutMs;
  }

  async exec(argv: string[]): Promise<ExecResult> {
    if (this.ctx.signal?.aborted) throw new Error("aborted");
    return this.ctx.client.exec(argv, {
      timeoutMs: Math.max(1, this.deadline - Date.now()),
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

/** Expand `{a,b}` alternations (git pathspec globs have no braces). */
export function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const [whole, inner] = m;
  return (inner ?? "")
    .split(",")
    .flatMap((alt) =>
      expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + whole.length)),
    );
}

export function pathspecs(globs: string[]): string[] {
  return [
    ...globs.flatMap(expandBraces).map((g) => `:(glob)${g}`),
    ":(glob,exclude)**/node_modules/**",
  ];
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.flatMap(expandBraces).some((g) => matchesGlob(path, g));
}

export const inNodeModules = (p: string): boolean => p.split("/").includes("node_modules");

export const splitZ = (s: string): string[] => s.split("\0").filter((x) => x !== "");

function checkRef(ref: string): void {
  if (ref === "" || ref.startsWith("-")) throw new Error(`invalid baseRef: ${ref}`);
}

/**
 * Test files that differ from baseRef: modified, deleted or staged tracked files plus untracked
 * files (gitignored ones included, so ignoring a file cannot hide it), all under the test globs
 * and outside node_modules.
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
  const others = await g.git(["ls-files", "--others", "-z", "--", ...specs]);
  return [...new Set([...splitZ(diff), ...splitZ(others)])].filter((p) => !inNodeModules(p)).sort();
}

/** Every tracked or untracked path under the test globs (outside node_modules). */
export async function testGlobFiles(ctx: GateContext, g: GateExec): Promise<string[]> {
  const out = await g.git([
    "ls-files",
    "--cached",
    "--others",
    "-z",
    "--",
    ...pathspecs(ctx.policy.testGlobs),
  ]);
  return [...new Set(splitZ(out))].filter((p) => !inNodeModules(p)).sort();
}

/** Every file in the baseRef tree. */
export async function baseFileList(ctx: GateContext, g: GateExec): Promise<string[]> {
  checkRef(ctx.baseRef);
  const out = await g.git(["ls-tree", "-r", "--name-only", "-z", ctx.baseRef]);
  return splitZ(out);
}

/** Contents of a file at baseRef (the caller got `path` from baseFileList). */
export async function baseText(ctx: GateContext, g: GateExec, path: string): Promise<string> {
  checkRef(ctx.baseRef);
  return g.git(["show", `${ctx.baseRef}:${path}`]);
}

/** Config files that decide what the verification gates run and how they judge. */
const CONFIG_RE = [
  /^vitest\.config\./,
  /^vite\.config\./,
  /^vitest\.workspace\./,
  /^jest\.config\./,
  /^tsconfig.*\.json$/,
  /^biome\.jsonc?$/,
  /^\.eslintrc/,
  /^eslint\.config\./,
  /^\.gitignore$/,
];
export const isConfigFile = (p: string): boolean =>
  !inNodeModules(p) && CONFIG_RE.some((re) => re.test(basename(p)));

/** Pathspecs that list the current config files (node_modules excluded). */
export const CONFIG_PATHSPECS = [
  ...[
    "vitest.config.*",
    "vite.config.*",
    "vitest.workspace.*",
    "jest.config.*",
    "tsconfig*.json",
    "biome.json*",
    ".eslintrc*",
    "eslint.config.*",
    ".gitignore",
  ].map((n) => `:(glob)**/${n}`),
  ":(glob,exclude)**/node_modules/**",
];
