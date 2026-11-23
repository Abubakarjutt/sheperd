import { accessSync, constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { RewireError } from "@rewire/core";
import { CONFIG_FILE_GLOBS } from "@rewire/policy";
import type { ExecResult, SandboxClient } from "@rewire/sandbox";
import { INSTALL_HINTS } from "../runner.js";
import type { GateContext, GateOutput } from "../types.js";

/** Resolve `name` once per PATH on the host; pinned to an absolute path (#25). */
const binCache = new Map<string, string>();
export function resolveBin(name: string, pathEnv: string | undefined = process.env.PATH): string {
  const key = `${name}\0${pathEnv ?? ""}`;
  const hit = binCache.get(key);
  if (hit) return hit;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      binCache.set(key, p);
      return p;
    } catch {
      // keep looking
    }
  }
  throw new RewireError("binary_missing", `command not found: ${name}`);
}

export const resolveGit = (pathEnv: string | undefined = process.env.PATH): string =>
  resolveBin("git", pathEnv);

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
/**
 * The harness never installs dependencies. pnpm (>= 10) runs an install before `exec`/`run`
 * when it thinks node_modules is out of date (`verifyDepsBeforeRun`), which inside the
 * read-only verify sandbox fails, warns and can leave a worker behind (a sandbox_escape). A
 * command-line setting outranks every .npmrc and pnpm-workspace.yaml, so a repo cannot turn
 * it back on.
 */
export const PNPM_NO_INSTALL = "--config.verify-deps-before-run=false";
export function noInstall(argv: string[]): string[] {
  const [bin, ...rest] = argv;
  if (bin === undefined || basename(bin) !== "pnpm") return argv;
  return [bin, PNPM_NO_INSTALL, ...rest];
}

/** What GateExec needs: a fixed deadline, or the policy's gate timeout to compute one. */
export type GateExecContext = Pick<GateContext, "worktree" | "client" | "signal"> &
  ({ deadline: number } | Pick<GateContext, "policy" | "deadline">);

export class GateExec {
  private readonly deadline: number;
  constructor(private readonly ctx: GateExecContext) {
    this.deadline =
      ctx.deadline ?? Date.now() + (ctx as Pick<GateContext, "policy">).policy.gateTimeoutMs;
  }

  /** Run argv in the worktree; `client` defaults to the verify client (pass registryClient for the network exception). */
  async exec(argv: string[], client: SandboxClient = this.ctx.client): Promise<ExecResult> {
    if (this.ctx.signal?.aborted) throw new Error("aborted");
    return client.exec(noInstall(argv), {
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

export function checkRef(ref: string): void {
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

/**
 * A git-pathspec-style glob as a RegExp over a worktree-relative path. A leading double-star
 * segment matches zero or more directories (dot directories included, as git does), a trailing
 * double-star segment matches anything below, `*` matches anything but `/`, and every other
 * character is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let rest = glob;
  let out = "^";
  if (rest.startsWith("**/")) {
    out += "(?:.*/)?";
    rest = rest.slice(3);
  }
  let tail = "";
  if (rest.endsWith("/**")) {
    tail = "/.+";
    rest = rest.slice(0, -3);
  }
  out += rest
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`${out}${tail}$`);
}

/**
 * Config files that decide what the verification gates run and how they judge. Derived from
 * the canonical `CONFIG_FILE_GLOBS` in @rewire/policy, which `protectedGlobs` also includes, so
 * drift detection, the pathspecs below and write protection cannot drift apart (S40).
 */
const CONFIG_RE: readonly RegExp[] = CONFIG_FILE_GLOBS.flatMap(expandBraces).map(globToRegExp);
export const isConfigFile = (p: string): boolean =>
  !inNodeModules(p) && CONFIG_RE.some((re) => re.test(p));

/** Pathspecs that list the current config files and every package.json (node_modules excluded). */
export const CONFIG_PATHSPECS: readonly string[] = pathspecs([
  ...CONFIG_FILE_GLOBS,
  "**/package.json",
]);

/** Max paths handed to one scanner invocation. */
export const SCAN_CHUNK = 500;

export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Files a scanner should look at: everything that differs from baseRef (modified, added or
 * staged) plus untracked, non-ignored files, as worktree-relative paths. Only existing regular
 * files remain: deleted paths, node_modules and `.git/` are dropped, and a path whose real
 * location (symlinks resolved) is outside the worktree is dropped. A symlink to a file inside
 * the worktree is replaced by its target, so a link cannot smuggle in or hide a file.
 */
export async function changedScanFiles(ctx: GateContext, g: GateExec): Promise<string[]> {
  checkRef(ctx.baseRef);
  const diff = await g.git([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--relative",
    ctx.baseRef,
    "--",
  ]);
  const others = await g.git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const root = await realRootOf(ctx);
  const out = new Set<string>();
  for (const p of new Set([...splitZ(diff), ...splitZ(others)])) {
    if (inNodeModules(p) || p === ".git" || p.startsWith(".git/")) continue;
    const abs = join(root, p);
    let real: string;
    try {
      const st = await lstat(abs);
      if (!st.isSymbolicLink() && !st.isFile()) continue;
      real = await realpath(abs);
      if (!(await lstat(real)).isFile()) continue;
    } catch {
      continue; // deleted or unreadable
    }
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const norm = sep === "/" ? rel : rel.split(sep).join("/");
    if (inNodeModules(norm) || norm === ".git" || norm.startsWith(".git/")) continue;
    out.add(norm);
  }
  return [...out].sort();
}

/** Host-side env wrapper: the sandbox exec has no env option, so env is set via /usr/bin/env. */
export const ENV_BIN = "/usr/bin/env";

/** Summary for a missing scanner binary, with the INSTALL_HINTS text (runner.ts has the same shape). */
export function missingBinaryOutput(
  e: unknown,
  fallbackBin: string,
  network: string,
): GateOutput | undefined {
  if (!(e instanceof RewireError) || e.code !== "binary_missing") return undefined;
  const bin = /^command not found: (\S+)/.exec(e.message)?.[1] ?? fallbackBin;
  return {
    status: "error",
    summary: `${bin} not installed — ${INSTALL_HINTS[bin] ?? "install it and make sure it is on PATH"}`,
    details: { network, binary: bin },
  };
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
