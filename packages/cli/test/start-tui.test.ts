import { RewireError } from "@rewire/core";
import type { ChatEvent, ChatSession, RunHandle } from "@rewire/session";
import type { Skill, SkillSet } from "@rewire/skills";
import type { InterruptTarget, SkillsInfo, TuiDeps } from "@rewire/tui";
import { describe, expect, test } from "vitest";
import { type StartDeps, startInteractive } from "../src/start-tui.js";

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

function fakeDeps(over: Partial<StartDeps> & { found?: Skill[][]; trust?: boolean[] } = {}) {
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
      return f;
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

  test("exit waits for an active run's done, bounded", async () => {
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const f = fakeDeps({
      disposeTimeoutMs: 100,
      newRunController: () => ({
        start: () => ({ abort: () => resolveDone?.(), done }) as unknown as RunHandle,
      }),
      render: async (d) => {
        d.runController.start("t", { checkpoints: new Set() });
        return 130;
      },
    });
    expect(await startInteractive(f.deps)).toBe(130);
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
