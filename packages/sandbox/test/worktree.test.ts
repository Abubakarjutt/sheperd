import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertCleanRepo, createWorktree, removeWorktree } from "../src/index.js";
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
