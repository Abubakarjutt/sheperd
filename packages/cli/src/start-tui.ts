import { RewireError } from "@rewire/core";
import type {
  ChatEvent,
  ChatSession,
  RunController,
  RunHandle,
  SessionSummary,
} from "@rewire/session";
import { resolveSkills, type Skill, type SkillSet } from "@rewire/skills";
// Type-only: the TUI (Ink, React) is loaded by the caller, only on the interactive path.
import type { InterruptTarget, SkillsInfo, TuiDeps } from "@rewire/tui";
import { type Activity, Interrupter } from "./interactive.js";

/** Cleanup on exit (run done, session and skill-set disposal) never waits longer than this. */
export const DISPOSE_TIMEOUT_MS = 2000;

/** Everything `startInteractive` touches, injected so the wiring is testable with fakes. */
export type StartDeps = {
  repo: string;
  /** `$XDG_CONFIG_HOME/rewire/trusted-skills.json`. */
  trustFile: string;
  /** User and repo skills as found now (`discoverSkills(...).skills`). */
  discover: () => Promise<Skill[]>;
  /** Whether the trust store pins exactly these repo skills (`isTrusted(loadTrust, trustKey, repoSkillsHash(found))`). */
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
  routing?: string;
  disposeTimeoutMs?: number;
  now?: () => number;
};

type Resolved = { found: Skill[]; active: Skill[]; pendingRepo: Skill[] };

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
      const found = await d.discover();
      const trusted = found.some((s) => s.source === "repo") ? await d.trusted(found) : false;
      return { found, ...resolveSkills(found, trusted) };
    };

    let r = await resolveNow();
    if (exiting !== undefined) return exiting;
    if (r.pendingRepo.length > 0) {
      const answer = await d.promptTrust({
        found: r.found,
        pendingRepo: r.pendingRepo,
        onInterrupt,
        bindExit,
      });
      closeUi = undefined;
      if (answer === undefined || exiting !== undefined) return exiting ?? 0;
      if (answer) r = { found: r.found, ...resolveSkills(r.found, true) };
    }

    let set = d.createSkillSet(r.active);
    sets.push(set);
    let info: SkillsInfo = { ...r, repo: d.repo, trustFile: d.trustFile };

    let forward: ((e: ChatEvent) => void) | undefined;
    const emit = (e: ChatEvent): void => forward?.(e);
    const track = (s: ChatSession): ChatSession => {
      sessions.add(s);
      return s;
    };
    const session = track(await d.newSession({ skills: set, emit }));
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
    const fresh = async (sessionId?: string): Promise<ChatSession> => {
      if (activeRun) throw new RewireError("run_in_progress", "a run is active");
      const next = await resolveNow();
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
      track(s);
      const old = set;
      set = nextSet;
      sets.push(nextSet);
      runs = d.newRunController(nextSet);
      info = { ...next, repo: d.repo, trustFile: d.trustFile };
      sets.splice(sets.indexOf(old), 1);
      await d.disposeSkillSet(old).catch(() => {});
      return s;
    };

    if (exiting !== undefined) return exiting;
    return await d.render({
      session,
      runController,
      config: { repo: d.repo },
      sessions: {
        create: () => fresh(),
        resume: (id) => fresh(id),
        list: () => d.listSessions(),
      },
      skills: () => info,
      ...(d.doctor ? { doctor: d.doctor } : {}),
      ...(d.routing !== undefined ? { routing: d.routing } : {}),
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
