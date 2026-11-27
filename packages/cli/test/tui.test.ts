import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { defaultCompactionConfig, type RoleRouting } from "@rewire/pipeline";
import { DEFAULT_POLICY } from "@rewire/policy";
import { FauxProvider, type ModelRef } from "@rewire/providers";
import type { ChatSession, RunHandle, RunPipelineInput } from "@rewire/session";
import { SessionStore } from "@rewire/session";
import type { SkillSet } from "@rewire/skills";
import type { InterruptTarget, RoutingPick, TuiDeps } from "@rewire/tui";
import { describe, expect, test } from "vitest";
import { RoutingControl } from "../src/routing-control.js";
import { type StartDeps, startInteractive } from "../src/start-tui.js";
import { chatSessions, routedRunController } from "../src/tui.js";

const qwen: ModelRef = { provider: "ollama", model: "qwen2.5-coder:7b" };
const qwen3: ModelRef = { provider: "ollama", model: "qwen3:8b" };
const llama: ModelRef = { provider: "ollama", model: "llama3.1:8b" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const show = (r: ModelRef) => `${r.provider}:${r.model}`;

const control = (available: ModelRef[] = [qwen, llama, qwen3]) =>
  new RoutingControl({ available, fileOverrides: {}, providers: () => new FauxProvider([]) });

type Built = { n: number; id: string | undefined; model: string; disposed: boolean };

/** startInteractive with fake sessions that record the chat model they were built on. */
function harness(rc: RoutingControl, over: Partial<StartDeps> = {}) {
  const built: Built[] = [];
  let failNext: Error | undefined;
  const deps: StartDeps = {
    repo: "/repo",
    trustFile: "/cfg/trusted-skills.json",
    discover: async () => ({ skills: [], problems: [] }),
    trusted: async () => false,
    promptTrust: async () => true,
    createSkillSet: () => ({ skills: [], root: "/cache/set" }) as unknown as SkillSet,
    disposeSkillSet: async () => {},
    newSession: async ({ sessionId }) => {
      if (failNext) {
        const e = failNext;
        failNext = undefined;
        throw e;
      }
      const b: Built = {
        n: built.length + 1,
        id: sessionId ?? "s-1",
        model: show(rc.current().spec),
        disposed: false,
      };
      built.push(b);
      return {
        id: () => b.id,
        history: () => [],
        dispose: async () => {
          b.disposed = true;
        },
      } as unknown as ChatSession;
    },
    listSessions: async () => [],
    newRunController: () => ({
      start: () => ({ done: Promise.resolve(), abort: () => {} }) as unknown as RunHandle,
    }),
    render: async () => 0,
    onSigint: () => () => {},
    forceExit: () => {},
    restoreTerminal: () => {},
    routingControl: rc,
    ...over,
  };
  return {
    deps,
    built,
    failNextBuild: (e: Error) => {
      failNext = e;
    },
  };
}

describe("startInteractive: the TUI's routingControl", () => {
  test("a chat-model pick resumes the same session id on the new model, handed to the TUI", async () => {
    const rc = control();
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d: TuiDeps) => {
        pick = await d.routingControl?.set("spec", qwen3);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(pick?.ok).toBe(true);
    if (!pick?.ok) return;
    expect(h.built.map((b) => [b.id, b.model])).toEqual([
      ["s-1", show(qwen)],
      ["s-1", show(qwen3)],
    ]);
    expect(pick.session?.id()).toBe("s-1");
    expect(show(rc.current().spec)).toBe(show(qwen3));
  });

  test("a pick of another role builds no session", async () => {
    const rc = control();
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d) => {
        pick = await d.routingControl?.set("test-writer", qwen3);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(pick?.ok).toBe(true);
    expect(pick?.ok && pick.session).toBeFalsy();
    expect(h.built).toHaveLength(1);
  });

  test("a failed swap restores the previous override and refuses; the old session stays", async () => {
    const rc = control();
    expect(rc.set("spec", llama).ok).toBe(true);
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d) => {
        h.failNextBuild(new RewireError("session_not_found", "store unreadable"));
        pick = await d.routingControl?.set("spec", qwen3);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(pick?.ok).toBe(false);
    if (pick?.ok !== false) return;
    expect(pick.reason).toContain("store unreadable");
    expect(show(rc.current().spec)).toBe(show(llama));
    expect(rc.source("spec")).toBe("session");
    expect(h.built).toHaveLength(1);
  });

  test("a refused pick builds nothing and changes nothing", async () => {
    const rc = control();
    const before = rc.current();
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d) => {
        pick = await d.routingControl?.set("reviewer", qwen3);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(pick?.ok).toBe(false);
    expect(rc.current()).toBe(before);
    expect(h.built).toHaveLength(1);
  });

  test("picks are refused while a gated run is active or a chat turn is in flight", async () => {
    const rc = control();
    const before = rc.current();
    const reasons: string[] = [];
    const h = harness(rc, {
      render: async (d) => {
        d.runController.start("task", { checkpoints: new Set() });
        const p = await d.routingControl?.set("implementer", qwen3);
        if (p && !p.ok) reasons.push(p.reason);
        return 0;
      },
    });
    await startInteractive(h.deps);
    let activity: "turn" | "idle" = "turn";
    const h2 = harness(rc, {
      render: async (d) => {
        d.bindInterrupt?.({
          activity: () => activity,
          abortRun: () => {},
          abortTurn: () => {},
          run: () => undefined,
        } as InterruptTarget);
        const p = await d.routingControl?.set("implementer", qwen3);
        if (p && !p.ok) reasons.push(p.reason);
        activity = "idle";
        return 0;
      },
    });
    await startInteractive(h2.deps);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("run");
    expect(reasons[1]).toContain("turn");
    expect(rc.current()).toBe(before);
  });

  test("routing text and family are exposed to the TUI", async () => {
    const rc = control();
    let text: string | undefined;
    let fam: string | undefined;
    const h = harness(rc, {
      routing: () => `spec ${show(rc.current().spec)}`,
      render: async (d) => {
        rc.set("spec", qwen3);
        text = typeof d.routing === "function" ? d.routing() : d.routing;
        fam = d.routingControl?.family(llama);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(text).toBe(`spec ${show(qwen3)}`);
    expect(fam).toBe("llama");
  });
});

describe("chatSessions reads the control at each build", () => {
  test("a session built after a spec pick is on the new model, with the new routing", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "rewire-cli-routing-")));
    try {
      const rc = control();
      const routings: RoleRouting[] = [];
      const asked: string[] = [];
      const newSession = chatSessions({
        repo,
        routing: () => rc.current(),
        providers: (ref) => {
          asked.push(show(ref));
          return new FauxProvider([]);
        },
        policy: DEFAULT_POLICY,
        store: new SessionStore(),
        compaction: defaultCompactionConfig(),
        windowOptions: { env: { REWIRE_FAUX_WINDOW: "9000" } },
        buildCompaction: async (a) => {
          routings.push(a.routing);
          return {
            window: { window: 9000, source: "model", provisional: true },
            config: a.config,
            estimator: a.estimator,
            verifier: async (ops) => ops.map(() => ({ accept: true })),
            independence: a.routing.independence,
          };
        },
      });
      const skills = { skills: [], root: "/x" } as unknown as SkillSet;
      const a = await newSession({ skills, emit: () => {} });
      expect(rc.set("spec", qwen3).ok).toBe(true);
      const b = await newSession({ skills, emit: () => {} });
      expect(show(routings[0]?.spec as ModelRef)).toBe(show(qwen));
      expect(show(routings[1]?.spec as ModelRef)).toBe(show(qwen3));
      // The chat provider of each session is its build's `spec`.
      expect(asked).toEqual([show(qwen), show(qwen3)]);
      await a.dispose();
      await b.dispose();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("routedRunController", () => {
  test("a run started after a pick gets the new routing; a running run keeps its own", async () => {
    const rc = control();
    const seen: RoleRouting[] = [];
    let finish: () => void = () => {};
    const runs = routedRunController({
      repo: "/repo",
      routing: () => rc.current(),
      providers: () => new FauxProvider([]),
      policy: DEFAULT_POLICY,
      pipeline: (input: RunPipelineInput) => {
        seen.push(input.routing);
        return new Promise((r) => {
          finish = () => r({ status: "escalated", runId: "r", reason: "x" } as never);
        });
      },
    });
    expect(rc.set("implementer", qwen3).ok).toBe(true);
    const first = runs.start("one", { checkpoints: new Set() });
    await tick();
    expect(show(seen[0]?.implementer as ModelRef)).toBe(show(qwen3));
    // One run at a time, as before.
    expect(() => runs.start("two", { checkpoints: new Set() })).toThrow(/in progress/);
    finish();
    await first.done.catch(() => {});
    expect(rc.set("implementer", undefined).ok).toBe(true);
    const second = runs.start("three", { checkpoints: new Set() });
    await tick();
    expect(show(seen[1]?.implementer as ModelRef)).toBe(show(qwen));
    expect(show(seen[0]?.implementer as ModelRef)).toBe(show(qwen3));
    finish();
    await second.done.catch(() => {});
  });
});
