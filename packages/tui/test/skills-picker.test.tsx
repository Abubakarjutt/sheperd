import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contract } from "@rewire/core";
import type { ChatSession, PendingPrompt, RunController, RunHandle } from "@rewire/session";
import type { Skill } from "@rewire/skills";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App, type AppProps, type SkillsInfo } from "../src/app.js";
import { DETAIL_FILE_ROWS, SkillsPicker, skillRows } from "../src/skills-picker.js";

const SGR = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g");
const plain = (s: string | undefined): string => (s ?? "").replace(SGR, "");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type View = {
  lastFrame: () => string | undefined;
  stdin: { write: (s: string) => void };
};

async function waitFor(v: View, ok: (f: string) => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok(plain(v.lastFrame()))) return;
    await tick(15);
  }
  throw new Error(`timed out waiting for ${what}; last frame:\n${plain(v.lastFrame())}`);
}
const waitText = (v: View, needle: string) => waitFor(v, (f) => f.includes(needle), needle);

/** Presses `key` until `ok` holds (a panel's key handler attaches after its first frame). */
async function pressUntil(v: View, key: string, ok: (f: string) => boolean, what: string) {
  for (let i = 0; i < 10; i++) {
    v.stdin.write(key);
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if (ok(plain(v.lastFrame()))) return;
      await tick(15);
    }
  }
  await waitFor(v, ok, what);
}
const pressFor = (v: View, key: string, needle: string) =>
  pressUntil(v, key, (f) => f.includes(needle), needle);

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const selectedRow = (f: string): string =>
  f.split("\n").find((l) => l.trimStart().startsWith("❯")) ?? "";
const INPUT_HINT = "Ask about the code";

async function enter(v: View, text: string) {
  v.stdin.write(text);
  await waitText(v, text);
  await pressUntil(v, KEY.enter, (f) => !f.includes(`${text}▌`), `${text} submitted`);
}

function fakeSession() {
  const sent: string[] = [];
  const session = {
    send: async (t: string) => {
      sent.push(t);
      return { text: "ok" };
    },
    history: () => [],
    id: () => "s1",
    dispose: async () => {},
  } as unknown as ChatSession;
  return { session, sent };
}

function mount(props: Partial<AppProps> & { session: ChatSession }) {
  return render(<App runController={{} as RunController} config={{}} {...props} />);
}

/** A run that never ends and asks nothing. */
function idleRun(): RunHandle {
  return promptRun(() => undefined).run;
}

/** A run that never ends; its pending prompt is whatever `prompt()` says now. */
function promptRun(prompt: () => PendingPrompt | undefined) {
  const done = new Promise(() => {});
  const answer = vi.fn(() => true);
  const run = {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true, value: undefined };
        },
      }),
    },
    pending: prompt,
    answer,
    abort: () => {},
    done,
  } as unknown as RunHandle;
  return { run, answer };
}

const contract: Contract = {
  id: "C-1",
  title: "Add parser",
  criteria: [{ id: "AC-1", kind: "change", statement: "parse() returns tokens" }],
  nonGoals: [],
  affectedAreas: [],
  openQuestions: [],
};

