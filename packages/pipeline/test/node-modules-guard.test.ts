import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { linkNodeModules, nodeModulesTampered } from "../src/node-modules-guard.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-nmguard-")));
  dirs.push(d);
  return d;
};

describe("node_modules state guard (R33)", () => {
  test("absent: any node_modules appearing later is tamper", async () => {
    const repo = tmp();
    const wt = tmp();
    const state = await linkNodeModules(repo, wt);
    expect(state).toEqual({ kind: "absent" });
    expect(await nodeModulesTampered(wt, state)).toBe(false);
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    expect(await nodeModulesTampered(wt, state)).toBe(true);
  });

  test("absent: a planted symlink is tamper too", async () => {
    const wt = tmp();
    const state = await linkNodeModules(tmp(), wt);
    symlinkSync(tmp(), join(wt, "node_modules"));
    expect(await nodeModulesTampered(wt, state)).toBe(true);
  });

  test("link: a swapped target or a replaced directory is tamper", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "node_modules"));
    const wt = tmp();
    const state = await linkNodeModules(repo, wt);
    expect(state).toEqual({ kind: "link", target: join(repo, "node_modules") });
    expect(await nodeModulesTampered(wt, state)).toBe(false);
    rmSync(join(wt, "node_modules"));
    symlinkSync(tmp(), join(wt, "node_modules"));
    expect(await nodeModulesTampered(wt, state)).toBe(true);
    rmSync(join(wt, "node_modules"));
    mkdirSync(join(wt, "node_modules"));
    expect(await nodeModulesTampered(wt, state)).toBe(true);
    rmSync(join(wt, "node_modules"), { recursive: true });
    expect(await nodeModulesTampered(wt, state)).toBe(true);
  });

  test("dir: a pre-existing directory must keep its identity", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "node_modules"));
    const wt = tmp();
    mkdirSync(join(wt, "node_modules"));
    const state = await linkNodeModules(repo, wt);
    expect(state.kind).toBe("dir");
    expect(await nodeModulesTampered(wt, state)).toBe(false);
    rmSync(join(wt, "node_modules"), { recursive: true });
    mkdirSync(join(wt, "node_modules"));
    // a fresh directory may reuse the inode on some filesystems; a symlink never matches
    rmSync(join(wt, "node_modules"), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
    expect(await nodeModulesTampered(wt, state)).toBe(true);
    rmSync(join(wt, "node_modules"));
    expect(await nodeModulesTampered(wt, state)).toBe(true);
  });
});
