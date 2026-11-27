import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import type {
  ChatSession,
  ChatTurn,
  PendingPrompt,
  RunController,
  RunHandle,
} from "@rewire/session";
import { discoverSkills, loadTrust, resolveSkills, type Skill, trustKey } from "@rewire/skills";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "../src/app.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const enter = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick(80);
};

type Msg = { role: "user" | "assistant" | "tool"; content: string };

function fakeSession(opts: { send?: (t: string) => Promise<ChatTurn>; history?: Msg[] } = {}) {
  const sent: string[] = [];
  const dispose = vi.fn(async () => {});
  const session = {
    send: (t: string) => {
      sent.push(t);
      return (opts.send ?? (async () => ({ text: "ok" })))(t);
    },
    history: () => opts.history ?? [],
    dispose,
  } as unknown as ChatSession;
  return { session, sent, dispose };
}

function fakeRun(prompt: () => PendingPrompt | undefined, accept = true) {
  let finish: (o: unknown) => void = () => {};
  const done = new Promise((r) => {
    finish = r;
  });
  const answer = vi.fn((_p: PendingPrompt, _v: unknown) => accept);
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
  return { run, answer, finish };
}

function controller(run?: RunHandle) {
  const start = vi.fn((_task: string, _o: { checkpoints: Set<string> }) => {
    if (!run) throw new RewireError("run_in_progress", "a gated run is already in progress");
    return run;
  });
  return { rc: { start } as unknown as RunController, start };
}

function mount(props: Partial<AppProps> & { session: ChatSession }) {
  return render(<App runController={{} as RunController} config={{}} {...props} />);
}

