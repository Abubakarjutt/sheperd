import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILE_GLOBS, DEFAULT_POLICY } from "@rewire/policy";
import { afterAll, describe, expect, test } from "vitest";
import { CONFIG_PATHSPECS, isConfigFile, matchesAnyGlob } from "../src/gates/shared.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Concrete paths a glob must match: at the root and nested. */
function samples(glob: string): string[] {
  const concrete = glob.replace(/\/\*\*$/, "/c.toml").replace(/\*/g, "x");
  const bare = concrete.replace(/^x\//, "");
  return [bare, `sub/${bare}`];
}

/** Paths the pathspecs list in a temp repo holding exactly `paths` as untracked files. */
function listedByPathspecs(paths: string[]): Set<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cfg-")));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const p of paths) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), "x\n");
  }
  const out = execFileSync("git", ["ls-files", "--others", "-z", "--", ...CONFIG_PATHSPECS], {
    cwd: root,
    encoding: "utf8",
  });
  return new Set(out.split("\0").filter(Boolean));
}

// The variants named in fix round 4 (S40), spelled out so a shrinking canonical list is caught.
const REQUIRED = [
  ".config/mise.toml",
  "sub/.config/mise.toml",
  "mise.production.toml",
  "sub/mise.local.toml",
  ".mise.dev.toml",
  "sub/.mise.local.toml",
  "mise/config.toml",
  "sub/mise/tasks/build",
  ".config/mise/config.toml",
  ".mise/config.toml",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
];

describe("one canonical list of config file patterns (S40)", () => {
  test("canonical list holds the required version-manager variants", () => {
    for (const g of [
      "**/.config/mise.toml",
      "**/mise.*.toml",
      "**/.mise.*.toml",
      "**/mise/**",
      "**/.config/mise/**",
    ]) {
      expect(CONFIG_FILE_GLOBS).toContain(g);
    }
  });

  const cases = [...new Set([...CONFIG_FILE_GLOBS.flatMap(samples), ...REQUIRED])].sort();

  test("every canonical entry is matched by drift regex, pathspecs and protected globs", () => {
    const listed = listedByPathspecs(cases);
    const misses: string[] = [];
    for (const p of cases) {
      if (!isConfigFile(p)) misses.push(`isConfigFile: ${p}`);
      if (!listed.has(p)) misses.push(`pathspec: ${p}`);
      if (!matchesAnyGlob(p, DEFAULT_POLICY.protectedGlobs)) misses.push(`protected: ${p}`);
    }
    expect(misses).toEqual([]);
  });

  test("config files under dot directories are drift and listed by the pathspecs", () => {
    const paths = [".github/x/.nvmrc", ".hidden/mise.toml", ".a/.mise/c.toml"];
    const listed = listedByPathspecs(paths);
    for (const p of paths) {
      expect(isConfigFile(p), p).toBe(true);
      expect(listed.has(p), p).toBe(true);
    }
  });

  test("ordinary source files are not config", () => {
    for (const p of ["src/index.ts", "README.md", "src/mise.ts", "promise.toml"]) {
      expect(isConfigFile(p), p).toBe(false);
    }
    expect(isConfigFile("node_modules/x/.nvmrc")).toBe(false);
  });
});
