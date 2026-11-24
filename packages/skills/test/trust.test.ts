import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  trustKey,
  trustRepo,
  withLock,
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

const baks = async () => {
  const names = (await readdir(join(root, "cfg"))).filter((n) => n.endsWith(".bak")).sort();
  return Promise.all(names.map((n) => readFile(join(root, "cfg", n), "utf8")));
};

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
    expect(await baks()).toEqual(["{not json"]);
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

  test("non-hex values are rejected, even when queried with the same junk", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const junk = [`${"a".repeat(63)}`, "A".repeat(64), `${"a".repeat(63)}g`, "z".repeat(64)];
    for (const v of junk) {
      await writeFile(file, JSON.stringify({ version: 1, repos: { "/r": v } }));
      expect(isTrusted(await loadTrust(file), "/r", v), v).toBe(false);
    }
  });

  test("a __proto__ key and an array as repos never trust", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const h = "a".repeat(64);
    await writeFile(file, `{"repos":{"__proto__":"${h}"}}`);
    expect(isTrusted(await loadTrust(file), "__proto__", h)).toBe(false);
    await writeFile(file, `{"repos":["${h}"]}`);
    expect(isTrusted(await loadTrust(file), "0", h)).toBe(false);
  });

  test("repoSkillsHash does not depend on input order", async () => {
    await put(join(repo, ".claude", "skills"), "alpha", md("alpha"));
    await put(join(repo, ".claude", "skills"), "zeta", md("zeta"));
    const skills = (await find()).filter((s) => s.source === "repo");
    expect(skills.length).toBe(3);
    const h = repoSkillsHash(skills);
    expect(repoSkillsHash([...skills].reverse())).toBe(h);
    expect(repoSkillsHash([skills[1], skills[2], skills[0]] as typeof skills)).toBe(h);
  });

  test("dropped invalid entries keep a .bak of the original", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const text = JSON.stringify({ repos: { "/ok": "a".repeat(64), "/bad": 1 } });
    await writeFile(file, text);
    const store = await loadTrust(file);
    expect([...store.repos.keys()]).toEqual(["/ok"]);
    expect(await baks()).toEqual([]); // reading alone leaves the file untouched
    await trustRepo(file, repo, "e".repeat(64));
    expect(await baks()).toEqual([text]);
  });

  test("a second corruption never overwrites the first .bak", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    await writeFile(file, "{one");
    await loadTrust(file);
    await writeFile(file, "{two");
    await loadTrust(file);
    expect((await baks()).sort()).toEqual(["{one", "{two"]);
  });

  test("a new config dir is created 0700", async () => {
    const f = join(root, "newcfg", "deep", "t.json");
    await saveTrust(f, trust(await loadTrust(f), "/r", "b".repeat(64)));
    expect((await stat(join(root, "newcfg", "deep"))).mode & 0o777).toBe(0o700);
  });

  test("an unreadable (non-ENOENT) trust file throws and is not overwritten", async () => {
    await mkdir(file, { recursive: true });
    await expect(loadTrust(file)).rejects.toMatchObject({ code: "trust_store_unreadable" });
    await expect(trustRepo(file, repo, "c".repeat(64))).rejects.toBeTruthy();
    expect((await stat(file)).isDirectory()).toBe(true);
  });

  test("a symlinked trust file throws and is neither followed nor replaced", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const real = join(root, "real.json");
    await writeFile(real, JSON.stringify({ repos: {} }));
    await symlink(real, file);
    await expect(loadTrust(file)).rejects.toMatchObject({ code: "trust_store_unreadable" });
    await expect(trustRepo(file, repo, "c".repeat(64))).rejects.toMatchObject({
      code: "trust_store_unreadable",
    });
    expect((await readFile(real, "utf8")).includes("c".repeat(64))).toBe(false);
  });

  test("a failed save leaves no tmp file", async () => {
    await mkdir(file, { recursive: true });
    await expect(
      saveTrust(file, trust(await loadTrust(join(root, "x")), "/r", "b".repeat(64))),
    ).rejects.toBeTruthy();
    const left = (await readdir(join(root, "cfg"))).filter((n) => n.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  test("concurrent trustRepo calls both persist", async () => {
    const h2 = "2".repeat(64);
    const h3 = "3".repeat(64);
    const r2 = join(root, "r2");
    const r3 = join(root, "r3");
    await mkdir(r2);
    await mkdir(r3);
    await trustRepo(file, repo, "1".repeat(64));
    await Promise.all([trustRepo(file, r2, h2), trustRepo(file, r3, h3)]);
    const store = await loadTrust(file);
    expect(isTrusted(store, repo, "1".repeat(64))).toBe(true);
    expect(isTrusted(store, r2, h2)).toBe(true);
    expect(isTrusted(store, r3, h3)).toBe(true);
    expect(await readdir(join(root, "cfg"))).toEqual(["trusted-skills.json"]);
  });

  test("trustRepo keys by realpath; a stale lock is removed", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const lock = `${file}.lock`;
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const link = join(root, "repolink");
    await symlink(repo, link);
    const h = "d".repeat(64);
    await trustRepo(file, link, h);
    expect(isTrusted(await loadTrust(file), await trustKey(link), h)).toBe(true);
    expect(await trustKey(link)).toBe(repo);
    expect(isTrusted(await loadTrust(file), link, h)).toBe(false);
  });

  test("two waiters seeing the same stale lock never both hold it", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const lock = `${file}.lock`;
    await writeFile(lock, "dead-holder");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let holders = 0;
    let maxHolders = 0;
    let insideB!: () => void;
    const bInside = new Promise<void>((r) => {
      insideB = r;
    });
    const crit = (first: boolean) => async () => {
      holders++;
      maxHolders = Math.max(maxHolders, holders);
      if (first) insideB();
      await new Promise((r) => setTimeout(r, 150));
      holders--;
    };
    let seen = 0;
    // A judges the lock stale, then stalls until B holds a fresh lock.
    const a = withLock(file, crit(false), {
      afterStaleSeen: async () => {
        if (seen++ === 0) await bInside;
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = withLock(file, crit(true), {
      afterStaleSeen: async () => {
        seen++;
      },
    });
    await Promise.all([a, b]);
    expect(maxHolders).toBe(1);
  });

  test("a holder whose lock was stolen does not delete the new holder's lock", async () => {
    await mkdir(join(root, "cfg"), { recursive: true });
    const lock = `${file}.lock`;
    await withLock(file, async () => {
      await rm(lock);
      await writeFile(lock, "someone-else");
    });
    expect(await readFile(lock, "utf8")).toBe("someone-else");
  });
});
