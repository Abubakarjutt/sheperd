import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  discoverSkills,
  hashSkill,
  materializeSkill,
  parseSkillMd,
  validateSkillMd,
} from "../src/index.js";

let root: string;
let home: string;
let xdgConfig: string;
let repo: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rewire-skills-fix-")));
  home = join(root, "home");
  xdgConfig = join(home, ".config");
  repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const md = (name: string, description: string, body = "# Body\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const userDir = (n: string) => join(home, ".claude", "skills", n);
const repoDir = (n: string) => join(repo, ".claude", "skills", n);
const opts = () => ({ home, xdgConfig, repo });
const homeOpts = () => ({ home, xdgConfig });

/** Every file's text under `dir` (empty when `dir` does not exist). */
async function allFileText(dir: string): Promise<string> {
  let out = "";
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out += await readFile(p, "utf8");
    }
  };
  await walk(dir);
  return out;
}

describe("C1: credential globs match dot segments", () => {
  const cases: Array<[string, string]> = [
    ["claude-creds", ".claude/.credentials.json"],
    ["ssh-key", ".ssh/id_ed25519"],
    ["dot-env", ".config/app/.env"],
    ["backup-key", "backup/.old/id_ed25519"],
  ];
  for (const [label, target] of cases) {
    test(`a user skill file linked to ~/${target} is rejected and never copied`, async () => {
      await put(join(home, target), `SECRET_${label}\n`);
      await put(join(userDir("s"), "SKILL.md"), md("s", "S."));
      await symlink(join(home, target), join(userDir("s"), "notes.md"));
      const result = await discoverSkills(opts());
      const s = result.skills[0];
      if (!s) throw new Error("missing");
      await expect(hashSkill(s, homeOpts())).rejects.toMatchObject({ code: "skill_invalid" });
      const dest = join(root, "scratch", "s");
      await expect(materializeSkill(s, dest, homeOpts())).rejects.toMatchObject({
        code: "skill_invalid",
      });
      expect(await allFileText(dest)).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });
  }

  test("a user SKILL.md linked to ~/.claude/.credentials.json is a discovery problem", async () => {
    await put(join(home, ".claude", ".credentials.json"), md("x", "SECRET_TOKEN"));
    await mkdir(userDir("x"), { recursive: true });
    await symlink(join(home, ".claude", ".credentials.json"), join(userDir("x"), "SKILL.md"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  test("a plain .env file inside a user skill dir is rejected and never copied", async () => {
    await put(join(userDir("e"), "SKILL.md"), md("e", "E."));
    await put(join(userDir("e"), ".env"), "SECRET_PLAIN=1\n");
    const { skills } = await discoverSkills(opts());
    const s = skills[0];
    if (!s) throw new Error("missing");
    const dest = join(root, "scratch", "e");
    await expect(materializeSkill(s, dest, homeOpts())).rejects.toMatchObject({
      code: "skill_invalid",
    });
    expect(await allFileText(dest)).not.toContain("SECRET");
  });
});

test("M7 / Review Focus 2: a repo skill symlink to <home>/.ssh/id_ed25519 is rejected", async () => {
  await put(join(home, ".ssh", "id_ed25519"), "SECRET_KEY\n");
  await put(join(repoDir("r"), "SKILL.md"), md("r", "R."));
  await symlink(join(home, ".ssh", "id_ed25519"), join(repoDir("r"), "key"));
  const result = await discoverSkills(opts());
  expect(result.skills).toEqual([]);
  expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

describe("I1: the frontmatter reader is linear", () => {
  test("a 256 KiB hostile line parses or is rejected in < 200 ms", () => {
    const payloads = [
      `---\nname:${" ".repeat(262104)}x\ry\n---\n`,
      `---\nname:${"a".repeat(262104)}\r\n---\n`,
      `---\n${"a".repeat(262104)}\ry\n---\n`,
      `---\nname:${" ".repeat(262104)}x y\n---\n`,
    ];
    for (const p of payloads) {
      const t = performance.now();
      try {
        parseSkillMd(p);
      } catch {
        // rejection is fine; only the time matters
      }
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});

describe("I2: non-regular files are never opened for read", () => {
  test("a FIFO SKILL.md is skill_invalid for both sources, without hanging", async () => {
    await mkdir(userDir("u"), { recursive: true });
    await mkdir(repoDir("r"), { recursive: true });
    execFileSync("mkfifo", [join(userDir("u"), "SKILL.md")]);
    execFileSync("mkfifo", [join(repoDir("r"), "SKILL.md")]);
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid", "skill_invalid"]);
  }, 5000);

  test("a FIFO inside a skill dir is skill_invalid for both sources", async () => {
    await put(join(userDir("u"), "SKILL.md"), md("u", "U."));
    await put(join(repoDir("r"), "SKILL.md"), md("r", "R."));
    execFileSync("mkfifo", [join(userDir("u"), "pipe")]);
    execFileSync("mkfifo", [join(repoDir("r"), "pipe")]);
    const result = await discoverSkills(opts());
    expect(result.problems.map((p) => [p.dir, p.code])).toEqual([[repoDir("r"), "skill_invalid"]]);
    const u = result.skills[0];
    if (!u) throw new Error("missing");
    await expect(hashSkill(u, homeOpts())).rejects.toMatchObject({ code: "skill_invalid" });
  }, 5000);
});

test("M2: a hardlinked file in a repo skill is skill_invalid", async () => {
  await put(join(home, ".ssh", "id_ed25519"), "SECRET_KEY\n");
  await put(join(repoDir("h"), "SKILL.md"), md("h", "H."));
  await link(join(home, ".ssh", "id_ed25519"), join(repoDir("h"), "key"));
  const result = await discoverSkills(opts());
  expect(result.skills).toEqual([]);
  expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("M4: control characters are stripped from the description; whitespace collapses", async () => {
  await put(
    join(userDir("c"), "SKILL.md"),
    '---\nname: c\ndescription: "a\\u001b]52;c;eA==\\u0007b \\u0000\\tc\\n  d"\n---\n',
  );
  const { skills, problems } = await discoverSkills(opts());
  expect(problems).toEqual([]);
  expect(skills[0]?.description).toBe("ab c d");
});

test("M4: a name with control characters is skill_invalid", () => {
  const parsed = parseSkillMd('---\nname: "a\\u001bb"\ndescription: d\n---\n');
  expect(() => validateSkillMd(parsed, "dir")).toThrow(
    expect.objectContaining({ code: "skill_invalid" }),
  );
});

test("M5: disable-model-invocation accepts true / True / TRUE / yes", () => {
  for (const v of ["true", "True", "TRUE", "yes", "Yes"]) {
    const p = parseSkillMd(`---\nname: x\ndescription: d\ndisable-model-invocation: ${v}\n---\n`);
    expect(p.modelInvocable).toBe(false);
  }
  const f = parseSkillMd("---\nname: x\ndescription: d\ndisable-model-invocation: false\n---\n");
  expect(f.modelInvocable).toBe(true);
});

test("M6: a missing name falls back to the directory name (as Claude Code does)", async () => {
  await put(join(userDir("from-dir"), "SKILL.md"), "---\ndescription: No name key.\n---\nb\n");
  const { skills, problems } = await discoverSkills(opts());
  expect(problems).toEqual([]);
  expect(skills[0]?.name).toBe("from-dir");
});

test("M8: filenames in problem messages are stripped of control chars and capped", async () => {
  await put(join(repoDir("m"), "SKILL.md"), md("m", "M."));
  // Nested so the relative path is > 200 chars (one name is capped at 255 bytes).
  const evil = join(`\u001b[31m${"x".repeat(240)}`, "y".repeat(240));
  await mkdir(dirname(join(repoDir("m"), evil)), { recursive: true });
  await symlink("/nonexistent", join(repoDir("m"), evil));
  const { problems } = await discoverSkills(opts());
  expect(problems).toHaveLength(1);
  const msg = problems[0]?.message ?? "";
  expect([...msg].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(false);
  expect(msg).not.toContain("\u001b");
  expect(msg.length).toBeLessThanOrEqual(300);
});
