// Task 6: `listRepoFiles`, the host-side repo listing behind the `@` picker.
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRepoFiles, MAX_REPO_FILES } from "../src/files.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "rewire-files-"));
  dirs.push(d);
  return d;
}
async function gitRepo(): Promise<string> {
  const d = await tmp();
  execFileSync("git", ["init", "-q", d]);
  return d;
}

describe("listRepoFiles", () => {
  it("lists tracked and untracked files, minus ignored ones", async () => {
    const d = await gitRepo();
    await mkdir(join(d, "src"));
    await writeFile(join(d, "src/math.ts"), "x");
    await writeFile(join(d, "README.md"), "x");
    await writeFile(join(d, ".gitignore"), "dist/\n");
    await mkdir(join(d, "dist"));
    await writeFile(join(d, "dist/out.js"), "x");
    execFileSync("git", ["-C", d, "add", "README.md"]);
    const files = await listRepoFiles(d);
    expect(files.sort()).toEqual([".gitignore", "README.md", "src/math.ts"]);
  });

  it("gives an empty list, with no throw, outside a git repo", async () => {
    const d = await tmp();
    await writeFile(join(d, "a.ts"), "x");
    // Git must not find a work tree above the temp dir, wherever TMPDIR is (test-only setting).
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(d);
    try {
      await expect(listRepoFiles(d)).resolves.toEqual([]);
      await expect(listRepoFiles(join(d, "does-not-exist"))).resolves.toEqual([]);
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = before;
    }
  });

  it("stops reading, and kills git, at the cap on an endless listing", async () => {
    const d = await tmp();
    const git = join(d, "fake-git");
    // An ls-files that never ends: f0\0f1\0... Only the kill at 5000 can stop it in time.
    await writeFile(
      git,
      "#!/bin/sh\nexec perl -e 'for ($i = 0; ; $i++) { print \"dir/f$i.ts\\0\" }'\n",
    );
    await chmod(git, 0o755);
    const t0 = Date.now();
    const files = await listRepoFiles(d, { git, timeoutMs: 10_000 });
    expect(files).toHaveLength(5000);
    expect(files[0]).toBe("dir/f0.ts");
    expect(files[4999]).toBe("dir/f4999.ts");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("gives an empty list when git outlives the timeout or is missing", async () => {
    const d = await tmp();
    const git = join(d, "slow-git");
    await writeFile(git, "#!/bin/sh\nexec sleep 30\n");
    await chmod(git, 0o755);
    await expect(listRepoFiles(d, { git, timeoutMs: 200 })).resolves.toEqual([]);
    await expect(listRepoFiles(d, { git: join(d, "no-such-git") })).resolves.toEqual([]);
  });

  it(`caps the list at ${5000} paths`, async () => {
    expect(MAX_REPO_FILES).toBe(5000);
    const d = await gitRepo();
    await Promise.all(Array.from({ length: 5003 }, (_, i) => writeFile(join(d, `f${i}.txt`), "")));
    const files = await listRepoFiles(d);
    expect(files).toHaveLength(5000);
  });

  it("drops a path with a control character in it", async () => {
    const d = await gitRepo();
    await writeFile(join(d, "ok.ts"), "x");
    await writeFile(join(d, "evil\x1b[2J.ts"), "x");
    await writeFile(join(d, "new\nline.ts"), "x");
    const files = await listRepoFiles(d);
    expect(files).toEqual(["ok.ts"]);
  });
});
