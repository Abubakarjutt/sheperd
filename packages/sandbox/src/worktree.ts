import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { RewireError } from "@rewire/core";

type GitResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          rej(new RewireError("sandbox_unavailable", `cannot run git: ${err.message}`));
          return;
        }
        res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    throw new RewireError("git_failed", `git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export async function assertCleanRepo(repo: string): Promise<{ head: string; branch: string }> {
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new RewireError("not_a_repo", `${repo} is not a git repository`);
  const sym = await git(repo, ["symbolic-ref", "-q", "HEAD"]);
  if (sym.code !== 0) {
    throw new RewireError("detached_head", "HEAD is detached", "check out a branch first");
  }
  const status = await gitOk(repo, ["status", "--porcelain"]);
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
