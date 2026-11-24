import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { discoverSkills, hashSkill, hashSkillDir, parseSkillMd } from "../src/index.js";

let root: string;
let home: string;
let xdgConfig: string;
let repo: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rewire-skills-")));
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

/** Every string reachable from the result, so a leak anywhere is caught. */
const allText = (x: unknown): string => JSON.stringify(x);

describe("discoverSkills", () => {
  test("a valid user skill parses name, description and body", async () => {
    await put(join(userDir("hello"), "SKILL.md"), md("hello", "Say hello.", "# Hi\nthere\n"));
    const { skills, problems } = await discoverSkills(opts());
    expect(problems).toEqual([]);
    expect(skills).toHaveLength(1);
    const s = skills[0];
    expect(s?.name).toBe("hello");
    expect(s?.description).toBe("Say hello.");
    expect(s?.source).toBe("user");
    expect(s?.body).toBe("# Hi\nthere\n");
    expect(s?.modelInvocable).toBe(true);
    expect(s?.dir).toBe(userDir("hello"));
  });

  test("XDG user skills are discovered too", async () => {
    await put(join(xdgConfig, "rewire", "skills", "x1", "SKILL.md"), md("x1", "From xdg."));
    const { skills, problems } = await discoverSkills(opts());
    expect(problems).toEqual([]);
    expect(skills.map((s) => [s.name, s.source])).toEqual([["x1", "user"]]);
  });

  test("the user skill wins a name collision; the repo skill is listed as shadowed", async () => {
    await put(join(userDir("dup"), "SKILL.md"), md("dup", "User copy."));
    await put(join(repoDir("dup"), "SKILL.md"), md("dup", "Repo copy."));
    const { skills, problems } = await discoverSkills(opts());
    expect(problems).toEqual([]);
    const user = skills.find((s) => s.source === "user");
    const repoSkill = skills.find((s) => s.source === "repo");
    expect(user?.description).toBe("User copy.");
    expect(user?.shadowed).toBeFalsy();
    expect(repoSkill?.shadowed).toBe(true);
  });

  test("repo skills are hashed at discovery and list their files", async () => {
    await put(join(repoDir("r"), "SKILL.md"), md("r", "Repo."));
    await put(join(repoDir("r"), "scripts", "run.sh"), "echo hi\n");
    const { skills } = await discoverSkills(opts());
    const s = skills[0];
    expect(s?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s?.sha256).toBe(await hashSkillDir(repoDir("r")));
    expect(s?.files).toEqual([
      { path: "SKILL.md", bytes: Buffer.byteLength(md("r", "Repo.")) },
      { path: "scripts/run.sh", bytes: 8 },
    ]);
  });

  test("user skills are not hashed at discovery; hashSkill computes it lazily", async () => {
    await put(join(userDir("u"), "SKILL.md"), md("u", "User."));
    await put(join(userDir("u"), "ref.md"), "ref\n");
    const { skills } = await discoverSkills(opts());
    const s = skills[0];
    if (!s) throw new Error("missing skill");
    expect(s.sha256).toBeUndefined();
    expect(await hashSkill(s, { home, xdgConfig })).toBe(await hashSkillDir(userDir("u")));
  });

  test("frontmatter without description is skill_invalid", async () => {
    await put(join(userDir("nodesc"), "SKILL.md"), "---\nname: nodesc\n---\nbody\n");
    const { skills, problems } = await discoverSkills(opts());
    expect(skills).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("skill_invalid");
    expect(problems[0]?.dir).toBe(userDir("nodesc"));
  });

  test("a SKILL.md larger than 64 KiB is skill_invalid", async () => {
    await put(join(userDir("big"), "SKILL.md"), md("big", "Big.", "x".repeat(64 * 1024)));
    const { skills, problems } = await discoverSkills(opts());
    expect(skills).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(["skill_invalid"]);
  });

  test('name "../x" is skill_invalid', async () => {
    await put(join(userDir("x"), "SKILL.md"), md('"../x"', "Escape."));
    const { skills, problems } = await discoverSkills(opts());
    expect(skills).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(["skill_invalid"]);
  });

  test("a description over 1024 chars is skill_invalid", async () => {
    await put(join(userDir("long"), "SKILL.md"), md("long", "d".repeat(1025)));
    const { problems } = await discoverSkills(opts());
    expect(problems.map((p) => p.code)).toEqual(["skill_invalid"]);
  });

  test("a missing ~/.claude/skills dir (and no repo skills) is no error", async () => {
    await expect(discoverSkills(opts())).resolves.toEqual({ skills: [], problems: [] });
  });

  test("disable-model-invocation: true marks the skill not model-invocable", async () => {
    await put(
      join(userDir("manual"), "SKILL.md"),
      "---\nname: manual\ndescription: Manual only.\ndisable-model-invocation: true\n---\nb\n",
    );
    const { skills } = await discoverSkills(opts());
    expect(skills[0]?.modelInvocable).toBe(false);
  });
});