let root = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rewire-tui-skills-picker-")));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A skill whose dir exists with `files` (name → content). */
async function skill(
  name: string,
  source: "user" | "repo",
  o: { description?: string; files?: Record<string, string>; shadowed?: boolean } = {},
): Promise<Skill> {
  const dir = join(root, source, `${name.replace(/[^a-z0-9-]/gi, "_")}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  const files = o.files ?? { "SKILL.md": "x" };
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return {
    name,
    description: o.description ?? `${name} does things`,
    source,
    dir,
    files: Object.entries(files).map(([path, c]) => ({ path, bytes: c.length })),
    body: "",
    modelInvocable: true,
    ...(o.shadowed ? { shadowed: true } : {}),
  };
}

function info(found: Skill[], active: Skill[], pendingRepo: Skill[]): SkillsInfo {
  return { found, active, pendingRepo, repo: join(root, "repo"), trustFile: join(root, "t.json") };
}

async function fixture() {
  const zeta = await skill("zeta", "user");
  const alpha = await skill("alpha", "user");
  const gammaUser = await skill("gamma", "user");
  const beta = await skill("beta", "repo");
  const gammaRepo = await skill("gamma", "repo", { shadowed: true });
  const found = [zeta, beta, gammaRepo, alpha, gammaUser];
  return info(found, [zeta, alpha, gammaUser], [beta]);
}

describe("skillRows", () => {
  it("sorts active first, then by name, with each skill's state", async () => {
    const s = await fixture();
    expect(skillRows(s, false).map((r) => `${r.skill.name}/${r.skill.source}/${r.state}`)).toEqual([
      "alpha/user/active",
      "gamma/user/active",
      "zeta/user/active",
      "beta/repo/pending trust",
      "gamma/repo/shadowed",
    ]);
    expect(skillRows(s, true).find((r) => r.skill.name === "beta")?.state).toBe(
      "trusted; takes effect in a new session (/clear)",
    );
  });

  it("a repo skill neither active nor pending is not trusted", async () => {
    const s = await skill("orphan", "repo");
    expect(skillRows(info([s], [], []), false)[0]?.state).toBe("not trusted");
  });
});

describe("/skills list", () => {
  it("opens a list with the review row first, then the skills in order", async () => {
    const { session } = fakeSession();
    const v = mount({ session, skills: await fixture() });
    await enter(v, "/skills");
    await waitText(v, "Review pending repo skills");
    const f = plain(v.lastFrame());
    const names = f
      .split("\n")
      .filter((l) => /(user|repo) · /.test(l))
      .map((l) => l.replace("❯", "").trim().split(/\s+/)[0]);
    expect(names).toEqual(["alpha", "gamma", "zeta", "beta", "gamma"]);
    expect(f).toContain("user · active");
    expect(f).toContain("repo · pending trust");
    expect(f).toContain("repo · shadowed");
    expect(selectedRow(f)).toContain("Review pending repo skills");
    expect(f).not.toContain(INPUT_HINT);
    v.unmount();
  });

  it("the review row opens the existing trust prompt", async () => {
    const { session } = fakeSession();
    const v = mount({ session, skills: await fixture() });
    await enter(v, "/skills");
    await waitText(v, "Review pending repo skills");
    await pressFor(v, KEY.enter, "[y]es [n]o [v]iew files");
    expect(plain(v.lastFrame())).not.toContain("Review pending repo skills");
    await pressFor(v, "n", "repo skills stay pending for this session");
    v.unmount();
  });

  it("there is no review row without pending repo skills", async () => {
    const { session } = fakeSession();
    const a = await skill("only", "user");
    const v = mount({ session, skills: info([a], [a], []) });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    expect(plain(v.lastFrame())).not.toContain("Review pending");
    v.unmount();
  });

  it("during a run the list opens read-only: no review row, and Esc closes it", async () => {
    const { session } = fakeSession();
    const v = mount({ session, skills: await fixture(), run: idleRun() });
    await enter(v, "/skills");
    await waitText(v, "repo · pending trust");
    expect(plain(v.lastFrame())).not.toContain("Review pending");
    await pressUntil(v, KEY.esc, (f) => !f.includes("repo · pending trust"), "list closed");
    expect(plain(v.lastFrame())).not.toContain("[y]es [n]o");
    v.unmount();
  });

  it("with no skills, /skills says so and opens nothing", async () => {
    const { session } = fakeSession();
    const v = mount({ session, skills: info([], [], []) });
    await enter(v, "/skills");
    await waitText(v, "no skills found");
    await waitText(v, INPUT_HINT);
    v.unmount();
  });

  it("a long list scrolls", async () => {
    const { session } = fakeSession();
    const many = await Promise.all(
      Array.from({ length: 20 }, (_, i) => skill(`s${String(i).padStart(2, "0")}`, "user")),
    );
    const v = mount({ session, skills: info(many, many, []) });
    await enter(v, "/skills");
    await waitText(v, "s00");
    await pressFor(v, KEY.up, "20/20");
    const f = plain(v.lastFrame());
    expect(selectedRow(f)).toContain("s19");
    expect(f).not.toContain("s00");
    v.unmount();
  });
});

describe("/skills details", () => {
  it("Enter shows description, source, path and the files on disk; Esc goes back, then closes", async () => {
    const { session, sent } = fakeSession();
    const a = await skill("deploy", "user", {
      description: "ships the build",
      files: { "SKILL.md": "abc", "scripts/run.sh": "echo" },
    });
    const v = mount({ session, skills: info([a], [a], []) });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    await pressFor(v, KEY.enter, "files on disk now");
    await waitText(v, "scripts/run.sh  4 B");
    const f = plain(v.lastFrame());
    expect(f).toContain("description: ships the build");
    expect(f).toContain("source: user · active");
    expect(f).toContain("path: ");
    expect(f).toContain("SKILL.md  3 B");
    v.stdin.write("xyz");
    await tick(80);
    await pressUntil(
      v,
      KEY.esc,
      (fr) => fr.includes("user · active") && !fr.includes("files on disk"),
      "back to the list",
    );
    v.stdin.write("abc");
    await tick(80);
    await pressUntil(v, KEY.esc, (fr) => fr.includes(INPUT_HINT), "closed");
    const end = plain(v.lastFrame());
    for (const s of ["xyz", "abc"]) expect(end).not.toContain(s);
    v.stdin.write(KEY.enter);
    await tick(80);
    expect(sent).toEqual([]);
    v.unmount();
  });

  it("the file list is bounded", async () => {
    const { session } = fakeSession();
    const files: Record<string, string> = {};
    for (let i = 0; i < DETAIL_FILE_ROWS + 5; i++) files[`f${String(i).padStart(2, "0")}.md`] = "x";
    const a = await skill("big", "user", { files });
    const v = mount({ session, skills: info([a], [a], []) });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    await pressFor(v, KEY.enter, "… 5 more");
    const f = plain(v.lastFrame());
    expect(f).toContain("f00.md");
    expect(f).not.toContain(`f${DETAIL_FILE_ROWS}.md`);
    v.unmount();
  });

  it("a dir that cannot be read says so", async () => {
    const { session } = fakeSession();
    const a = await skill("gone", "user");
    await rm(a.dir, { recursive: true, force: true });
    const v = mount({ session, skills: info([a], [a], []) });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    await pressFor(v, KEY.enter, "cannot read the files: ENOENT");
    v.unmount();
  });

  it("terminal escapes in names, descriptions and paths are sanitized", async () => {
    const { session } = fakeSession();
    const a = await skill("evil\x1b[2Jname", "user", {
      description: "desc\x1b]52;c;aGk=\x07ription",
    });
    const b = { ...a, dir: `${a.dir}\x1b[31m` };
    const v = mount({ session, skills: info([b], [b], []) });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    let raw = v.lastFrame() ?? "";
    expect(raw).not.toContain("\x1b[2J");
    await pressFor(v, KEY.enter, "files on disk now");
    raw = v.lastFrame() ?? "";
    expect(plain(raw)).toContain("description: desc");
    for (const bad of ["\x1b[2J", "\x1b]52", "\x07", "\x1b[31m"]) expect(raw).not.toContain(bad);
    v.unmount();
  });

  it("terminal escapes in file names are sanitized in the details", async () => {
    const a = await skill("files", "user");
    const listFiles = async () => ({
      entries: [{ path: "a\x1b[2Jb\x1b]52;c;aGk=\x07.md", bytes: 3 }],
      truncated: false,
    });
    const v = render(
      <SkillsPicker
        skills={{ found: [a], active: [a], pendingRepo: [] }}
        trustedLater={false}
        canReview={false}
        onReview={() => {}}
        onClose={() => {}}
        listFiles={listFiles}
      />,
    );
    await waitText(v, "user · active");
    await pressFor(v, KEY.enter, ".md  3 B");
    const raw = v.lastFrame() ?? "";
    for (const bad of ["\x1b[2J", "\x1b]52", "\x07"]) expect(raw).not.toContain(bad);
    expect(plain(raw)).toContain("ab");
    v.unmount();
  });

  it("Esc in the list does not interrupt anything and never reaches the input", async () => {
    const { session, sent } = fakeSession();
    const onExit = vi.fn();
    const a = await skill("one", "user");
    const v = mount({ session, skills: info([a], [a], []), onExit });
    await enter(v, "/skills");
    await waitText(v, "user · active");
    await pressUntil(v, KEY.esc, (f) => f.includes(INPUT_HINT), "closed");
    v.stdin.write("hello");
    await waitText(v, "hello");
    await pressUntil(v, KEY.enter, () => sent.length > 0, "sent");
    expect(sent).toEqual(["hello"]);
    expect(onExit).not.toHaveBeenCalled();
    v.unmount();
  });
});

describe("/skills during a run's prompts", () => {
  it("a clarification closes the list and its answer can be typed (M1)", async () => {
    const { session } = fakeSession();
    let pending: PendingPrompt | undefined;
    const { run, answer } = promptRun(() => pending);
    const v = mount({ session, skills: await fixture(), run });
    await enter(v, "/skills");
    await waitText(v, "repo · pending trust");
    pending = { kind: "clarify", questions: ["Which file?"] };
    await waitText(v, "Which file?");
    await waitFor(v, (f) => !f.includes("repo · pending trust"), "the list closed");
    await enter(v, "src/a.ts");
    await waitFor(v, () => answer.mock.calls.length === 1, "the answer");
    expect(answer).toHaveBeenCalledWith(pending, ["src/a.ts"]);
    v.unmount();
  });

  it("after a checkpoint the list stays closed and the input is back (M3)", async () => {
    const { session } = fakeSession();
    let pending: PendingPrompt | undefined;
    const { run } = promptRun(() => pending);
    const v = mount({ session, skills: await fixture(), run });
    await enter(v, "/skills");
    await waitText(v, "repo · pending trust");
    pending = { kind: "checkpoint", checkpoint: { kind: "contract", contract } };
    await waitText(v, "Add parser");
    await waitFor(v, (f) => !f.includes("repo · pending trust"), "the list gave way");
    pending = undefined; // answered elsewhere: the checkpoint goes
    await waitFor(v, (f) => !f.includes("Add parser"), "the checkpoint gone");
    await tick(200);
    const f = plain(v.lastFrame());
    expect(f).not.toContain("repo · pending trust");
    expect(f).toContain("> ");
    v.unmount();
  });
});
