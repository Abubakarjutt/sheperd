import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { snapshotTree } from "../src/tree-guard.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-tg-")));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function nested(root: string, dir: string): string {
  const sub = join(root, dir);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "hidden.ts"), "export const h = eval('1');\n");
  git(sub, "init", "-q", "-b", "main");
  git(sub, "add", "-A");
  git(sub, "commit", "-q", "-m", "inner");
  return git(sub, "rev-parse", "HEAD").trim();
}

test("a nested repository created in the worktree is refused, never snapshotted as a gitlink (N1)", async () => {
  const root = repo();
  nested(root, "sub");
  await expect(snapshotTree(root)).rejects.toMatchObject({ code: "tree_unsafe" });
});

test("a gitlink already in HEAD (an existing submodule) is still snapshotted", async () => {
  const root = repo();
  nested(root, "lib");
  git(root, "add", "lib");
  git(root, "commit", "-q", "-m", "submodule");
  expect(git(root, "ls-tree", "HEAD", "lib")).toMatch(/^160000 commit /);
  const tree = await snapshotTree(root);
  expect(tree).toBe(git(root, "rev-parse", "HEAD^{tree}").trim());
});
