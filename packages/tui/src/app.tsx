import { homedir } from "node:os";
import { type CheckpointKind, RewireError, redact } from "@rewire/core";
import {
  type ChatEvent,
  type ChatSession,
  type CompactionView,
  type ContextStatus,
  outcomeMessage,
  type PendingPrompt,
  PROPOSAL_NOTE,
  type RunController,
  type RunHandle,
  type SessionSummary,
  TURN_LIMIT_NOTE,
} from "@rewire/session";
import type { Skill } from "@rewire/skills";
import { Box, type DOMElement, measureElement } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type RunDone, RunView } from "./board-view.js";
import { STALE_PROMPT } from "./checkpoint.js";
import {
  age,
  allowedInRun,
  type Command,
  DEFAULT_CHECKPOINTS,
  describeCheckpoints,
  HELP,
  literalText,
  parseCommand,
} from "./commands.js";
import {
  COMPACT_CANCELLED,
  type ContextInfo,
  ContextPanel,
  compactionEntries,
  INDEPENDENCE_NOTICE,
  type LastCompaction,
  lastCompactionOf,
} from "./compaction-view.js";
import { listRepoFiles } from "./files.js";
import type { HeaderInfo, ModelsInfo } from "./header.js";
import { InputBox } from "./input.js";
import {
  applyEvent,
  INTERRUPTED,
  LIVE_RESERVED_ROWS,
  LIVE_THROTTLE_MS,
  type LiveState,
  LiveTurn,
  newLive,
  takeFinished,
} from "./live-turn.js";
import { ModelPicker } from "./model-picker.js";
import { ClarifyPanel, ProposalCard } from "./proposal.js";
import {
  type RoutingControlDep,
  type RoutingModel,
  type RoutingRole,
  routingLines,
} from "./routing.js";
import { sanitize } from "./sanitize.js";
import { SkillsPicker } from "./skills-picker.js";
import { COMPACTING_VERB, ESC_CANCEL, pickVerb } from "./spinner.js";
import { type CtxStatus, StatusLine } from "./status-line.js";
import { Transcript, type TranscriptEntry } from "./transcript.js";
import { TrustPrompt } from "./trust-prompt.js";
import { useRows } from "./use-columns.js";

export { STALE_PROMPT };

export type AppConfig = Record<string, unknown>;

/**
 * Builds chat sessions, so the caller (the CLI) owns the provider, policy, skills and `emit`
 * wiring. `resume` is only called with an id that `list` returned.
 */
export type SessionFactory = {
  create(): Promise<ChatSession>;
  resume(id: string): Promise<ChatSession>;
  list(): Promise<SessionSummary[]>;
};

/** The session's skill snapshot, for `/skills` and its trust prompt. */
export type SkillsInfo = {
  found: Skill[];
  active: Skill[];
  pendingRepo: Skill[];
  repo: string;
  /** `$XDG_CONFIG_HOME/rewire/trusted-skills.json`. */
  trustFile: string;
};

/**
 * What Ctrl-C can interrupt, handed out by `bindInterrupt` (the CLI's Ctrl-C state machine reads
 * it). Backed by refs, so it stays valid for cleanup after the app unmounts.
 */
export type InterruptTarget = {
  /** `run` while a gated run is active, `turn` while a chat turn is in flight, else `idle`. */
  activity(): "run" | "turn" | "idle";
  /** Abort the active run (no-op without one); it ends with an interrupted report. */
  abortRun(): void;
  /** Abort the in-flight chat turn (no-op without one). */
  abortTurn(): void;
  /** The active run, if any. */
  run(): RunHandle | undefined;
};

