import { basename } from "node:path";
import { RewireError } from "@rewire/core";
import type { Role } from "@rewire/pipeline";
import { type ModelRef, modelFamily } from "@rewire/providers";
import type {
  ChatEvent,
  ChatSession,
  RunController,
  RunHandle,
  SessionSummary,
} from "@rewire/session";
import { resolveSkills, type Skill, type SkillProblem, type SkillSet } from "@rewire/skills";
// Type-only: the TUI (Ink, React) is loaded by the caller, only on the interactive path.
import type {
  InterruptTarget,
  ModelsInfo,
  RoutingControlDep,
  RoutingPick,
  SkillsInfo,
  TuiDeps,
} from "@rewire/tui";
import { type Activity, Interrupter } from "./interactive.js";
import type { RoutingControl } from "./routing-control.js";

/** Cleanup on exit (run done, session and skill-set disposal) never waits longer than this. */
export const DISPOSE_TIMEOUT_MS = 2000;

/** Everything `startInteractive` touches, injected so the wiring is testable with fakes. */
export type StartDeps = {
  repo: string;
  /** `$XDG_CONFIG_HOME/rewire/trusted-skills.json`. */
  trustFile: string;
  /** User and repo skills as found now, and the skill dirs skipped (`discoverSkills(...)`). */
  discover: () => Promise<{ skills: Skill[]; problems: SkillProblem[] }>;
  /**
   * Whether the trust store pins exactly these repo skills (`isTrusted(loadTrust, trustKey,
   * repoSkillsHash(found))`). A `trust_store_unreadable` throw leaves the repo skills untrusted.
   */
  trusted: (found: Skill[]) => Promise<boolean>;
  /** The startup `<TrustPrompt>`: true = saved, false = declined, undefined = closed by Ctrl-C. */
  promptTrust: (p: {
    found: Skill[];
    pendingRepo: Skill[];
    onInterrupt: () => void;
    bindExit: (exit: (code: number) => void) => void;
  }) => Promise<boolean | undefined>;
  createSkillSet: (active: Skill[]) => SkillSet;
  disposeSkillSet: (set: SkillSet) => Promise<void>;
  /** A new (or, with `sessionId`, resumed) ChatSession, on the one SessionStore. */
  newSession: (o: {
    skills: SkillSet;
    emit: (e: ChatEvent) => void;
    sessionId?: string;
  }) => Promise<ChatSession>;
  /** The same SessionStore's `list(repo)`. */
  listSessions: () => Promise<SessionSummary[]>;
  newRunController: (skills: SkillSet) => Pick<RunController, "start">;
  render: (deps: TuiDeps) => Promise<number>;
  /** Install a SIGINT handler; returns its uninstaller. */
  onSigint: (handler: () => void) => () => void;
  /** Force quit now (restores the terminal first). */
  forceExit: (code: number) => void;
  /** Ink unmounted; also make sure raw mode is off and the cursor is shown. */
  restoreTerminal: () => void;
  doctor?: () => Promise<string>;
  /** The routing text for `/model` (re-read on each use when a getter). */
  routing?: string | (() => string);
  /**
   * The session routing `/model` picks change. `newSession` and `newRunController` must read
   * it (`current()`) when they build; the TUI gets a wrapper that refuses picks during a run or
   * a turn and, when the chat model (`spec`) changed, resumes the current session on it.
   */
  routingControl?: Pick<
    RoutingControl,
    "current" | "available" | "source" | "set" | "snapshot" | "restore"
  >;
  /** The chat and run models, for the TUI's header and status line. */
  models?: ModelsInfo;
  /** The home directory, shown as `~` in the header. */
  home?: string;
  disposeTimeoutMs?: number;
  now?: () => number;
};

type Resolved = {
  found: Skill[];
  active: Skill[];
  pendingRepo: Skill[];
  /** Lines shown at TUI start: skipped skill dirs, an unreadable trust store. */
  warnings: string[];
  /** The trust store could not be read: do not prompt (saving would fail the same way). */
  trustUnreadable: boolean;
};

const sameRef = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

