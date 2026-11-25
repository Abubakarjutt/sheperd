import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  loadTrust,
  repoSkillsHash,
  resolveSkills,
  type Skill,
  trustKey,
} from "@rewire/skills";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSkillFiles, TrustPrompt } from "../src/trust-prompt.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let root: string;
let repo: string;
let file: string;
let found: Skill[];
let pending: Skill[];

const md = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rewire-tui-trust-")));
  repo = join(root, "repo");
  const dir = join(repo, ".claude", "skills", "deploy");
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), md("deploy", "ships it \x1b]52;c;aGk=\x07now"));
  await writeFile(join(dir, "scripts", "run.sh"), "echo hi\n");
  await mkdir(join(root, "home"), { recursive: true });
  ({ skills: found } = await discoverSkills({
    home: join(root, "home"),
    xdgConfig: join(root, "xdg"),
    repo,
  }));
  pending = resolveSkills(found, false).pendingRepo;
  file = join(root, "xdg", "rewire", "trusted-skills.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function mount(onDone: (t: boolean) => void) {
  return render(
    <TrustPrompt pending={pending} found={found} repo={repo} trustFile={file} onDone={onDone} />,
  );
}

describe("TrustPrompt", () => {
  it("shows each repo skill's name and description, sanitized, with the keys", () => {
    expect(pending.map((s) => s.name)).toEqual(["deploy"]);
    const v = mount(() => {});
    const f = v.lastFrame() ?? "";
    expect(f).toContain("deploy");
    expect(f).toContain("ships it");
    expect(f).not.toContain("\x1b]52");
    expect(f).toContain("[y]es [n]o [v]iew files");
    v.unmount();
  });

  it("y writes the store with a hash equal to repoSkillsHash, under trustKey(repo)", async () => {
    const onDone = vi.fn();
    const v = mount(onDone);
    v.stdin.write("y");
    await tick(150);
    expect(onDone).toHaveBeenCalledWith(true);
    const store = await loadTrust(file);
    expect(store.repos.get(await trustKey(repo))).toBe(repoSkillsHash(found));
    v.unmount();
  });

  it("n keeps them pending and writes nothing", async () => {
    const onDone = vi.fn();
    const v = mount(onDone);
    v.stdin.write("n");
    await tick();
    expect(onDone).toHaveBeenCalledWith(false);
    expect((await loadTrust(file)).repos.size).toBe(0);
    v.unmount();
  });

  it("v lists the skill's files with their sizes", async () => {
    const v = mount(() => {});
    v.stdin.write("v");
    await tick(150);
    const f = v.lastFrame() ?? "";
    expect(f).toMatch(/SKILL\.md\s+\d+ B/);
    expect(f).toContain("scripts/run.sh  8 B");
    v.unmount();
  });

  it("an unreadable trust store is a red line with its code; the skills stay pending", async () => {
    await mkdir(join(root, "xdg", "rewire"), { recursive: true });
    await writeFile(join(root, "elsewhere.json"), "{}");
    await symlink(join(root, "elsewhere.json"), file);
    const onDone = vi.fn();
    const v = mount(onDone);
    v.stdin.write("y");
    await tick(150);
    expect(v.lastFrame()).toContain("trust_store_unreadable");
    expect(onDone).not.toHaveBeenCalled();
    v.stdin.write("x");
    await tick();
    expect(onDone).toHaveBeenCalledWith(false);
    v.unmount();
  });
});

describe("listSkillFiles", () => {
  it("never follows a symlink and caps the listing", async () => {
    const dir = join(root, "d");
    await mkdir(dir);
    await writeFile(join(root, "secret"), "x".repeat(100));
    await symlink(join(root, "secret"), join(dir, "link"));
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}\x1b[2J`), "ab");
    const r = await listSkillFiles(dir, 3);
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(3);
    const all = await listSkillFiles(dir);
    const link = all.entries.find((e) => e.path === "link");
    expect(link?.symlink).toBe(true);
    expect(link?.bytes).not.toBe(100);
  });
});