export type AppProps = {
  session: ChatSession;
  /** Only `start` is used: the CLI may hand in a facade over several controllers. */
  runController: Pick<RunController, "start">;
  config: AppConfig;
  /** A run already in progress (tests); `/run` and accepted proposals set it from then on. */
  run?: RunHandle;
  /** Receives the chat events: wire `emit` of every ChatSession to the function it hands out. */
  subscribe?: (listener: (e: ChatEvent) => void) => () => void;
  /** Resolves the exit code of `renderTui` (`/exit`; Task 14 owns Ctrl-C). */
  onExit?: (code: number) => void;
  /** For `/clear` and `/resume`. */
  sessions?: SessionFactory;
  /** A getter is re-read on every use, so a `/clear` that re-resolves the skills is reflected. */
  skills?: SkillsInfo | (() => SkillsInfo | undefined);
  /** The `rewire doctor` output, for `/doctor` (injected: the CLI depends on this package). */
  doctor?: () => Promise<string>;
  /** The model routing, for `/model` (without `routingControl`). */
  routing?: string | (() => string);
  /**
   * The session routing that `/model` picks change (the CLI's `RoutingControl` plus the chat
   * session swap). When present, `/model` shows its current routing and the status line its chat
   * model (`spec`). Absent in a non-interactive context: `/model` prints `routing`.
   */
  routingControl?: RoutingControlDep;
  /** Initial checkpoints (default contract and tests). */
  checkpoints?: ReadonlySet<CheckpointKind>;
  /** Startup warnings (skipped skills, an unreadable trust store), shown as dim lines first. */
  warnings?: string[];
  /** Hands out the {@link InterruptTarget} once, on mount. */
  bindInterrupt?: (target: InterruptTarget) => void;
  /** The repo shown in the header (default: `config.repo`, else the process cwd). */
  cwd?: string;
  /** Shown as `~` in the header (default: the OS home directory). */
  home?: string;
  /** The chat and run models, for the header and the status line. */
  models?: ModelsInfo;
  /**
   * The repo's files for the `@` picker (default `listRepoFiles` of `config.repo`, else `cwd`).
   * Called at most once per session, when an `@` is first typed; `/clear` and `/resume` refresh.
   */
  listFiles?: () => Promise<string[]>;
};

const HIDDEN_NOTES = new Set([PROPOSAL_NOTE, TURN_LIMIT_NOTE]);

export const RUN_ACTIVE = "a run is active; answer its prompt or press Ctrl-C to abort";
const SEPARATOR = "───";
export const TRUSTED_LATER = "trusted; takes effect in a new session (/clear)";
export const PICK_IN_RUN = "model picks are refused while a run is active; pick after it ends";

/** Entries for a resumed session: user and assistant text only, minus the persisted placeholders. */
export function historyEntries(session: ChatSession): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of session.history()) {
    if (m.role === "user") out.push({ kind: "user", text: m.content });
    else if (m.role === "assistant" && m.content.trim() !== "" && !HIDDEN_NOTES.has(m.content)) {
      out.push({ kind: "assistant", text: m.content });
    }
  }
  return out;
}

function errorEntry(err: unknown): TranscriptEntry {
  const code = err instanceof RewireError ? err.code : "error";
  const message = redact(err instanceof Error ? err.message : String(err));
  return { kind: "error", code, message };
}

/** `contextStatus()`, or undefined (compaction off, or a session without it). Never throws. */
async function statusOf(s: ChatSession): Promise<ContextStatus | undefined> {
  if (typeof s.contextStatus !== "function") return undefined;
  try {
    return await s.contextStatus();
  } catch {
    return undefined; // disposed meanwhile: the next session refreshes it
  }
}

const viewOf = (s: ChatSession): CompactionView | undefined =>
  typeof s.compactionView === "function" ? s.compactionView() : undefined;

/** Startup lines of a session: the independence notice when its verifier shares chat's family. */
export function sessionNotices(s: ChatSession): TranscriptEntry[] {
  return viewOf(s)?.independence === "same-family"
    ? [{ kind: "line", tone: "dim", text: INDEPENDENCE_NOTICE }]
    : [];
}

type Clarify = { prompt: Extract<PendingPrompt, { kind: "clarify" }>; answers: string[] };

/** `contract,tests` (in the canonical order), or `off`. */
function checkpointsShort(set: ReadonlySet<CheckpointKind>): string {
  const order: CheckpointKind[] = ["contract", "tests", "commit"];
  const on = [...order.filter((k) => set.has(k)), ...[...set].filter((k) => !order.includes(k))];
  return on.length > 0 ? on.join(",") : "off";
}

