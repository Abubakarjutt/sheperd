import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { commitDiff } from "../src/commit-diff.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49]);

function repo(): { root: string; base: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cdiff-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "assets", "old.png"), PNG);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}

test("binary assets are listed as omitted; text-valued assets and code are diffed", async () => {
  const { root, base } = repo();
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "assets", "logo.png"), PNG);
  writeFileSync(join(root, "assets", "fake.png"), "export const hidden = 1;\n");
  rmSync(join(root, "assets", "old.png"));
  git(root, "add", "-A");
  const diff = await commitDiff(root, base, {});
  expect(diff).toContain("+export const a = 2;");
  expect(diff).toContain("+++ b/assets/fake.png");
  expect(diff).toContain("+export const hidden = 1;");
  expect(diff).toContain("binary file omitted: assets/logo.png");
  expect(diff).toContain("binary file omitted: assets/old.png (deleted)");
  expect(diff).not.toContain("+++ b/assets/logo.png");
  expect(diff).not.toContain("\0");
});

test("no asset changes: no omitted list", async () => {
  const { root, base } = repo();
  writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
  git(root, "add", "-A");
  const diff = await commitDiff(root, base, {});
  expect(diff).toContain("+export const a = 3;");
  expect(diff).not.toContain("omitted");
});
