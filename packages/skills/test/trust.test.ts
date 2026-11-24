import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  discoverSkills,
  isTrusted,
  loadTrust,
  repoSkillsHash,
  resolveSkills,
  saveTrust,
  trust,
} from "../src/index.js";

let root: string;
let home: string;
let repo: string;
let file: string;

const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: does ${name}\n---\nbody${extra}\n`;

async function put(base: string, name: string, text: string) {
  await mkdir(join(base, name), { recursive: true });
  await writeFile(join(base, name, "SKILL.md"), text);
}

const find = async () =>
  (await discoverSkills({ home, xdgConfig: join(home, ".config"), repo })).skills;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rewire-trust-")));
  home = join(root, "home");
  repo = join(root, "repo");
  file = join(root, "cfg", "trusted-skills.json");
  await mkdir(home, { recursive: true });
  await put(join(home, ".claude", "skills"), "mine", md("mine"));
  await put(join(repo, ".claude", "skills"), "theirs", md("theirs"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("trust store", () => {
  test("untrusted repo skills are pending; only user skills active", async () => {
    const r = resolveSkills(await find(), false);
    expect(r.active.map((s) => s.name)).toEqual(["mine"]);
    expect(r.pendingRepo.map((s) => s.name)).toEqual(["theirs"]);
  });

  test("after trust (and a save/load round trip) the same hash activates them", async () => {
    const skills = await find();
    const h = repoSkillsHash(skills);
    await saveTrust(file, trust(await loadTrust(file), repo, h));
    const store = await loadTrust(file);
    expect(isTrusted(store, repo, h)).toBe(true);
    const r = resolveSkills(skills, isTrusted(store, repo, h));
    expect(r.active.map((s) => s.name).sort()).toEqual(["mine", "theirs"]);
    expect(r.pendingRepo).toEqual([]);
  });

  test("editing one byte of a repo skill invalidates trust", async () => {
    const h = repoSkillsHash(await find());
    const store = trust(await loadTrust(file), repo, h);
    await put(join(repo, ".claude", "skills"), "theirs", md("theirs", "!"));
    const h2 = repoSkillsHash(await find());
    expect(h2).not.toBe(h);
    expect(isTrusted(store, repo, h2)).toBe(false);
  });

  test("user skill changes do not affect the repo hash; shadowed repo skills are covered", async () => {
    const h = repoSkillsHash(await find());
    await put(join(home, ".claude", "skills"), "mine", md("mine", "x"));
    expect(repoSkillsHash(await find())).toBe(h);
    await put(join(repo, ".claude", "skills"), "mine", md("mine"));
    const skills = await find();
    expect(skills.some((s) => s.source === "repo" && s.shadowed)).toBe(true);
    expect(repoSkillsHash(skills)).not.toBe(h);
    const r = resolveSkills(skills, true);
    expect(r.active.filter((s) => s.name === "mine")).toHaveLength(1);
    expect(r.active.find((s) => s.name === "mine")?.source).toBe("user");
  });

  test("corrupt JSON is empty, kept as .bak, does not throw", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    await writeFile(file, "{not json");
    const store = await loadTrust(file);
    expect(store.repos.size).toBe(0);
    expect(await readFile(`${file}.bak`, "utf8")).toBe("{not json");
  });

  test("hostile or wrong-shaped files never trust anything", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const h = "a".repeat(64);
    for (const text of [
      "[]",
      "null",
      "42",
      '{"repos":[]}',
      '{"repos":null}',
      `{"repos":{"${repo}":42}}`,
      `{"repos":{"${repo}":"${h.slice(0, 10)}"}}`,
      `{"repos":{"${repo}":["${h}"]}}`,
      `{"__proto__":{"repos":{"${repo}":"${h}"}}}`,
    ]) {
      await writeFile(file, text);
      const store = await loadTrust(file);
      expect(isTrusted(store, repo, h), text).toBe(false);
    }
    await writeFile(file, `{"repos":{"__proto__":"${h}"}}`);
    const store = await loadTrust(file);
    expect(isTrusted(store, "toString", h)).toBe(false);
    expect(isTrusted(store, "constructor", "x")).toBe(false);
  });

  test("hash comparison is exact (no prefix match)", async () => {
    const h = repoSkillsHash(await find());
    const store = trust(await loadTrust(file), repo, h);
    expect(isTrusted(store, repo, h.slice(0, 32))).toBe(false);
    expect(isTrusted(store, repo, "")).toBe(false);
    expect(isTrusted(store, `${repo}/`, h)).toBe(false);
  });

  test("saved file mode is 0600", async () => {
    await saveTrust(file, trust(await loadTrust(file), repo, "b".repeat(64)));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
