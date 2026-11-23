import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { RewireError } from "@rewire/core";

export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * Config overrides for every orchestrator-owned git call (R5): no hooks, no fsmonitor daemon,
 * no signing helper, no ssh or remote transport. Placed before the subcommand.
 */
export const GIT_HARDENING: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.sshCommand=false",
  "-c",
  "protocol.allow=never",
];

let gitBin: string | undefined;
/** git resolved once to an absolute path on the host PATH (#25). */
export function pinnedGit(): string {
  if (gitBin) return gitBin;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, "git");
    try {
      accessSync(p, constants.X_OK);
      gitBin = p;
      return p;
    } catch {
      // keep looking
    }
  }
  throw new RewireError("binary_missing", "command not found: git");
}

/**
 * The host environment without any GIT_* variable (GIT_DIR, GIT_CONFIG_*, GIT_EXEC_PATH, ...),
 * plus GIT_INDEX_FILE when the caller asks for a scratch index.
 */
function gitEnv(indexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith("GIT_")) env[k] = v;
  }
  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile;
  return env;
}

/**
 * Trusted git for orchestrator-owned operations (worktree add/remove, commits, the replan
 * reset): the pinned binary, hardened config and a scrubbed environment. Never for agent input.
 */
export function trustedGit(
  cwd: string,
  args: string[],
  opts: { signal?: AbortSignal; indexFile?: string } = {},
): Promise<GitResult> {
  return new Promise((res, rej) => {
    let bin: string;
    try {
      bin = pinnedGit();
    } catch (e) {
      rej(e);
      return;
    }
    execFile(
      bin,
      [...GIT_HARDENING, ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnv(opts.indexFile),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          if ((err as { name?: string }).name === "AbortError") {
            rej(new RewireError("aborted", `git ${args[0] ?? ""} was aborted`));
            return;
          }
          rej(new RewireError("sandbox_unavailable", `cannot run git: ${err.message}`));
          return;
        }
        res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

/** trustedGit that throws `git_failed` on a non-zero exit. */
export async function trustedGitOk(
  cwd: string,
  args: string[],
  opts: { signal?: AbortSignal; indexFile?: string } = {},
): Promise<string> {
  const r = await trustedGit(cwd, args, opts);
  if (r.code !== 0) {
    throw new RewireError("git_failed", `git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

const git = (cwd: string, args: string[]): Promise<GitResult> => trustedGit(cwd, args);
const gitOk = (cwd: string, args: string[]): Promise<string> => trustedGitOk(cwd, args);

/** Run artifacts rewire itself writes into the target repo; never "uncommitted changes". */
const RUN_ARTIFACTS = [".rewire/runs", ".rewire/worktrees", ".rewire/cache"].map(
  (p) => `:(exclude,top)${p}`,
);

export async function assertCleanRepo(repo: string): Promise<{ head: string; branch: string }> {
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new RewireError("not_a_repo", `${repo} is not a git repository`);
  // I7: the worktree is a checkout of the whole repository, so the pipeline's root must be the
  // repository root; package subdirectories (monorepos) are not supported in v0.1.
  const toplevel = await realpath(top.stdout.trim()).catch(() => top.stdout.trim());
  const given = await realpath(repo).catch(() => repo);
  if (toplevel !== given) {
    throw new RewireError(
      "not_repo_root",
      `${repo} is not the root of its git repository`,
      `run rewire with --repo ${toplevel} (monorepo package subdirectories are not supported in v0.1)`,
    );
  }
  const sym = await git(repo, ["symbolic-ref", "-q", "HEAD"]);
  if (sym.code !== 0) {
    throw new RewireError("detached_head", "HEAD is detached", "check out a branch first");
  }
  const status = await gitOk(repo, ["status", "--porcelain", "--", ":(top)", ...RUN_ARTIFACTS]);
  if (status.trim() !== "") {
    throw new RewireError(
      "dirty_tree",
      "working tree has uncommitted or untracked changes",
      "commit or stash them first",
    );
  }
  const head = (await gitOk(repo, ["rev-parse", "HEAD"])).trim();
  const branch = (await gitOk(repo, ["symbolic-ref", "--short", "HEAD"])).trim();
  return { head, branch };
}

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const EXCLUDE_LINE = "/.rewire/worktrees/";

function validateRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId.includes("..")) {
    throw new RewireError("invalid_run_id", `invalid runId: ${JSON.stringify(runId)}`);
  }
}

async function ensureExcluded(repo: string): Promise<void> {
  const common = (await gitOk(repo, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = isAbsolute(common) ? common : resolve(repo, common);
  const file = join(commonDir, "info", "exclude");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // missing is fine
  }
  if (existing.split("\n").some((l) => l.trim() === EXCLUDE_LINE)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(
    file,
    `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${EXCLUDE_LINE}\n`,
  );
}

export async function createWorktree(
  repo: string,
  runId: string,
): Promise<{ path: string; branch: string }> {
  validateRunId(runId);
  const branch = `rewire/${runId}`;
  const path = join(repo, ".rewire", "worktrees", runId);
  await ensureExcluded(repo);
  await mkdir(dirname(path), { recursive: true });
  await gitOk(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch };
}

/** Removes the worktree only; the branch is the run's output and is kept. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await gitOk(repo, ["worktree", "remove", "--force", path]);
}