export function App(props: AppProps) {
  const { subscribe, runController, sessions, doctor, routing, onExit, bindInterrupt } = props;
  const routingControl = props.routingControl;
  const skillsProp = props.skills;
  const skillsNow = useCallback(
    (): SkillsInfo | undefined => (typeof skillsProp === "function" ? skillsProp() : skillsProp),
    [skillsProp],
  );
  const configRepo = props.config.repo;
  const cwd = props.cwd ?? (typeof configRepo === "string" ? configRepo : process.cwd());
  const home = props.home ?? homedir();
  const modelsProp = props.models;
  /** The header's models as of now: the session routing when `/model` can change it. */
  const modelsNow = useCallback((): ModelsInfo | undefined => {
    if (!routingControl) return modelsProp;
    const r = routingControl.current();
    return {
      chat: r.spec.model,
      spec: r.spec.model,
      implementer: r.implementer.model,
      reviewers: [r.reviewer.model, r.verifier.model],
    };
  }, [routingControl, modelsProp]);
  /** The welcome box as of now (the skills getter is re-read, so `/clear` shows the new counts). */
  const headerEntry = useCallback((): TranscriptEntry => {
    const s = skillsNow();
    const models = modelsNow();
    const info: HeaderInfo = {
      cwd,
      home,
      ...(models ? { models } : {}),
      ...(s ? { skills: { active: s.active.length, pending: s.pendingRepo.length } } : {}),
    };
    return { kind: "header", info };
  }, [skillsNow, cwd, home, modelsNow]);
  const listFilesProp = props.listFiles;
  const filesRepo = typeof configRepo === "string" ? configRepo : cwd;
  /** The `@` picker's file list: loaded on first want, per session (a swap resets it). */
  const [files, setFiles] = useState<readonly string[]>([]);
  const filesAsked = useRef(false);
  const filesGen = useRef(0);
  const wantFiles = useCallback(() => {
    if (filesAsked.current) return;
    filesAsked.current = true;
    const gen = filesGen.current;
    (listFilesProp ?? (() => listRepoFiles(filesRepo)))().then(
      (list) => {
        if (gen === filesGen.current) setFiles(list);
      },
      () => {}, // the picker just stays empty
    );
  }, [listFilesProp, filesRepo]);
  const resetFiles = useCallback(() => {
    filesGen.current++;
    filesAsked.current = false;
    setFiles([]);
  }, []);
  /** The `/` menu or the `@` picker is open: it owns Esc. */
  const [popup, setPopup] = useState(false);
  /** The in-flight chat turn's abort, set while `send` runs. */
  const turnAbort = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(props.session);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => [
    headerEntry(),
    ...(props.warnings ?? []).map((text): TranscriptEntry => ({ kind: "note", text })),
    ...sessionNotices(props.session),
    ...historyEntries(props.session),
  ]);
  /** Bumped on every session swap: a fresh `<Static>` region for the new transcript (I3). */
  const [region, setRegion] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [run, setRunState] = useState<RunHandle | undefined>(props.run);
  // Mirrors of `run` and `clarify`, set synchronously: `submit` gates on these, so lines that
  // arrive before React re-renders still see a run that has just started (or a new answer).
  const runRef = useRef<RunHandle | undefined>(props.run);
  const setRun = useCallback((h: RunHandle | undefined) => {
    runRef.current = h;
    setRunState(h);
  }, []);
  const [pending, setPending] = useState<PendingPrompt | undefined>(undefined);
  const [clarify, setClarifyState] = useState<Clarify | undefined>(undefined);
  const clarifyRef = useRef<Clarify | undefined>(undefined);
  const setClarify = useCallback((c: Clarify | undefined) => {
    clarifyRef.current = c;
    setClarifyState(c);
  }, []);
  const [proposal, setProposal] = useState<string | undefined>(undefined);
  const [checkpoints, setCheckpoints] = useState<ReadonlySet<CheckpointKind>>(
    () => props.checkpoints ?? DEFAULT_CHECKPOINTS,
  );
  const [trustOpen, setTrustOpen] = useState(false);
  /** The `/skills` list is open. */
  const [skillsOpen, setSkillsOpen] = useState(false);
  /** The `/model` picker is open; `applying` while its pick is being applied. */
  const [modelOpen, setModelOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  /** Context size: the last chat model call's input plus output tokens; none before the first. */
  const [context, setContext] = useState<number | undefined>(undefined);
  /** With compaction: the estimate against the limit (`contextStatus()`), for the status line. */
  const [ctx, setCtx] = useState<CtxStatus | undefined>(undefined);
  /** The `/context` card while open. */
  const [contextInfo, setContextInfo] = useState<ContextInfo | undefined>(undefined);
  /** This session's last compaction result, for `/context`. */
  const lastCompaction = useRef<LastCompaction | undefined>(undefined);
  /** The Ollama truncation hint was shown (once). */
  const truncationShown = useRef(false);
  /** Bumped on every session swap: a status read for the old session is dropped. */
  const sessionGen = useRef(0);
  /** Bumped by every status read: only the newest one may set the status line. */
  const statusRead = useRef(0);
  const refreshStatus = useCallback(() => {
    const gen = sessionGen.current;
    const read = ++statusRead.current;
    void statusOf(sessionRef.current).then((st) => {
      if (gen !== sessionGen.current || read !== statusRead.current) return;
      setCtx(
        st === undefined
          ? undefined
          : {
              estimate: st.estimate,
              limit: st.limit.limit,
              reason: st.limit.reason,
              ...(st.hold ? { hold: st.hold } : {}),
            },
      );
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the first session
  useEffect(() => {
    refreshStatus();
  }, []);
  /** The active run's stage, from its board (status line). */
  const [stage, setStage] = useState<string | undefined>(undefined);
  const [trustedLater, setTrustedLater] = useState(false);
  /**
   * The in-flight chat turn's live area. Events fold into `liveRef` at once. Finished items (a
   * tool with its result, closed text, complete Markdown blocks) move to the `<Static>`
   * transcript as they finish (I1), together with the re-render that drops them from the live
   * area, so nothing shows twice. The rendered copy (`live`) follows at most every
   * LIVE_THROTTLE_MS for streamed text and tool calls, at once for the other events.
   */
  const liveRef = useRef<LiveState | undefined>(undefined);
  const [live, setLive] = useState<LiveState | undefined>(undefined);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushLive = useCallback(() => {
    clearTimeout(liveTimer.current);
    liveTimer.current = undefined;
    const s = liveRef.current;
    if (!s) return;
    const { state, entries: done } = takeFinished(s);
    liveRef.current = state;
    // Ink's legacy root does not batch these: drop the items from `live` first, then print them
    // through <Static>, so no frame shows them in both places.
    setLive(state);
    if (done.length > 0) setEntries((cur) => [...cur, ...done]);
  }, []);
  const scheduleLive = useCallback(() => {
    if (liveTimer.current !== undefined) return;
    liveTimer.current = setTimeout(flushLive, LIVE_THROTTLE_MS);
  }, [flushLive]);
  /**
   * Ends the live area (no timer left behind): its remaining entries, and whether the turn
   * showed any streamed text at all.
   */
  const endLive = useCallback((): { rest: TranscriptEntry[]; streamed: boolean } => {
    clearTimeout(liveTimer.current);
    liveTimer.current = undefined;
    const s = liveRef.current;
    liveRef.current = undefined;
    setLive(undefined);
    if (!s) return { rest: [], streamed: false };
    const { state, entries: rest } = takeFinished(s, true);
    return { rest, streamed: state.shownText };
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);
  const rows = useRows();
  /**
   * The rows of the dynamic frame around the `/context` card (the run board and clarify panel
   * above it, the input and status line below), measured after each render so the card is
   * sized to what is left of the terminal.
   */
  const aboveRef = useRef<DOMElement>(null);
  const belowRef = useRef<DOMElement>(null);
  const [around, setAround] = useState(0);
  useEffect(() => {
    const h = (r: { current: DOMElement | null }): number =>
      r.current ? measureElement(r.current).height : 0;
    const next = h(aboveRef) + h(belowRef);
    if (next !== around) setAround(next);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: bound once; the target reads refs
  useEffect(() => {
    bindInterrupt?.({
      activity: () => (runRef.current ? "run" : turnAbort.current ? "turn" : "idle"),
      abortRun: () => runRef.current?.abort(),
      abortTurn: () => turnAbort.current?.abort(),
      run: () => runRef.current,
    });
  }, []);

  // A run handed in later by the parent replaces the current one.
  useEffect(() => {
    if (props.run) setRun(props.run);
  }, [props.run, setRun]);

  const add = useCallback((...e: TranscriptEntry[]) => setEntries((cur) => [...cur, ...e]), []);
  const note = useCallback(
    (text: string, error = false) => add({ kind: "note", text, ...(error ? { error } : {}) }),
    [add],
  );

  const onRunDone = useCallback(
    (outcome: RunDone) => {
      add({ kind: "note", text: outcomeMessage(outcome) });
      setRun(undefined);
      setPending(undefined);
      setClarify(undefined);
      setStage(undefined);
    },
    [add, setRun, setClarify],
  );
  const onPending = useCallback(
    (p: PendingPrompt | undefined) => {
      setPending(p);
      setClarify(p?.kind === "clarify" ? { prompt: p, answers: [] } : undefined);
      // A run's prompt takes the keys: the /skills list closes, and stays closed afterwards.
      if (p !== undefined) setSkillsOpen(false);
    },
    [setClarify],
  );

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((e) => {
      // Compaction results and the truncation hint are lines of their own: shown whenever they
      // arrive (a `/compact` runs outside a chat turn).
      if (e.type === "truncation_suspected") {
        if (truncationShown.current) return;
        truncationShown.current = true;
        setEntries((cur) => [...cur, { kind: "line", tone: "warn", text: `⎿ ${e.hint}` }]);
        return;
      }
      if (e.type === "compaction" && e.phase !== "start") {
        const last = lastCompactionOf(e);
        if (last) lastCompaction.current = last;
        if (liveRef.current) liveRef.current = applyEvent(liveRef.current, e);
        const lines = compactionEntries(e);
        // What the live area finished goes first, then the result, in arrival order.
        flushLive();
        if (lines.length > 0) setEntries((cur) => [...cur, ...lines]);
        refreshStatus();
        return;
      }
      // Chat events belong to the turn live when they arrive. With none live (a late event of a
      // turn that already ended or was interrupted) they are dropped (M4): printed now, they
      // would land after the turn's last line, without their context.
      if (!liveRef.current) return;
      if (e.type === "usage") {
        const n = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
        const ctx = n(e.inputTokens) + n(e.outputTokens);
        // A server that reports no usage sends 0/0: keep the last known size (M6).
        if (ctx > 0) setContext(ctx);
      }
      liveRef.current = applyEvent(liveRef.current, e);
      // A tool_call is followed at once by its tool_result (the session emits both after the tool
      // ran): wait for the result rather than draw the line live and then print it again.
      if (e.type === "assistant_delta" || e.type === "tool_call") scheduleLive();
      else flushLive();
    });
  }, [subscribe, scheduleLive, flushLive, refreshStatus]);

  /** Runs `work` with the input busy; one at a time (chat turns, session swaps). */
  const exclusive = useCallback((work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    work().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }, []);

  const sendChat = useCallback(
    (text: string) =>
      exclusive(async () => {
        const ac = new AbortController();
        turnAbort.current = ac;
        liveRef.current = newLive(pickVerb(), Date.now());
        setLive(liveRef.current);
        try {
          const turn = await sessionRef.current.send(text, ac.signal);
          const { rest, streamed } = endLive();
          // Streamed text is the turn's text (its last part is the final answer): shown once.
          const final: TranscriptEntry[] =
            !streamed && turn.text.trim() !== "" ? [{ kind: "assistant", text: turn.text }] : [];
          add(...rest, ...final);
          if (turn.proposal) setProposal(turn.proposal.task);
          else if (turn.endedBy === "turn_limit") {
            note("(the turn stopped at its tool-call limit; send a message to continue)");
          }
        } catch (err) {
          // What already streamed stays, then why the turn ended: Esc or Ctrl-C, or an error.
          const { rest } = endLive();
          add(...rest, ac.signal.aborted ? { kind: "note", text: INTERRUPTED } : errorEntry(err));
        } finally {
          if (turnAbort.current === ac) turnAbort.current = undefined;
          refreshStatus();
        }
      }),
    [exclusive, add, note, endLive, refreshStatus],
  );

  /** `/compact [focus]`: the live area shows the spinner; Esc (or Ctrl-C) cancels it. */
  const compactNow = useCallback(
    (focus: string | undefined) => {
      if (typeof sessionRef.current.compact !== "function") {
        return note("compaction is not available here", true);
      }
      exclusive(async () => {
        const ac = new AbortController();
        turnAbort.current = ac;
        liveRef.current = { ...newLive(COMPACTING_VERB, Date.now()), hint: ESC_CANCEL };
        setLive(liveRef.current);
        try {
          const out = await sessionRef.current.compact(focus, ac.signal);
          const { rest } = endLive();
          // A result that arrived before a late Esc stands: only an aborted outcome is a cancel.
          const cancelled = !out.ok && out.reason === "aborted";
          add(...rest, ...(cancelled ? [{ kind: "note", text: COMPACT_CANCELLED } as const] : []));
        } catch (err) {
          const { rest } = endLive();
          add(
            ...rest,
            ac.signal.aborted ? { kind: "note", text: COMPACT_CANCELLED } : errorEntry(err),
          );
        } finally {
          if (turnAbort.current === ac) turnAbort.current = undefined;
          refreshStatus();
        }
      });
    },
    [exclusive, add, note, endLive, refreshStatus],
  );

  /** `/context`: the card, from the session's status now (display-only, also during a run). */
  const showContext = useCallback(() => {
    const s = sessionRef.current;
    const gen = sessionGen.current;
    const view = viewOf(s);
    if (view === undefined) return note("compaction is not configured for this session");
    void statusOf(s).then((status) => {
      if (gen !== sessionGen.current) return;
      if (status === undefined) return note("the context status is not available now", true);
      setContextInfo({ status, view, last: lastCompaction.current });
    });
  }, [note]);

  const startRun = useCallback(
    (task: string) => {
      try {
        const handle = runController.start(task, { checkpoints: new Set(checkpoints) });
        setPending(undefined);
        setClarify(undefined);
        setStage(undefined);
        setRun(handle);
      } catch (err) {
        add(errorEntry(err));
      }
    },
    [runController, checkpoints, add, setRun, setClarify],
  );

  /**
   * Makes `next` the session, at once (call it inside `exclusive`, so the old one cannot send
   * again), and returns the old one for the caller to dispose. With `region`, a new transcript
   * region starts (`/clear`, `/resume`); without, the transcript stays (a `/model` pick resumed
   * the same conversation on another model).
   */
  const installSession = useCallback(
    (
      next: ChatSession,
      region?: { label: string; entries: (s: ChatSession) => TranscriptEntry[] },
    ): ChatSession => {
      const old = sessionRef.current;
      sessionRef.current = next;
      if (region) {
        // The old transcript stays in the terminal's scrollback above this separator.
        setEntries([
          { kind: "note", text: `${SEPARATOR} ${region.label} ${SEPARATOR}` },
          headerEntry(),
          ...sessionNotices(next),
          ...region.entries(next),
        ]);
        setRegion((r) => r + 1);
        lastCompaction.current = undefined;
        resetFiles(); // `/clear` and `/resume` list the repo afresh
      }
      setContext(undefined);
      sessionGen.current++;
      setContextInfo(undefined);
      setCtx(undefined);
      refreshStatus();
      // The new session re-resolved the skills: a trust given earlier is now in effect.
      setTrustedLater(false);
      return old;
    },
    [headerEntry, resetFiles, refreshStatus],
  );

  const swapSession = useCallback(
    (
      make: () => Promise<ChatSession>,
      entriesOf: (s: ChatSession) => TranscriptEntry[],
      label: string,
    ) =>
      exclusive(async () => {
        try {
          const old = installSession(await make(), { label, entries: entriesOf });
          await old.dispose();
        } catch (err) {
          add(errorEntry(err));
        }
      }),
    [exclusive, add, installSession],
  );

  /**
   * A `/model` pick: applied inside `exclusive`, so no turn, compaction or session swap starts
   * meanwhile. A pick that rebuilt the session (chat model or verifier) hands it back: it is
   * installed before anything can send again, then the old one is disposed, as `/resume` does.
   */
  const applyPick = useCallback(
    (role: RoutingRole, ref: RoutingModel | undefined) => {
      if (!routingControl) return;
      if (runRef.current || inFlight.current) {
        setModelOpen(false);
        return note(
          runRef.current ? PICK_IN_RUN : "refused: the chat is busy; pick after it is done",
          true,
        );
      }
      setApplying(true);
      exclusive(async () => {
        try {
          const pick = await routingControl.set(role, ref);
          if (!pick.ok) {
            note(pick.reason, true);
            return;
          }
          const old = pick.session ? installSession(pick.session) : undefined;
          note(pick.note);
          // As at start, /clear and /resume: the rebuilt session may check compaction same-family.
          if (pick.session) add(...sessionNotices(pick.session));
          await old?.dispose();
        } catch (err) {
          add(errorEntry(err));
        } finally {
          setApplying(false);
          setModelOpen(false);
        }
      });
    },
    [routingControl, exclusive, installSession, note, add],
  );

  const resume = useCallback(
    (id: string | undefined) => {
      if (!sessions) return note("sessions are not available here", true);
      if (id === undefined) {
        sessions.list().then(
          (list) => {
            if (list.length === 0) return note("no stored sessions");
            note(
              list
                .map(
                  (s) => `${s.id}  ${sanitize(s.title).replace(/\n/g, " ")}  ${age(s.updatedAt)}`,
                )
                .join("\n"),
            );
          },
          (err: unknown) => add(errorEntry(err)),
        );
        return;
      }
      swapSession(
        async () => {
          const known = (await sessions.list()).some((s) => s.id === id);
          if (!known) {
            throw new RewireError("session_not_found", `no stored session ${id} in this repo`);
          }
          return await sessions.resume(id);
        },
        historyEntries,
        `resumed session ${id}`,
      );
    },
    [sessions, swapSession, note, add],
  );

  const runCommand = useCallback(
    (c: Command) => {
      switch (c.kind) {
        case "run":
          return startRun(c.task);
        case "skills": {
          const skills = skillsNow();
          if (!skills || skills.found.length === 0) return note("no skills found");
          return setSkillsOpen(true);
        }
        case "checkpoints":
          if (c.set) setCheckpoints(c.set);
          return note(describeCheckpoints(c.set ?? checkpoints));
        case "model": {
          if (routingControl) {
            if (!runRef.current) return setModelOpen(true);
            // The routing a run uses never changes mid-run: show it, and why there is no picker.
            note(routingLines(routingControl.current()));
            return note(PICK_IN_RUN, true);
          }
          const text = typeof routing === "function" ? routing() : routing;
          return note(text ?? "model routing is not available here");
        }
        case "resume":
          return resume(c.id);
        case "clear":
          if (!sessions) return note("sessions are not available here", true);
          return swapSession(
            () => sessions.create(),
            () => [],
            "new session",
          );
        case "compact":
          return compactNow(c.focus);
        case "context":
          return showContext();
        case "doctor":
          if (!doctor) return note("doctor is not available here", true);
          doctor().then(
            (out) => note(out), // the note renders through <Safe>, which redacts
            (err: unknown) => add(errorEntry(err)),
          );
          return;
        case "help":
          return note(HELP);
        case "exit":
          return onExit?.(0);
        case "skip":
          return note("no question is waiting");
        case "error":
          return note(c.message, true);
        case "unknown":
          return note(`unknown command ${c.name}`, true);
      }
    },
    [
      startRun,
      skillsNow,
      checkpoints,
      routing,
      routingControl,
      resume,
      sessions,
      swapSession,
      doctor,
      onExit,
      note,
      add,
      compactNow,
      showContext,
    ],
  );

  /** One typed line while a clarification is pending: the next answer, or `/skip`. */
  const answerClarify = useCallback(
    (c: Clarify, value: string | null) => {
      const run = runRef.current;
      if (!run) return;
      const answers = value === null ? null : [...c.answers, value];
      if (answers !== null && answers.length < c.prompt.questions.length) {
        setClarify({ prompt: c.prompt, answers });
        return;
      }
      // A question-less prompt is answered by any line, with no answers.
      const reply = answers?.slice(0, c.prompt.questions.length) ?? null;
      if (!run.answer(c.prompt, reply)) note(STALE_PROMPT, true);
      setClarify(undefined);
    },
    [note, setClarify],
  );

  const submit = useCallback(
    (line: string) => {
      if (inFlight.current) return;
      add({ kind: "user", text: line });
      const cmd = parseCommand(line);
      const clarify = clarifyRef.current;
      if (runRef.current) {
        if (cmd === undefined) {
          if (clarify) return answerClarify(clarify, literalText(line));
          return note(RUN_ACTIVE, true);
        }
        if (cmd.kind === "skip" && clarify) return answerClarify(clarify, null);
        if (!allowedInRun(cmd)) return note(RUN_ACTIVE, true);
        return runCommand(cmd);
      }
      if (cmd === undefined) return sendChat(literalText(line));
      runCommand(cmd);
    },
    [add, note, answerClarify, runCommand, sendChat],
  );

  const onProposal = useCallback(
    (yes: boolean) => {
      const task = proposal;
      setProposal(undefined);
      if (task === undefined) return;
      if (yes) startRun(task);
      else note("not run");
    },
    [proposal, startRun, note],
  );

  const onTrust = useCallback(
    (trusted: boolean) => {
      setTrustOpen(false);
      if (trusted) {
        setTrustedLater(true);
        note(TRUSTED_LATER);
      } else note("repo skills stay pending for this session");
    },
    [note],
  );

  /** The `/skills` review row: the trust prompt replaces the list (never during a run). */
  const openTrust = useCallback(() => {
    setSkillsOpen(false);
    if (!runRef.current) setTrustOpen(true);
  }, []);

  /** Esc in the live area: aborts the turn's signal, like the Ctrl-C machine's abortTurn. */
  // Reads the synchronous run mirror, not `interruptible` alone: in the render between a run
  // starting and LiveTurn re-rendering, Esc must already be inert (Ctrl-C owns the run).
  const abortTurn = useCallback(() => {
    if (runRef.current !== undefined) return;
    turnAbort.current?.abort();
  }, []);
  const trustSkills = trustOpen ? skillsNow() : undefined;
  /** The `/skills` list, re-read on every render (a `/clear` may re-resolve the skills). */
  const listSkills = skillsOpen ? skillsNow() : undefined;
  const checkpointOpen = run !== undefined && pending?.kind === "checkpoint";
  // A checkpoint owns the keys: the /context card gives way to it.
  const contextOpen = contextInfo !== undefined && !checkpointOpen;
  // The picker gives way to a checkpoint too (a run handed in while it is open).
  const pickerOpen = modelOpen && routingControl !== undefined && !checkpointOpen;
  // The /skills list gives way to a run's prompt (checkpoint or clarification), which also closes
  // it (`onPending`); it is read-only during a run.
  const skillsListOpen = listSkills !== undefined && !checkpointOpen && clarify === undefined;
  const inputOff =
    proposal !== undefined ||
    trustOpen ||
    checkpointOpen ||
    contextOpen ||
    pickerOpen ||
    skillsListOpen;
  const mode =
    run !== undefined && pending?.kind === "checkpoint"
      ? `checkpoint: ${pending.checkpoint.kind}`
      : run !== undefined
        ? `run: ${stage ?? "starting"}`
        : live !== undefined
          ? live.compacting !== undefined
            ? "compacting"
            : "thinking"
          : "chat";

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} region={region} />
      <Box ref={aboveRef} flexDirection="column">
        {run ? (
          <RunView run={run} onDone={onRunDone} onPending={onPending} onStage={setStage} />
        ) : null}
        {clarify ? (
          <ClarifyPanel questions={clarify.prompt.questions} index={clarify.answers.length} />
        ) : null}
      </Box>
      {proposal !== undefined ? <ProposalCard task={proposal} onAnswer={onProposal} /> : null}
      {trustOpen && trustSkills ? (
        <TrustPrompt
          pending={trustSkills.pendingRepo}
          found={trustSkills.found}
          repo={trustSkills.repo}
          trustFile={trustSkills.trustFile}
          onDone={onTrust}
        />
      ) : null}
      {contextOpen && contextInfo ? (
        <ContextPanel
          info={contextInfo}
          onClose={() => setContextInfo(undefined)}
          isActive={contextOpen}
          reserved={around}
        />
      ) : null}
      {pickerOpen && routingControl ? (
        <ModelPicker
          control={routingControl}
          onPick={applyPick}
          onClose={() => setModelOpen(false)}
          applying={applying}
        />
      ) : null}
      {skillsListOpen && listSkills ? (
        <SkillsPicker
          skills={listSkills}
          trustedLater={trustedLater}
          // No trust prompt during a run (as before): the list is read-only then.
          canReview={run === undefined && listSkills.pendingRepo.length > 0 && !trustedLater}
          onReview={openTrust}
          onClose={() => setSkillsOpen(false)}
        />
      ) : null}
      {live ? (
        <LiveTurn
          state={live}
          onInterrupt={abortTurn}
          interruptible={
            run === undefined &&
            proposal === undefined &&
            !trustOpen &&
            !popup &&
            !contextOpen &&
            !pickerOpen &&
            !skillsListOpen
          }
          maxRows={rows - LIVE_RESERVED_ROWS}
        />
      ) : null}
      <Box ref={belowRef} flexDirection="column">
        <InputBox
          busy={busy}
          disabled={inputOff || live !== undefined}
          // A clarification answer is free text: `?` types there.
          helpKey={clarify === undefined}
          // ...and so do `/` and `@`: no command menu or file picker there.
          popups={clarify === undefined}
          onSubmit={submit}
          inRun={run !== undefined}
          files={files}
          onWantFiles={wantFiles}
          onPopup={setPopup}
        />
        <StatusLine
          model={routingControl?.current().spec.model ?? modelsProp?.chat}
          context={context}
          ctx={ctx}
          checkpoints={checkpointsShort(checkpoints)}
          mode={mode}
        />
      </Box>
    </Box>
  );
}
