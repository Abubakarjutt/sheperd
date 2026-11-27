import { RewireError } from "@rewire/core";
import type { ChatEvent, ChatSession, RunHandle } from "@rewire/session";
import type { Skill, SkillProblem, SkillSet } from "@rewire/skills";
import type { InterruptTarget, SkillsInfo, TuiDeps } from "@rewire/tui";
import { describe, expect, test } from "vitest";
import { formatError } from "../src/run.js";
import { type StartDeps, startInteractive } from "../src/start-tui.js";
import { xdgDirs } from "../src/xdg.js";

const skill = (name: string, source: "user" | "repo", extra: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} skill`,
  source,
  dir: `/x/${name}`,
  files: [{ path: "SKILL.md", bytes: 1 }],
  body: "",
  modelInvocable: true,
  ...(source === "repo" ? { sha256: "a".repeat(64) } : {}),
  ...extra,
});

type Log = string[];

function fakeDeps(
  over: Partial<StartDeps> & {
    found?: Skill[][];
    trust?: boolean[];
    problems?: SkillProblem[];
  } = {},
) {
  const log: Log = [];
  const found = over.found ?? [[skill("u1", "user")]];
  const trust = over.trust ?? [];
  let discoveries = 0;
  let trustChecks = 0;
  let sets = 0;
  let sessions = 0;
  const sigint: Array<() => void> = [];
  const disposedSets: SkillSet[] = [];
  const createdSets: Array<{ set: SkillSet; names: string[] }> = [];
  const emits: Array<(e: ChatEvent) => void> = [];
  const deps: StartDeps = {
    repo: "/repo",
    trustFile: "/cfg/rewire/trusted-skills.json",
    discover: async () => {
      const f = found[Math.min(discoveries, found.length - 1)] ?? [];
      discoveries++;
      log.push("discover");
      return { skills: f, problems: over.problems ?? [] };
    },
    trusted: async () => {
      log.push("trust");
      return trust[trustChecks++] ?? false;
    },
    promptTrust: async () => {
      log.push("prompt");
      return true;
    },
    createSkillSet: (active) => {
      const set = { skills: active, root: `/cache/set-${++sets}` } as unknown as SkillSet;
      createdSets.push({ set, names: active.map((s) => s.name) });
      log.push(`set ${sets}`);
      return set;
    },
    disposeSkillSet: async (set) => {
      disposedSets.push(set);
      log.push(`dispose ${set.root}`);
    },
    newSession: async ({ emit }) => {
      const n = ++sessions;
      emits.push(emit);
      log.push(`session ${n}`);
      return {
        history: () => [],
        dispose: async () => {
          log.push(`dispose session ${n}`);
        },
      } as unknown as ChatSession;
    },
    listSessions: async () => [],
    newRunController: () => {
      log.push("runs");
      return { start: () => ({}) as RunHandle };
    },
    render: async () => {
      log.push("render");
      return 0;
    },
    onSigint: (h) => {
      sigint.push(h);
      return () => {
        log.push("sigint off");
      };
    },
    forceExit: (code) => log.push(`force ${code}`),
    restoreTerminal: () => log.push("restore"),
    ...over,
  };
  return { deps, log, sigint, disposedSets, createdSets, emits };
}

describe("startInteractive wiring", () => {
  test("the header and status line get the repo, the home dir and the models", async () => {
    let seen: TuiDeps | undefined;
    const models = { chat: "c", spec: "s", implementer: "i", reviewers: ["r", "v"] };
    const f = fakeDeps({
      home: "/home/dev",
      models,
      render: async (d) => {
        seen = d;
        return 0;
      },
    });
    await startInteractive(f.deps);
    expect(seen?.cwd).toBe("/repo");
    expect(seen?.home).toBe("/home/dev");
    expect(seen?.models).toEqual(models);
  });

  test("discovery problems reach the TUI as warning lines (M1)", async () => {
    let seen: TuiDeps | undefined;
    const f = fakeDeps({
      problems: [
        { dir: "/repo/.claude/skills/evil", code: "skill_invalid", message: "symlink in skill" },
      ],
      render: async (d) => {
        seen = d;
        return 0;
      },
    });
    await startInteractive(f.deps);
    expect(seen?.warnings).toEqual(["skill evil skipped: skill_invalid symlink in skill"]);
  });

  test("an unreadable trust store: repo skills untrusted, no prompt, a warning; the session opens (M3)", async () => {
    let seen: TuiDeps | undefined;
    const f = fakeDeps({
      found: [[skill("u1", "user"), skill("r1", "repo")]],
      trusted: async () => {
        throw new RewireError("trust_store_unreadable", "EACCES on trusted-skills.json");
      },
      render: async (d) => {
        seen = d;
        return 0;
      },
    });
    expect(await startInteractive(f.deps)).toBe(0);
    expect(f.log).not.toContain("prompt");
    expect(f.createdSets[0]?.names).toEqual(["u1"]);
    expect(seen?.warnings).toEqual([
      "repo skills not loaded: trust_store_unreadable EACCES on trusted-skills.json",
    ]);
    const info = typeof seen?.skills === "function" ? seen.skills() : seen?.skills;
    expect(info?.pendingRepo.map((k) => k.name)).toEqual(["r1"]);
  });

  test("other trust errors still fail startup", async () => {
    const f = fakeDeps({
      found: [[skill("r1", "repo")]],
      trusted: async () => {
        throw new RewireError("boom", "x");
      },
    });
    await expect(startInteractive(f.deps)).rejects.toMatchObject({ code: "boom" });
  });

  test("no pending repo skills: no trust prompt; startup order; set disposed on exit", async () => {
    const f = fakeDeps({ found: [[skill("u1", "user")]] });
    expect(await startInteractive(f.deps)).toBe(0);
    expect(f.log).not.toContain("prompt");
    expect(f.log.slice(0, 5)).toEqual(["discover", "set 1", "session 1", "runs", "render"]);
    expect(f.disposedSets.map((s) => s.root)).toEqual(["/cache/set-1"]);
    expect(f.log).toContain("dispose session 1");
    expect(f.log).toContain("sigint off");
    expect(f.log.at(-1)).toBe("restore");
  });

  test("trusted repo skills: no prompt, and they are active", async () => {
    const f = fakeDeps({ found: [[skill("r1", "repo")]], trust: [true] });
    await startInteractive(f.deps);
    expect(f.log).not.toContain("prompt");
    expect(f.createdSets[0]?.names).toEqual(["r1"]);
  });

  test("pending repo skills: the prompt is shown with the same found snapshot before the set", async () => {
    const found = [skill("u1", "user"), skill("r1", "repo")];
    let seen: { found: Skill[]; pendingRepo: Skill[] } | undefined;
    const f = fakeDeps({
      found: [found],
      promptTrust: async (p) => {
        seen = { found: p.found, pendingRepo: p.pendingRepo };
        return true;
      },
    });
    await startInteractive(f.deps);
    expect(seen?.found).toBe(found);
    expect(seen?.pendingRepo.map((s) => s.name)).toEqual(["r1"]);
    expect(f.createdSets[0]?.names).toEqual(["u1", "r1"]); // trusted at the prompt
  });

  test("declining the prompt keeps the repo skills pending", async () => {
    let info: SkillsInfo | undefined;
    const f = fakeDeps({
      found: [[skill("u1", "user"), skill("r1", "repo")]],
      promptTrust: async () => false,
      render: async (d) => {
        info = typeof d.skills === "function" ? d.skills() : d.skills;
        return 0;
      },
    });
    await startInteractive(f.deps);
    expect(f.createdSets[0]?.names).toEqual(["u1"]);
    expect(info?.pendingRepo.map((s) => s.name)).toEqual(["r1"]);
  });

  test("a shadowed repo skill alone never prompts", async () => {
    const f = fakeDeps({
      found: [[skill("lint", "user"), skill("lint", "repo", { shadowed: true })]],
    });
    await startInteractive(f.deps);
    expect(f.log).not.toContain("prompt");
  });

  test("Ctrl-C at the startup prompt exits 0 and never opens the TUI", async () => {
    const f = fakeDeps({
      found: [[skill("r1", "repo")]],
      promptTrust: async (p) =>
        await new Promise<boolean | undefined>((res) => {
          p.bindExit(() => res(undefined));
          p.onInterrupt();
        }),
    });
    expect(await startInteractive(f.deps)).toBe(0);
    expect(f.log).not.toContain("render");
    expect(f.log).not.toContain("set 1");
    expect(f.log.at(-1)).toBe("restore");
  });

  test("/clear re-discovers, builds a new set, disposes the old one; the skills prop follows", async () => {
    let before: SkillsInfo | undefined;
    let after: SkillsInfo | undefined;
    const f = fakeDeps({
      found: [
        [skill("u1", "user"), skill("r1", "repo")],
        [skill("u1", "user"), skill("r1", "repo")],
      ],
      // Declined at startup; trusted mid-session (TrustPrompt saved it), so /clear activates it.
      promptTrust: async () => false,
      trust: [false, true],
      render: async (d) => {
        const get = () => (typeof d.skills === "function" ? d.skills() : d.skills);
        before = get();
        await d.sessions?.create();
        after = get();
        expect(f.disposedSets.map((s) => s.root)).toEqual(["/cache/set-1"]);
        return 0;
      },
    });
    await startInteractive(f.deps);
    expect(f.createdSets.map((c) => c.names)).toEqual([["u1"], ["u1", "r1"]]);
    expect(before?.pendingRepo.map((s) => s.name)).toEqual(["r1"]);
    expect(after?.pendingRepo).toEqual([]);
    expect(after?.active.map((s) => s.name)).toEqual(["u1", "r1"]);
    expect(f.disposedSets.map((s) => s.root)).toEqual(["/cache/set-1", "/cache/set-2"]);
    expect(f.log).toContain("dispose session 2");
  });

  test("a failed /clear keeps the old set and disposes the new one", async () => {
    let sessions = 0;
    const f = fakeDeps({
      render: async (d) => {
        await expect(d.sessions?.create()).rejects.toThrow("boom");
        return 0;
      },
    });
    const base = f.deps.newSession;
    f.deps.newSession = async (o) => {
      if (++sessions === 2) throw new Error("boom");
      return base(o);
    };
    await startInteractive(f.deps);
    expect(f.disposedSets.map((s) => s.root)).toEqual(["/cache/set-2", "/cache/set-1"]);
  });

  test("every session's emit goes to the bindEmit listener", async () => {
    const got: ChatEvent[] = [];
    const f = fakeDeps({
      render: async (d) => {
        d.bindEmit?.((e) => got.push(e));
        await d.sessions?.create();
        for (const emit of f.emits) emit({ type: "skill_loaded", name: "x" });
        return 0;
      },
    });
    await startInteractive(f.deps);
    expect(f.emits).toHaveLength(2);
    expect(got).toHaveLength(2);
  });

  test("resume uses the factory's own listing, then the same session builder", async () => {
    const ids: Array<string | undefined> = [];
    const f = fakeDeps({
      listSessions: async () => [{ id: "s1", title: "t", updatedAt: new Date() }],
      render: async (d) => {
        expect((await d.sessions?.list())?.map((s) => s.id)).toEqual(["s1"]);
        await d.sessions?.resume("s1");
        return 0;
      },
    });
    const base = f.deps.newSession;
    f.deps.newSession = async (o) => {
      ids.push(o.sessionId);
      return base(o);
    };
    await startInteractive(f.deps);
    expect(ids).toEqual([undefined, "s1"]);
  });

  test("Ctrl-C wiring: Ink key and SIGINT feed one machine; run abort, then idle exit", async () => {
    let target: InterruptTarget | undefined;
    const state = { activity: "run" as "run" | "turn" | "idle" };
    const aborted: string[] = [];
    let now = 0;
    const f = fakeDeps({
      now: () => now,
      render: async (d: TuiDeps) =>
        await new Promise<number>((res) => {
          d.bindExit?.((c) => res(c));
          target = {
            activity: () => state.activity,
            abortRun: () => aborted.push("run"),
            abortTurn: () => aborted.push("turn"),
            run: () => undefined,
          };
          d.bindInterrupt?.(target);
          d.onInterrupt?.(); // Ink key
          now += 5;
          f.sigint[0]?.(); // the same press, also seen as SIGINT
          expect(aborted).toEqual(["run"]);
          state.activity = "idle";
          now += 5000;
          f.sigint[0]?.();
        }),
    });
    expect(await startInteractive(f.deps)).toBe(0);
    expect(target).toBeDefined();
  });

  test("a second press while exiting force-quits with 130", async () => {
    let now = 0;
    const f = fakeDeps({
      now: () => now,
      disposeTimeoutMs: 50,
      render: async (d) =>
        await new Promise<number>((res) => {
          d.bindExit?.((c) => res(c));
          d.onInterrupt?.();
        }),
    });
    // Disposal hangs; the second press arrives while we wait on it.
    f.deps.disposeSkillSet = () =>
      new Promise<void>(() => {
        now += 100;
        f.sigint[0]?.();
      });
    expect(await startInteractive(f.deps)).toBe(0);
    expect(f.log).toContain("force 130");
    expect(f.log.at(-1)).toBe("restore");
  });

  test("exit aborts an active run and waits for its done (the report) before returning", async () => {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const f = fakeDeps({
      disposeTimeoutMs: 1000,
      newRunController: () => ({
        start: () =>
          ({
            abort: () => {
              f.log.push("abort");
              // The interrupted report is written a little later, then `done` settles.
              setTimeout(() => {
                f.log.push("done");
                resolveDone?.();
              }, 30);
            },
            done,
          }) as unknown as RunHandle,
      }),
      render: async (d) => {
        d.runController.start("t", { checkpoints: new Set() });
        return 130;
      },
    });
    expect(await startInteractive(f.deps)).toBe(130);
    const at = (s: string) => f.log.indexOf(s);
    expect(at("abort")).toBeGreaterThan(-1);
    expect(at("done")).toBeGreaterThan(at("abort"));
    expect(at("done")).toBeLessThan(at("restore"));
    expect(at("done")).toBeLessThan(at("dispose /cache/set-1"));
  });

  test("a run whose done never settles delays exit by the bound, not forever", async () => {
    const f = fakeDeps({
      disposeTimeoutMs: 120,
      newRunController: () => ({
        start: () => ({ abort: () => {}, done: new Promise(() => {}) }) as unknown as RunHandle,
      }),
      render: async (d) => {
        d.runController.start("t", { checkpoints: new Set() });
        return 0;
      },
    });
    const t0 = Date.now();
    await startInteractive(f.deps);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(1000);
  });

  test("a crash in the startup trust prompt rejects (printed redacted, exit 1), never exits 0", async () => {
    const secret = `sk-${"B".repeat(30)}`;
    const f = fakeDeps({
      found: [[skill("r1", "repo")]],
      promptTrust: async () => {
        throw new RewireError(
          "tui_render_failed",
          `the trust prompt failed: \x1b]52;c;x\x07 ${secret}`,
        );
      },
    });
    const err = await startInteractive(f.deps).catch((e: unknown) => e);
    expect((err as RewireError).code).toBe("tui_render_failed");
    expect(f.log).not.toContain("render");
    expect(f.log.at(-1)).toBe("restore");
    // What `rewire chat` prints for it (stderr, exit 1): sanitized and redacted.
    const line = formatError(err);
    expect(line).toContain("tui_render_failed");
    expect(line).not.toContain("\x1b");
    expect(line).not.toContain("\x07");
    expect(line).not.toContain(secret);
  });

  test("an exit while /clear is still building disposes the new set and session", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fakeDeps({
      disposeTimeoutMs: 1000,
      render: async (d) => {
        void d.sessions?.create().catch(() => {});
        await new Promise((r) => setTimeout(r, 5));
        // The session factory finishes only after the TUI has exited.
        setTimeout(() => release?.(), 30);
        return 0;
      },
    });
    const base = f.deps.newSession;
    let n = 0;
    f.deps.newSession = async (o) => {
      if (++n === 2) await gate;
      return base(o);
    };
    await startInteractive(f.deps);
    expect(f.createdSets.map((c) => c.set.root)).toEqual(["/cache/set-1", "/cache/set-2"]);
    expect(f.disposedSets.map((s) => s.root).sort()).toEqual(["/cache/set-1", "/cache/set-2"]);
    expect(f.log).toContain("dispose session 2");
    expect(f.log.indexOf("dispose session 2")).toBeLessThan(f.log.indexOf("restore"));
  });

  test("a hung disposal does not block exit beyond the bound", async () => {
    const f = fakeDeps({ disposeTimeoutMs: 30 });
    f.deps.disposeSkillSet = () => new Promise<void>(() => {});
    const t0 = Date.now();
    expect(await startInteractive(f.deps)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.log.at(-1)).toBe("restore");
  });

  test("a mid-run /clear is refused with run_in_progress", async () => {
    const f = fakeDeps({
      newRunController: () => ({
        start: () => ({ abort: () => {}, done: new Promise(() => {}) }) as unknown as RunHandle,
      }),
      disposeTimeoutMs: 10,
      render: async (d) => {
        d.runController.start("t", { checkpoints: new Set() });
        const err = await d.sessions?.create().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RewireError);
        expect((err as RewireError).code).toBe("run_in_progress");
        return 0;
      },
    });
    await startInteractive(f.deps);
  });
});

describe("xdgDirs", () => {
  test("only absolute XDG values and HOME are used; relative ones fall back under HOME", () => {
    expect(
      xdgDirs({ HOME: "/h", XDG_CONFIG_HOME: "/c", XDG_CACHE_HOME: "/k" }, () => "/fallback"),
    ).toEqual({ home: "/h", xdgConfig: "/c", cacheDir: "/k" });
    expect(
      xdgDirs({ HOME: "/h", XDG_CONFIG_HOME: ".config", XDG_CACHE_HOME: "cache" }, () => "/x"),
    ).toEqual({ home: "/h", xdgConfig: "/h/.config", cacheDir: "/h/.cache" });
    expect(xdgDirs({ HOME: "rel", XDG_CACHE_HOME: "" }, () => "/real")).toEqual({
      home: "/real",
      xdgConfig: "/real/.config",
      cacheDir: "/real/.cache",
    });
  });
});

describe("chatSessions: every TUI session gets compactionDeps (Task 7)", () => {
  test("the first session, /clear and /resume are built with the routing, config, a shared estimator and the window", async () => {
    const { mkdtemp, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolveRouting, defaultCompactionConfig } = await import("@rewire/pipeline");
    const { DEFAULT_POLICY } = await import("@rewire/policy");
    const { FauxProvider } = await import("@rewire/providers");
    const { SessionStore } = await import("@rewire/session");
    const { chatSessions } = await import("../src/tui.js");
    type Deps = Awaited<ReturnType<typeof import("@rewire/session").compactionDeps>>;
    type Args = Parameters<typeof import("@rewire/session").compactionDeps>[0];

    const repo = await realpath(await mkdtemp(join(tmpdir(), "rewire-cli-compaction-")));
    try {
      const store = new SessionStore();
      const stored = await store.create(repo);
      const routing = resolveRouting([{ provider: "faux", model: "chat" }]);
      const providers = () => new FauxProvider([]);
      const config = { ...defaultCompactionConfig(), latencyBudgetS: 42 };
      const calls: Args[] = [];
      const buildCompaction = async (a: Args): Promise<Deps> => {
        calls.push(a);
        return {
          window: { window: 9000, source: "model", provisional: true },
          config: a.config,
          estimator: a.estimator,
          verifier: async (ops) => ops.map(() => ({ accept: true })),
          independence: a.routing.independence,
        };
      };
      const env = { REWIRE_FAUX_WINDOW: "9000" };
      const newSession = chatSessions({
        repo,
        routing,
        providers,
        policy: DEFAULT_POLICY,
        store,
        compaction: config,
        windowOptions: { env },
        buildCompaction,
      });
      const built: ChatSession[] = [];
      const views: (string | undefined)[] = [];
      const f = fakeDeps({
        newSession: async (o) => {
          const s = await newSession(o);
          built.push(s);
          return s;
        },
        listSessions: async () => [{ id: stored, title: "x", updatedAt: new Date() }],
        render: async (d) => {
          await d.sessions?.create();
          await d.sessions?.resume(stored);
          // Each session has compaction on, with routing's independence (single model:
          // same-family). Checked while they are alive (exit disposes them).
          for (const s of built) views.push(s.compactionView()?.independence);
          return 0;
        },
      });
      await startInteractive(f.deps);
      expect(built).toHaveLength(3);
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.routing).toBe(routing);
        expect(c.config).toBe(config);
        expect(c.windowOptions).toEqual({ env });
        // The Ollama probes must not hold the UI: a 2-3 s cap, then the provisional default.
        expect(c.windowTimeoutMs).toBeGreaterThanOrEqual(2000);
        expect(c.windowTimeoutMs).toBeLessThanOrEqual(3000);
        expect(typeof c.providers).toBe("function");
      }
      // One estimator for the chat model, shared by its sessions.
      expect(calls[1]?.estimator).toBe(calls[0]?.estimator);
      expect(calls[2]?.estimator).toBe(calls[0]?.estimator);
      expect(views).toEqual(["same-family", "same-family", "same-family"]);
      expect(built[2]?.id()).toBe(stored);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
