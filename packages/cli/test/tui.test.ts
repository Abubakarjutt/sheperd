import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewireError } from "@rewire/core";
import { defaultCompactionConfig, type RoleRouting } from "@rewire/pipeline";
import { DEFAULT_POLICY, mergeTightenOnly } from "@rewire/policy";
import { FauxProvider, type ModelRef, text } from "@rewire/providers";
import type { ChatSession, RunHandle, RunPipelineInput } from "@rewire/session";
import { SessionStore } from "@rewire/session";
import type { SkillSet } from "@rewire/skills";
import type { InterruptTarget, RoutingPick, TuiDeps } from "@rewire/tui";
import { describe, expect, test } from "vitest";
import { RoutingControl } from "../src/routing-control.js";
import { webAccess } from "../src/run.js";
import { type StartDeps, startInteractive } from "../src/start-tui.js";
import { chatSessions, routedRunController } from "../src/tui.js";

const qwen: ModelRef = { provider: "ollama", model: "qwen2.5-coder:7b" };
const qwen3: ModelRef = { provider: "ollama", model: "qwen3:8b" };
const llama: ModelRef = { provider: "ollama", model: "llama3.1:8b" };
const gemma: ModelRef = { provider: "ollama", model: "gemma3:4b" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const show = (r: ModelRef) => `${r.provider}:${r.model}`;

const control = (available: ModelRef[] = [qwen, llama, qwen3]) =>
  new RoutingControl({ available, fileOverrides: {}, providers: () => new FauxProvider([]) });

type Built = {
  n: number;
  id: string | undefined;
  model: string;
  verifier: string;
  disposed: boolean;
};

/** startInteractive with fake sessions that record the chat model they were built on. */
function harness(rc: RoutingControl, over: Partial<StartDeps> = {}) {
  const built: Built[] = [];
  let failNext: Error | undefined;
  let gate: Promise<void> | undefined;
  const deps: StartDeps = {
    repo: "/repo",
    trustFile: "/cfg/trusted-skills.json",
    discover: async () => ({ skills: [], problems: [] }),
    trusted: async () => false,
    promptTrust: async () => true,
    createSkillSet: () => ({ skills: [], root: "/cache/set" }) as unknown as SkillSet,
    disposeSkillSet: async () => {},
    newSession: async ({ sessionId, routing }) => {
      if (gate) await gate;
      if (failNext) {
        const e = failNext;
        failNext = undefined;
        throw e;
      }
      const b: Built = {
        n: built.length + 1,
        id: sessionId ?? "s-1",
        model: show((routing ?? rc.current()).spec),
        verifier: show((routing ?? rc.current()).verifier),
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
    /** Holds the next builds until the returned function is called. */
    hold: (): (() => void) => {
      let open: () => void = () => {};
      gate = new Promise<void>((r) => {
        open = () => {
          gate = undefined;
          r();
        };
      });
      return () => open();
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

  test("while the new chat session builds, the old routing is in effect and runs are refused", async () => {
    const rc = control();
    const before = rc.current();
    const fired: string[] = [];
    rc.onChange((r) => fired.push(show(r.spec)));
    let during: { routing: RoleRouting; runError: unknown; fired: number } | undefined;
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d) => {
        const release = h.hold();
        const p = d.routingControl?.set("spec", qwen3);
        await tick();
        let runError: unknown;
        try {
          d.runController.start("task", { checkpoints: new Set() });
        } catch (e) {
          runError = e;
        }
        during = { routing: rc.current(), runError, fired: fired.length };
        release();
        pick = await p;
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(during?.routing).toBe(before);
    expect(during?.fired).toBe(0);
    expect(during?.runError).toBeInstanceOf(RewireError);
    expect(pick?.ok).toBe(true);
    // Built with the candidate routing, committed once after.
    expect(h.built[1]?.model).toBe(show(qwen3));
    expect(fired).toEqual([show(qwen3)]);
  });

  test("a verifier pick resumes the same session too, so compaction verifies with the new verifier", async () => {
    const rc = control([qwen, llama, qwen3, gemma]);
    let pick: RoutingPick | undefined;
    const h = harness(rc, {
      render: async (d) => {
        // Automatic: reviewer llama, verifier gemma (a third family).
        pick = await d.routingControl?.set("verifier", llama);
        return 0;
      },
    });
    await startInteractive(h.deps);
    expect(pick?.ok).toBe(true);
    expect(pick?.ok && pick.session?.id()).toBe("s-1");
    expect(h.built.map((b) => [b.id, b.verifier])).toEqual([
      ["s-1", show(gemma)],
      ["s-1", show(llama)],
    ]);
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

  test("a failed swap changes nothing and fires no onChange; the old session stays", async () => {
    const rc = control();
    expect(rc.set("spec", llama).ok).toBe(true);
    const before = rc.current();
    const fired: RoleRouting[] = [];
    rc.onChange((r) => fired.push(r));
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
    expect(rc.current()).toBe(before);
    expect(rc.source("spec")).toBe("session");
    expect(fired).toEqual([]);
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
      // An explicit routing (a pick's candidate, not yet committed) wins over the getter.
      const candidate = { ...rc.current(), spec: llama };
      const c = await newSession({ skills, emit: () => {}, routing: candidate });
      expect(routings[2]).toBe(candidate);
      expect(show(routings[0]?.spec as ModelRef)).toBe(show(qwen));
      expect(show(routings[1]?.spec as ModelRef)).toBe(show(qwen3));
      // The chat provider of each session is its build's `spec`.
      expect(asked).toEqual([show(qwen), show(qwen3), show(llama)]);
      await a.dispose();
      await b.dispose();
      await c.dispose();
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

describe("web access threading", () => {
  const models = (web = { maxResults: 3 }) => ({
    available: [qwen],
    overrides: {},
    compaction: defaultCompactionConfig(),
    web,
  });

  test("webAccess: models.toml [web] and the env; none in faux mode (no network in a self-test)", () => {
    const env = { OLLAMA_API_KEY: "k" };
    expect(webAccess(models(), env, false)).toEqual({ config: { maxResults: 3 }, env });
    expect(webAccess(models(), env, true)).toBeUndefined();
  });

  test("chatSessions gives each session the web access; policy still decides", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "rewire-cli-web-")));
    const providers: FauxProvider[] = [];
    try {
      const build = (policy: typeof DEFAULT_POLICY) =>
        chatSessions({
          repo,
          routing: () => control().current(),
          providers: () => {
            const p = new FauxProvider([text("hi")]);
            providers.push(p);
            return p;
          },
          policy,
          store: new SessionStore(),
          compaction: defaultCompactionConfig(),
          windowOptions: { env: { REWIRE_FAUX_WINDOW: "9000" } },
          web: { config: { maxResults: 5 }, env: {} },
          buildCompaction: async (a) => ({
            window: { window: 9000, source: "model", provisional: true },
            config: a.config,
            estimator: a.estimator,
            verifier: async (ops) => ops.map(() => ({ accept: true })),
            independence: a.routing.independence,
          }),
        });
      const skills = { skills: [], root: undefined, load: async () => ({}) } as unknown as SkillSet;
      const on = await build(DEFAULT_POLICY)({ skills, emit: () => {} });
      await on.send("hello");
      const off = await build(mergeTightenOnly(DEFAULT_POLICY, { web: { enabled: false } }))({
        skills,
        emit: () => {},
      });
      await off.send("hello");
      const names = (p: FauxProvider | undefined) =>
        (p?.requests[0]?.tools ?? []).map((t) => t.name);
      expect(names(providers[0])).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      expect(names(providers[1])).not.toContain("web_search");
      await on.dispose();
      await off.dispose();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