describe("slash commands", () => {
  it("an unknown command is reported and not sent to the model", async () => {
    const { session, sent } = fakeSession();
    const v = mount({ session });
    await enter(v.stdin, "/frob now");
    expect(v.lastFrame()).toContain("unknown command /frob");
    expect(sent).toEqual([]);
  });

  it("a // line is sent as text with one slash removed", async () => {
    const { session, sent } = fakeSession();
    const v = mount({ session });
    await enter(v.stdin, "//etc/hosts is odd");
    expect(sent).toEqual(["/etc/hosts is odd"]);
  });

  it("/run with no task shows the usage", async () => {
    const { session } = fakeSession();
    const v = mount({ session });
    // Enter on `/run` (which needs a task) completes it to `/run ` in the menu; the next sends it.
    await enter(v.stdin, "/run");
    expect(v.lastFrame()).not.toContain("usage: /run <task>");
    await enter(v.stdin, "");
    expect(v.lastFrame()).toContain("usage: /run <task>");
  });

  it("/run <task> starts a run with the default checkpoints, skipping the model", async () => {
    const { session, sent } = fakeSession();
    const { run } = fakeRun(() => undefined);
    const { rc, start } = controller(run);
    const v = mount({ session, runController: rc });
    await enter(v.stdin, "/run add a flag");
    expect(start).toHaveBeenCalledWith("add a flag", {
      checkpoints: new Set(["contract", "tests"]),
    });
    expect(sent).toEqual([]);
  });

  it("/checkpoints changes the set for the next run and shows it", async () => {
    const { session } = fakeSession();
    const { run } = fakeRun(() => undefined);
    const { rc, start } = controller(run);
    const v = mount({ session, runController: rc });
    await enter(v.stdin, "/checkpoints");
    expect(v.lastFrame()).toContain("checkpoints: contract, tests");
    await enter(v.stdin, "/checkpoints commit");
    await enter(v.stdin, "/checkpoints bogus");
    expect(v.lastFrame()).toContain("bogus");
    await enter(v.stdin, "/run t");
    expect(start).toHaveBeenCalledWith("t", { checkpoints: new Set(["commit"]) });
  });

  it("run_in_progress is a message, not a crash", async () => {
    const { session } = fakeSession();
    const { rc } = controller(undefined);
    const v = mount({ session, runController: rc });
    await enter(v.stdin, "/run x");
    expect(v.lastFrame()).toContain("run_in_progress");
  });

  it("/model shows the routing; /doctor shows the doctor output; /help lists commands", async () => {
    const { session } = fakeSession();
    const v = mount({
      session,
      routing: () => "implementer: anthropic/claude\x1b[2J",
      doctor: async () => "git ok\nsandbox ok",
    });
    await enter(v.stdin, "/model");
    expect(v.lastFrame()).toContain("implementer: anthropic/claude");
    expect(v.lastFrame()).not.toContain("\x1b[2J");
    await enter(v.stdin, "/doctor");
    await tick();
    expect(v.lastFrame()).toContain("sandbox ok");
    await enter(v.stdin, "/help");
    expect(v.lastFrame()).toContain("/checkpoints");
  });

  it("/doctor output is redacted", async () => {
    const { session } = fakeSession();
    const secret = `ghp_${"a".repeat(36)}`;
    const v = mount({ session, doctor: async () => `token ${secret} found` });
    await enter(v.stdin, "/doctor");
    await tick();
    expect(v.lastFrame()).toContain("token");
    expect(v.lastFrame()).not.toContain(secret);
  });

  it("a line that arrives right after /run, before a re-render, is not sent to the model", async () => {
    const { session, sent } = fakeSession();
    const { run } = fakeRun(() => undefined);
    const { rc, start } = controller(run);
    const v = mount({ session, runController: rc });
    v.stdin.write("/run go");
    await tick();
    v.stdin.write("\r");
    v.stdin.write("h");
    v.stdin.write("\r");
    await tick(100);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("/exit calls onExit(0)", async () => {
    const { session } = fakeSession();
    const onExit = vi.fn();
    const v = mount({ session, onExit });
    await enter(v.stdin, "/exit");
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

describe("proposal card", () => {
  it("renders the card and y starts the run with the proposed task", async () => {
    const { session } = fakeSession({
      send: async () => ({
        text: "Proposing a run.",
        proposal: { task: "rename foo to bar" },
        endedBy: "proposal",
      }),
    });
    const { run } = fakeRun(() => undefined);
    const { rc, start } = controller(run);
    const v = mount({ session, runController: rc });
    await enter(v.stdin, "please rename foo");
    const f = v.lastFrame() ?? "";
    expect(f).toContain("rename foo to bar");
    expect(f).toContain("Run this as a gated task? [y/n]");
    v.stdin.write("y");
    await tick(80);
    expect(start).toHaveBeenCalledWith("rename foo to bar", {
      checkpoints: new Set(["contract", "tests"]),
    });
    expect(v.lastFrame()).not.toContain("Run this as a gated task?");
  });

  it("n dismisses the card without starting a run", async () => {
    const { session } = fakeSession({
      send: async () => ({ text: "", proposal: { task: "t" }, endedBy: "proposal" }),
    });
    const { rc, start } = controller(fakeRun(() => undefined).run);
    const v = mount({ session, runController: rc });
    await enter(v.stdin, "go");
    // Wait for the card, then press n until it is gone (a key sent before the card's input
    // handler attaches is lost on a slow CI runner).
    for (let i = 0; i < 100 && !(v.lastFrame() ?? "").includes("Run this as a gated task?"); i++)
      await tick(20);
    expect(v.lastFrame()).toContain("Run this as a gated task?");
    for (let i = 0; i < 20 && (v.lastFrame() ?? "").includes("Run this as a gated task?"); i++) {
      v.stdin.write("n");
      await tick(80);
    }
    expect(start).not.toHaveBeenCalled();
    expect(v.lastFrame()).not.toContain("Run this as a gated task?");
  });
});

describe("during a run", () => {
  it("chat text and most commands are refused; /help still works", async () => {
    const { session, sent } = fakeSession();
    const { run, finish } = fakeRun(() => undefined);
    const create = vi.fn();
    const deploy = { name: "deploy", description: "d", source: "repo" } as Skill;
    const v = mount({
      session,
      run,
      sessions: { create, resume: vi.fn(), list: async () => [] },
      skills: { found: [deploy], active: [], pendingRepo: [deploy], repo: "/r", trustFile: "/t" },
    });
    await tick(80);
    await enter(v.stdin, "hello");
    expect(v.lastFrame()).toContain("a run is active; answer its prompt or press Ctrl-C to abort");
    expect(sent).toEqual([]);
    await enter(v.stdin, "/help");
    expect(v.lastFrame()).toContain("/resume");
    await enter(v.stdin, "/clear");
    expect(create).not.toHaveBeenCalled();
    await enter(v.stdin, "/checkpoints off");
    await enter(v.stdin, "/checkpoints");
    expect(v.lastFrame()).toContain("checkpoints: contract, tests");
    await enter(v.stdin, "/skills");
    expect(v.lastFrame()).toContain("pending: deploy");
    expect(v.lastFrame()).not.toContain("[y]es [n]o");
    finish({ status: "verified", runId: "r", branch: "b", reportPath: "p" });
    await tick(100);
    await enter(v.stdin, "after");
    expect(sent).toEqual(["after"]);
  });

  it("a clarify prompt shows its questions and takes one typed answer per question", async () => {
    const prompt: PendingPrompt = { kind: "clarify", questions: ["Which file?", "Which name?"] };
    const { session } = fakeSession();
    const { run, answer } = fakeRun(() => prompt);
    const v = mount({ session, run });
    await tick(120);
    expect(v.lastFrame()).toContain("Which file?");
    await enter(v.stdin, "src/a.ts");
    expect(answer).not.toHaveBeenCalled();
    await enter(v.stdin, "parse");
    expect(answer).toHaveBeenCalledWith(prompt, ["src/a.ts", "parse"]);
  });

  it("/skip declines a clarify prompt; a stale prompt says so", async () => {
    const prompt: PendingPrompt = { kind: "clarify", questions: ["Q?"] };
    const { session } = fakeSession();
    const { run, answer } = fakeRun(() => prompt, false);
    const v = mount({ session, run });
    await tick(120);
    await enter(v.stdin, "/skip");
    expect(answer).toHaveBeenCalledWith(prompt, null);
    expect(v.lastFrame()).toContain("that prompt is no longer active");
  });
});

describe("sessions", () => {
  const summaries = [
    { id: "s-new", title: "fix the \x1b[31mparser", updatedAt: new Date(Date.now() - 120_000) },
    { id: "s-old", title: "older", updatedAt: new Date(Date.now() - 7_200_000) },
  ];

  it("/resume lists sessions; an unknown id is session_not_found", async () => {
    const { session } = fakeSession();
    const resume = vi.fn();
    const v = mount({
      session,
      sessions: { list: async () => summaries, create: vi.fn(), resume },
    });
    await enter(v.stdin, "/resume");
    await tick();
    const f = v.lastFrame() ?? "";
    expect(f).toContain("s-new");
    expect(f).toContain("fix the parser");
    expect(f).toContain("2m ago");
    await enter(v.stdin, "/resume nope");
    await tick();
    expect(v.lastFrame()).toContain("session_not_found");
    expect(resume).not.toHaveBeenCalled();
  });

  it("/resume <id> swaps in the resumed session and replays its history", async () => {
    const old = fakeSession();
    const next = fakeSession({
      history: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });
    const resume = vi.fn(async () => next.session);
    const v = mount({
      session: old.session,
      sessions: { list: async () => summaries, create: vi.fn(), resume },
    });
    await enter(v.stdin, "/resume s-old");
    await tick(80);
    expect(resume).toHaveBeenCalledWith("s-old");
    expect(old.dispose).toHaveBeenCalled();
    expect(v.lastFrame()).toContain("earlier answer");
    expect(v.lastFrame()).toContain("─── resumed session s-old ───");
    await enter(v.stdin, "next");
    expect(next.sent).toEqual(["next"]);
  });

  it("/clear disposes the session, starts a fresh one and clears the transcript", async () => {
    const old = fakeSession({ send: async () => ({ text: "first reply" }) });
    const next = fakeSession();
    const create = vi.fn(async () => next.session);
    const v = mount({
      session: old.session,
      sessions: { list: async () => [], create, resume: vi.fn() },
    });
    await enter(v.stdin, "hi");
    expect(v.lastFrame()).toContain("first reply");
    await enter(v.stdin, "/clear");
    await tick(80);
    expect(old.dispose).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
    expect(v.lastFrame()).not.toContain("first reply");
    expect(v.lastFrame()).toContain("─── new session ───"); // a fresh <Static> region (I3)
    await enter(v.stdin, "again");
    expect(next.sent).toEqual(["again"]);
  });
});

describe("/skills", () => {
  it("lists skills and re-opens the trust prompt; y saves for a new session", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rewire-tui-skills-")));
    try {
      const repo = join(root, "repo");
      const dir = join(repo, ".claude", "skills", "deploy");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: deploy\ndescription: ships\n---\nb\n");
      await mkdir(join(root, "home"));
      const { skills: found } = await discoverSkills({
        home: join(root, "home"),
        xdgConfig: join(root, "xdg"),
        repo,
      });
      const { active, pendingRepo } = resolveSkills(found, false);
      const trustFile = join(root, "xdg", "rewire", "trusted-skills.json");
      const { session } = fakeSession();
      const v = mount({ session, skills: { found, active, pendingRepo, repo, trustFile } });
      await enter(v.stdin, "/skills");
      expect(v.lastFrame()).toContain("pending");
      expect(v.lastFrame()).toContain("[y]es [n]o [v]iew files");
      v.stdin.write("y");
      await tick(150);
      expect(v.lastFrame()).toContain("trusted; takes effect in a new session (/clear)");
      const store = await loadTrust(trustFile);
      expect(store.repos.has(await trustKey(repo))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Safe redacts as well as sanitizes (I2)", () => {
  const KEY = "sk-ant-api03-SECRETsecret123";

  it("a proposal task with a secret renders as [redacted]", async () => {
    const { session } = fakeSession({
      send: async () => ({ text: "", proposal: { task: `use ${KEY}` }, endedBy: "proposal" }),
    });
    const v = mount({ session });
    await enter(v.stdin, "go");
    const f = v.lastFrame() ?? "";
    expect(f).toContain("use [redacted]");
    expect(f).not.toContain("SECRET");
  });

  it("clarification questions with a secret render as [redacted]", async () => {
    const prompt: PendingPrompt = { kind: "clarify", questions: [`Is ${KEY} the key?`] };
    const { session } = fakeSession();
    const { run } = fakeRun(() => prompt);
    const v = mount({ session, run });
    await tick(120);
    const f = v.lastFrame() ?? "";
    expect(f).toContain("Is [redacted] the key?");
    expect(f).not.toContain("SECRET");
  });

  it("an escalation question with a secret renders as [redacted] in the outcome note", async () => {
    const { session } = fakeSession();
    const { run, finish } = fakeRun(() => undefined);
    const v = mount({ session, run });
    await tick(80);
    finish({
      status: "escalated",
      runId: "r",
      branch: "",
      reportPath: "/r/report.md",
      escalation: { reason: "stuck", question: `Should I rotate ${KEY}?` },
    });
    await tick(120);
    const f = v.lastFrame() ?? "";
    expect(f).toContain("Should I rotate [redacted]?");
    expect(f).not.toContain("SECRET");
  });
});

describe("startup warnings (M1, M3)", () => {
  it("are shown first as lines, sanitized and redacted", async () => {
    const { session } = fakeSession({ history: [{ role: "user", content: "earlier" }] });
    const v = mount({
      session,
      warnings: ["skill ev\x1b]52;c;x\x07il skipped: skill_invalid symlink sk-ant-api03-SECRETxx"],
    });
    await tick();
    const f = v.lastFrame() ?? "";
    expect(f).toContain("skill evil skipped: skill_invalid symlink [redacted]");
    expect(f.indexOf("skill evil")).toBeLessThan(f.indexOf("earlier"));
    expect(f).not.toContain("\x1b]52");
  });
});