describe("repo skill symlinks", () => {
  test("a symlink inside a repo skill dir is skill_invalid and its content leaks nowhere", async () => {
    const secret = join(root, "outside", "secret.txt");
    await put(secret, "SECRET\n");
    await put(join(repoDir("evil"), "SKILL.md"), md("evil", "Evil."));
    await symlink(secret, join(repoDir("evil"), "notes.md"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
    await expect(hashSkillDir(repoDir("evil"))).rejects.toMatchObject({ code: "skill_invalid" });
  });

  test("a repo SKILL.md that is a symlink is skill_invalid and never read", async () => {
    const secret = join(root, "outside", "SKILL.md");
    await put(secret, md("leak", "SECRET"));
    await mkdir(repoDir("evil"), { recursive: true });
    await symlink(secret, join(repoDir("evil"), "SKILL.md"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
  });

  test("a symlinked repo skill dir is skill_invalid", async () => {
    const elsewhere = join(root, "outside", "s");
    await put(join(elsewhere, "SKILL.md"), md("s", "SECRET"));
    await mkdir(join(repo, ".claude", "skills"), { recursive: true });
    await symlink(elsewhere, repoDir("s"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
  });

  test("a symlinked <repo>/.claude/skills root is skill_invalid", async () => {
    const elsewhere = join(root, "outside", "skills");
    await put(join(elsewhere, "s", "SKILL.md"), md("s", "SECRET"));
    await mkdir(join(repo, ".claude"), { recursive: true });
    await symlink(elsewhere, join(repo, ".claude", "skills"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
  });
});

describe("user skill symlinks", () => {
  test("a user skill dir symlinked into another HOME dir is accepted", async () => {
    const target = join(home, ".agents", "skills", "linked");
    await put(join(target, "SKILL.md"), md("linked", "Linked."));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink(target, userDir("linked"));
    const { skills, problems } = await discoverSkills(opts());
    expect(problems).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["linked"]);
    const s = skills[0];
    if (!s) throw new Error("missing");
    expect(await hashSkill(s, { home, xdgConfig })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a user SKILL.md symlinked into a credential location is rejected", async () => {
    await put(join(home, ".ssh", "SKILL.md"), md("ssh", "SECRET"));
    await mkdir(userDir("ssh"), { recursive: true });
    await symlink(join(home, ".ssh", "SKILL.md"), join(userDir("ssh"), "SKILL.md"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
  });

  test("a file inside a user skill symlinked to a credential file fails hashSkill", async () => {
    await put(join(home, ".ssh", "id_ed25519"), "SECRET\n");
    await put(join(userDir("k"), "SKILL.md"), md("k", "Key."));
    await symlink(join(home, ".ssh", "id_ed25519"), join(userDir("k"), "notes.md"));
    const { skills } = await discoverSkills(opts());
    const s = skills[0];
    if (!s) throw new Error("missing");
    const err = await hashSkill(s, { home, xdgConfig }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "skill_invalid" });
    expect(String((err as Error).message)).not.toContain("SECRET");
  });

  test("a user skill symlink pointing outside HOME is rejected", async () => {
    const outside = join(root, "outside", "o");
    await put(join(outside, "SKILL.md"), md("o", "SECRET"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink(outside, userDir("o"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid"]);
    expect(allText(result)).not.toContain("SECRET");
  });

  test("a symlink cycle is rejected, not followed forever", async () => {
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink(userDir("b"), userDir("a"));
    await symlink(userDir("a"), userDir("b"));
    const result = await discoverSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.problems.map((p) => p.code)).toEqual(["skill_invalid", "skill_invalid"]);
  });

  test("a directory symlink back to an ancestor inside a user skill fails hashSkill", async () => {
    await put(join(userDir("loop"), "SKILL.md"), md("loop", "Loop."));
    await symlink(userDir("loop"), join(userDir("loop"), "self"));
    const { skills } = await discoverSkills(opts());
    const s = skills[0];
    if (!s) throw new Error("missing");
    await expect(hashSkill(s, { home, xdgConfig })).rejects.toMatchObject({
      code: "skill_invalid",
    });
  });
});

describe("hashing", () => {
  test("the hash is identical for two copies made in a different creation order", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await put(join(a, "SKILL.md"), md("h", "H."));
    await put(join(a, "x", "one.txt"), "1");
    await put(join(a, "two.txt"), "2");
    await put(join(b, "two.txt"), "2");
    await put(join(b, "x", "one.txt"), "1");
    await put(join(b, "SKILL.md"), md("h", "H."));
    expect(await hashSkillDir(a)).toBe(await hashSkillDir(b));
    await writeFile(join(b, "two.txt"), "3");
    expect(await hashSkillDir(a)).not.toBe(await hashSkillDir(b));
  });

  test("a skill dir over 200 files is skill_invalid", async () => {
    const d = join(root, "many");
    for (let i = 0; i < 201; i++) await put(join(d, `f${i}.txt`), "x");
    await expect(hashSkillDir(d)).rejects.toMatchObject({ code: "skill_invalid" });
  });

  test("a skill dir over 2 MiB is skill_invalid", async () => {
    const d = join(root, "huge");
    await put(join(d, "a.bin"), "x".repeat(1024 * 1024 + 1));
    await put(join(d, "b.bin"), "x".repeat(1024 * 1024));
    await expect(hashSkillDir(d)).rejects.toMatchObject({ code: "skill_invalid" });
  });
});

describe("parseSkillMd", () => {
  test("quoted scalars, block scalars and ignored list keys", () => {
    const p = parseSkillMd(
      [
        "---",
        "name: 'quoted-name'",
        "version: 1.2.0",
        "allowed-tools:",
        "  - Bash",
        "  - Read",
        "description: >",
        "  Folded line one",
        "  and line two.",
        "",
        "  New paragraph.",
        "triggers: [a, b]",
        "---",
        "body",
      ].join("\n"),
    );
    expect(p.name).toBe("quoted-name");
    expect(p.description).toBe("Folded line one and line two.\nNew paragraph.");
    expect(p.body).toBe("body");
  });

  test("literal block scalar keeps newlines; double quotes unescape", () => {
    const p = parseSkillMd('---\nname: "a-b"\ndescription: |\n  line one\n  line two\n---\n');
    expect(p.name).toBe("a-b");
    expect(p.description).toBe("line one\nline two");
    const q = parseSkillMd('---\nname: x\ndescription: "say \\"hi\\" # not a comment"\n---\n');
    expect(q.description).toBe('say "hi" # not a comment');
    const r = parseSkillMd("---\nname: x\ndescription: it''s ok\n---\n");
    expect(r.description).toBe("it''s ok");
    const s = parseSkillMd("---\nname: x\ndescription: 'it''s ok'\n---\n");
    expect(s.description).toBe("it's ok");
  });

  test("no frontmatter throws skill_invalid", () => {
    expect(() => parseSkillMd("# just markdown\n")).toThrow(
      expect.objectContaining({ code: "skill_invalid" }),
    );
  });
});

test("a fixture tree shaped like a real ~/.claude/skills", async () => {
  const skills = join(home, ".claude", "skills");
  // 1. a skill dir symlinked into ~/.agents/skills
  await put(join(home, ".agents", "skills", "ask-matt", "SKILL.md"), md("ask-matt", "Ask Matt."));
  await mkdir(skills, { recursive: true });
  await symlink(join(home, ".agents", "skills", "ask-matt"), join(skills, "ask-matt"));
  // 2. gstack-style: SKILL.md is itself a symlink into a sibling dir
  await put(
    join(skills, "gstack", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "preamble-tier: 2",
      "version: 1.0.0",
      "description: |",
      "  Pre-landing PR review.",
      "  (gstack)",
      "allowed-tools:",
      "  - Bash",
      "  - Read",
      "triggers:",
      "  - review this",
      "",
      "---",
      "Review body.",
    ].join("\n"),
  );
  await put(join(skills, "gstack", "SKILL.md"), md("gstack", "Router for gstack."));
  await mkdir(join(skills, "review"), { recursive: true });
  await symlink(join(skills, "gstack", "review", "SKILL.md"), join(skills, "review", "SKILL.md"));
  await symlink(join(skills, "gstack", "bin"), join(skills, "review", "bin")).catch(() => {});
  await mkdir(join(skills, "gstack", "bin"), { recursive: true });
  await put(join(skills, "gstack", "bin", "tool"), "#!/bin/sh\n");
  // 3. a `_bad` name
  await put(join(skills, "_bad", "SKILL.md"), md("_bad", "Bad name."));
  // 4. a `.trash` dir without SKILL.md, and a stray file
  await put(join(skills, ".trash", "old", "notes.md"), "old\n");
  await put(join(skills, "README.md"), "readme\n");

  const result = await discoverSkills(opts());
  expect(result.skills.map((s) => s.name).sort()).toEqual(["ask-matt", "gstack", "review"]);
  expect(result.problems.map((p) => [p.dir, p.code])).toEqual([
    [join(skills, "_bad"), "skill_invalid"],
  ]);
  const review = result.skills.find((s) => s.name === "review");
  expect(review?.description).toBe("Pre-landing PR review.\n(gstack)");
  expect(review?.body).toBe("Review body.");
  if (!review) throw new Error("missing");
  expect(await hashSkill(review, { home, xdgConfig })).toMatch(/^[0-9a-f]{64}$/);
});