const problemLine = (p: SkillProblem): string =>
  `skill ${basename(p.dir)} skipped: ${p.code} ${p.message}`;

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The interactive TUI's lifetime. Startup order: discover skills, load trust, the trust prompt
 * (only when repo skills are pending, with that same `found` snapshot), resolve, create the
 * SkillSet, build the ChatSession and RunController, render. Ctrl-C (Ink key and SIGINT) goes
 * through one {@link Interrupter}. On every exit path: abort an active run, then (bounded by
 * `disposeTimeoutMs`) wait for it and dispose every session and skill set, then restore the
 * terminal. Returns the exit code.
 */
export async function startInteractive(d: StartDeps): Promise<number> {
  const sessions = new Set<ChatSession>();
  const sets: SkillSet[] = [];
  let target: InterruptTarget | undefined;
  let closeUi: ((code: number) => void) | undefined;
  let exiting: number | undefined;
  let activeRun: RunHandle | undefined;
  const building = new Set<Promise<ChatSession>>();
  const closing = (): RewireError =>
    new RewireError("session_disposed", "the interactive session is closing");

  const exit = (code: 0 | 130): void => {
    if (exiting !== undefined) {
      // Another press while already exiting (cleanup may hang): force quit.
      d.forceExit(130);
      return;
    }
    exiting = code;
    closeUi?.(code);
  };
  const machine = new Interrupter({
    // Once exiting, nothing is left to abort: every further (non-duplicate) press force-quits.
    activity: (): Activity =>
      exiting !== undefined ? "idle" : (target?.activity() ?? (activeRun ? "run" : "idle")),
    abortRun: () => {
      if (target) target.abortRun();
      else activeRun?.abort();
    },
    abortTurn: () => target?.abortTurn(),
    exit,
    ...(d.now ? { now: d.now } : {}),
  });
  const offSigint = d.onSigint(() => machine.press("signal"));
  const onInterrupt = (): void => {
    machine.press("key");
  };
  const bindExit = (close: (code: number) => void): void => {
    closeUi = close;
    if (exiting !== undefined) close(exiting);
  };

  try {
    const resolveNow = async (): Promise<Resolved> => {
      const { skills: found, problems } = await d.discover();
      const warnings = problems.map(problemLine);
      let trusted = false;
      let trustUnreadable = false;
      if (found.some((s) => s.source === "repo")) {
        try {
          trusted = await d.trusted(found);
        } catch (e) {
          // M3: an unreadable trust store blocks the repo skills, not the session.
          if (!(e instanceof RewireError) || e.code !== "trust_store_unreadable") throw e;
          trustUnreadable = true;
          warnings.push(`repo skills not loaded: ${e.code} ${e.message}`);
        }
      }
      return { found, ...resolveSkills(found, trusted), warnings, trustUnreadable };
    };

    let r = await resolveNow();
    if (exiting !== undefined) return exiting;
    if (r.pendingRepo.length > 0 && !r.trustUnreadable) {
      const answer = await d.promptTrust({
        found: r.found,
        pendingRepo: r.pendingRepo,
        onInterrupt,
        bindExit,
      });
      closeUi = undefined;
      if (answer === undefined || exiting !== undefined) return exiting ?? 0;
      if (answer) r = { ...r, ...resolveSkills(r.found, true) };
    }

    let set = d.createSkillSet(r.active);
    sets.push(set);
    const skillsInfo = (x: Resolved): SkillsInfo => ({
      found: x.found,
      active: x.active,
      pendingRepo: x.pendingRepo,
      repo: d.repo,
      trustFile: d.trustFile,
    });
    let info = skillsInfo(r);

    let forward: ((e: ChatEvent) => void) | undefined;
    const emit = (e: ChatEvent): void => forward?.(e);
    const track = (s: ChatSession): ChatSession => {
      sessions.add(s);
      return s;
    };
    const session = track(await d.newSession({ skills: set, emit }));
    /** The session the TUI shows: the first, then each one `/clear`, `/resume` or a pick built. */
    let current = session;
    let runs = d.newRunController(set);
    const runController: Pick<RunController, "start"> = {
      start: (task, opts) => {
        const h = runs.start(task, opts);
        activeRun = h;
        void h.done.finally(() => {
          if (activeRun === h) activeRun = undefined;
        });
        return h;
      },
    };

    /** A session on freshly discovered and resolved skills (a trust given mid-session applies). */
    const build = async (sessionId?: string): Promise<ChatSession> => {
      if (activeRun) throw new RewireError("run_in_progress", "a run is active");
      const next = await resolveNow();
      if (exiting !== undefined) throw closing();
      const nextSet = d.createSkillSet(next.active);
      let s: ChatSession;
      try {
        s = await d.newSession({
          skills: nextSet,
          emit,
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
      } catch (e) {
        await d.disposeSkillSet(nextSet).catch(() => {});
        throw e;
      }
      // The TUI exited while this was being built: cleanup is waiting on us, so dispose it here.
      if (exiting !== undefined) {
        await s.dispose().catch(() => {});
        await d.disposeSkillSet(nextSet).catch(() => {});
        throw closing();
      }
      track(s);
      current = s;
      const old = set;
      set = nextSet;
      sets.push(nextSet);
      runs = d.newRunController(nextSet);
      info = skillsInfo(next);
      sets.splice(sets.indexOf(old), 1);
      await d.disposeSkillSet(old).catch(() => {});
      return s;
    };

    /** `/clear` and `/resume` in flight; cleanup waits for them (bounded) so nothing leaks. */
    const fresh = (sessionId?: string): Promise<ChatSession> => {
      const p = build(sessionId);
      building.add(p);
      void p.then(
        () => building.delete(p),
        () => building.delete(p),
      );
      return p;
    };

    const rc = d.routingControl;
    const routingControl: RoutingControlDep | undefined = rc && {
      current: () => rc.current(),
      available: () => rc.available(),
      source: (role) => rc.source(role),
      family: (ref) => modelFamily(ref),
      set: async (role, ref): Promise<RoutingPick> => {
        if (activeRun || target?.activity() === "run") {
          return { ok: false, reason: "refused: a gated run is active; pick after it ends" };
        }
        if (target?.activity() === "turn") {
          return { ok: false, reason: "refused: a chat turn is in flight; pick after it ends" };
        }
        if (building.size > 0) {
          return { ok: false, reason: "refused: a session change is in progress" };
        }
        const before = rc.current().spec;
        const snap = rc.snapshot();
        const pick = rc.set(role as Role, ref as ModelRef | undefined);
        if (!pick.ok || sameRef(before, pick.routing.spec)) return pick;
        // The chat model changed: the same conversation continues on it (a session with no
        // completed turn has no id and nothing to carry: a fresh one).
        try {
          const next = await fresh(current.id());
          return { ...pick, session: next };
        } catch (e) {
          rc.restore(snap);
          return {
            ok: false,
            reason: `the chat model was not changed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      },
    };

    if (exiting !== undefined) return exiting;
    return await d.render({
      session,
      runController,
      config: { repo: d.repo },
      cwd: d.repo,
      ...(d.home !== undefined ? { home: d.home } : {}),
      ...(d.models ? { models: d.models } : {}),
      sessions: {
        create: () => fresh(),
        resume: (id) => fresh(id),
        list: () => d.listSessions(),
      },
      skills: () => info,
      warnings: r.warnings,
      ...(d.doctor ? { doctor: d.doctor } : {}),
      ...(d.routing !== undefined ? { routing: d.routing } : {}),
      ...(routingControl ? { routingControl } : {}),
      bindEmit: (l) => {
        forward = l;
      },
      bindExit,
      bindInterrupt: (t) => {
        target = t;
      },
      onInterrupt,
    });
  } finally {
    // The UI is gone; a press during the bounded cleanup below force-quits.
    if (exiting === undefined) exiting = 0;
    try {
      const run = target?.run() ?? activeRun;
      run?.abort();
      target?.abortTurn();
      const cleanup = (async () => {
        // A build in flight sees `exiting` and disposes what it made, or registered it already.
        await Promise.allSettled([...building]);
        await Promise.allSettled([
          ...(run ? [run.done] : []),
          ...[...sessions].map((s) => s.dispose()),
        ]);
        await Promise.allSettled(sets.map((s) => d.disposeSkillSet(s)));
      })();
      await settleWithin(cleanup, d.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS);
    } finally {
      offSigint();
      d.restoreTerminal();
    }
  }
}
