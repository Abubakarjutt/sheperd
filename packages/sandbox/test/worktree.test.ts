import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertCleanRepo, createWorktree, removeWorktree, trustedGitOk } from "../src/index.js";
import { git, makeRepo, tmp } from "./helpers.js";

test("refuses_dirty_tree", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "new.txt"), "x");
  await expect(assertCleanRepo(dir)).rejects.toMatchObject({ code: "dirty_tree" });
});

test("refuses_non_repo", async () => {
  await expect(assertCleanRepo(tmp())).rejects.toMatchObject({ code: "not_a_repo" });
});

test("refuses_detached_head", async () => {
  const dir = makeRepo();
  git(dir, "checkout", "-q", "--detach");
  await expect(assertCleanRepo(dir)).rejects.toMatchObject({ code: "detached_head" });
});

test("a subdirectory of a repo is refused with not_repo_root (I7)", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "packages", "a"), { recursive: true });
  writeFileSync(join(dir, "packages", "a", "x.ts"), "export {};\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "pkg");
  await expect(assertCleanRepo(join(dir, "packages", "a"))).rejects.toMatchObject({
    code: "not_repo_root",
    hint: expect.stringContaining(dir),
  });
});

test("clean repo returns head and branch", async () => {
  const dir = makeRepo();
  const r = await assertCleanRepo(dir);
  expect(r.branch).toBe("main");
  expect(r.head).toBe(git(dir, "rev-parse", "HEAD").trim());
});

test("worktree created on branch rewire/<runId> and removed cleanly", async () => {
  const dir = makeRepo();
  const wt = await createWorktree(dir, "run-1");
  expect(wt.branch).toBe("rewire/run-1");
  expect(wt.path).toBe(join(dir, ".rewire", "worktrees", "run-1"));
  expect(git(dir, "worktree", "list")).toContain("run-1");
  // target repo's status stays clean, and the exclude is idempotent
  expect(git(dir, "status", "--porcelain")).toBe("");
  await createWorktree(dir, "run-2");
  const exclude = git(dir, "rev-parse", "--git-path", "info/exclude").trim();
  const text = readFileSync(join(dir, exclude), "utf8");
  expect(text.split("/.rewire/worktrees/").length - 1).toBe(1);
  await removeWorktree(dir, wt.path);
  expect(existsSync(wt.path)).toBe(false);
  expect(git(dir, "worktree", "list")).not.toContain("run-1");
  expect(git(dir, "branch", "--list", "rewire/run-1")).toContain("rewire/run-1");
});

test("invalid runId rejected", async () => {
  const dir = makeRepo();
  for (const id of ["../x", "a/b", "", "a..b", "x y"]) {
    await expect(createWorktree(dir, id)).rejects.toMatchObject({ code: "invalid_run_id" });
  }
});

test("run artifacts under .rewire/runs, worktrees and cache do not make the repo dirty", async () => {
  const dir = makeRepo();
  for (const sub of ["runs/r1", "worktrees/r1", "cache"]) {
    mkdirSync(join(dir, ".rewire", sub), { recursive: true });
    writeFileSync(join(dir, ".rewire", sub, "f.txt"), "x");
  }
  await expect(assertCleanRepo(dir)).resolves.toMatchObject({ branch: "main" });
  // Anything else under .rewire (policy) still counts.
  writeFileSync(join(dir, ".rewire", "policy.toml"), "maxFixRounds = 1\n");
  await expect(assertCleanRepo(dir)).rejects.toMatchObject({ code: "dirty_tree" });
});

test("orchestrator git runs hardened: no hooks, no GIT_* env overrides", async () => {
  const dir = makeRepo();
  const hooks = join(dir, ".hooks");
  mkdirSync(hooks);
  const marker = join(tmp(), "hook-ran");
  for (const h of ["post-checkout", "pre-commit", "commit-msg"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  git(dir, "config", "core.hooksPath", hooks);
  git(dir, "add", ".hooks");
  git(dir, "commit", "-q", "--no-verify", "-m", "hooks");
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent";
  try {
    const wt = await createWorktree(dir, "hard-1");
    writeFileSync(join(wt.path, "b.txt"), "b\n");
    await trustedGitOk(wt.path, ["add", "-A"]);
    await trustedGitOk(wt.path, ["commit", "--no-verify", "-m", "x"]);
    await removeWorktree(dir, wt.path);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  }
  expect(existsSync(marker)).toBe(false);
  expect(git(dir, "log", "-1", "--format=%s", "rewire/hard-1").trim()).toBe("x");
});
