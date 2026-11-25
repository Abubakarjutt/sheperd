import { homedir } from "node:os";
import { type CheckpointKind, RewireError, redact } from "@rewire/core";
import {
  type ChatEvent,
  type ChatSession,
  outcomeMessage,
  type PendingPrompt,
  PROPOSAL_NOTE,
  type RunController,
  type RunHandle,
  type SessionSummary,
  TURN_LIMIT_NOTE,
} from "@rewire/session";
import type { Skill } from "@rewire/skills";
import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type RunDone, RunView } from "./board-view.js";
import { STALE_PROMPT } from "./checkpoint.js";
import {
  age,
  type Command,
  DEFAULT_CHECKPOINTS,
  describeCheckpoints,
  HELP,
  literalText,
  parseCommand,
} from "./commands.js";
import type { HeaderInfo, ModelsInfo } from "./header.js";
import { InputBox } from "./input.js";
import {
  applyEvent,
  INTERRUPTED,
  LIVE_THROTTLE_MS,
  type LiveState,
  LiveTurn,
  liveEntries,
  newLive,
  streamedText,
} from "./live-turn.js";
import { ClarifyPanel, ProposalCard } from "./proposal.js";
import { sanitize } from "./sanitize.js";
import { pickVerb } from "./spinner.js";
import { StatusLine } from "./status-line.js";
import { Transcript, type TranscriptEntry } from "./transcript.js";
import { TrustPrompt } from "./trust-prompt.js";

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
  /** The model routing, for `/model`. */
  routing?: string | (() => string);
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
};

const HIDDEN_NOTES = new Set([PROPOSAL_NOTE, TURN_LIMIT_NOTE]);

export const RUN_ACTIVE = "a run is active; answer its prompt or press Ctrl-C to abort";
const SEPARATOR = "───";
export const TRUSTED_LATER = "trusted; takes effect in a new session (/clear)";

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

function eventEntry(e: ChatEvent): TranscriptEntry | undefined {
  if (e.type === "tool_call") return { kind: "tool", summary: e.summary, isError: e.isError };
  if (e.type === "skill_loaded") return { kind: "skill", name: e.name };
  return undefined; // assistant_text: the turn's final text is appended from ChatTurn.text
}

function errorEntry(err: unknown): TranscriptEntry {
  const code = err instanceof RewireError ? err.code : "error";
  const message = redact(err instanceof Error ? err.message : String(err));
  return { kind: "error", code, message };
}

function skillsText(s: SkillsInfo | undefined, trustedLater: boolean): string {
  if (!s || s.found.length === 0) return "no skills found";
  const names = (list: Skill[]) => list.map((k) => `${k.name} (${k.source})`).join(", ");
  const lines = [`active: ${s.active.length ? names(s.active) : "none"}`];
  if (s.pendingRepo.length) {
    const why = trustedLater ? TRUSTED_LATER : "not trusted";
    lines.push(`pending: ${s.pendingRepo.map((k) => k.name).join(", ")} (${why})`);
  }
  const shadowed = s.found.filter((k) => k.shadowed);
  if (shadowed.length) {
    lines.push(
      `shadowed: ${shadowed.map((k) => k.name).join(", ")} (a user skill has the same name)`,
    );
  }
  return lines.join("\n");
}

/** Commands that work while a run is active (the others would race it or the session). */
function allowedInRun(c: Command): boolean {
  if (c.kind === "checkpoints") return c.set === undefined;
  return c.kind === "help" || c.kind === "model" || c.kind === "skills" || c.kind === "skip";
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
  const skillsProp = props.skills;
  const skillsNow = useCallback(
    (): SkillsInfo | undefined => (typeof skillsProp === "function" ? skillsProp() : skillsProp),
    [skillsProp],
  );
  const configRepo = props.config.repo;
  const cwd = props.cwd ?? (typeof configRepo === "string" ? configRepo : process.cwd());
  const home = props.home ?? homedir();
  const models = props.models;
  /** The welcome box as of now (the skills getter is re-read, so `/clear` shows the new counts). */
  const headerEntry = useCallback((): TranscriptEntry => {
    const s = skillsNow();
    const info: HeaderInfo = {
      cwd,
      home,
      models,
      ...(s ? { skills: { active: s.active.length, pending: s.pendingRepo.length } } : {}),
    };
    return { kind: "header", info };
  }, [skillsNow, cwd, home, models]);
  /** The in-flight chat turn's abort, set while `send` runs. */
  const turnAbort = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(props.session);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => [
    headerEntry(),
    ...(props.warnings ?? []).map((text): TranscriptEntry => ({ kind: "note", text })),
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
  /** Input plus output tokens of this session's model calls (`usage` events). */
  const [tokens, setTokens] = useState(0);
  /** The active run's stage, from its board (status line). */
  const [stage, setStage] = useState<string | undefined>(undefined);
  const [trustedLater, setTrustedLater] = useState(false);
  /**
   * The in-flight chat turn's live area. Events fold into `liveRef` at once; the rendered copy
   * (`live`) follows at most every LIVE_THROTTLE_MS, and is flushed whole when the turn ends.
   */
  const liveRef = useRef<LiveState | undefined>(undefined);
  const [live, setLive] = useState<LiveState | undefined>(undefined);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleLive = useCallback(() => {
    if (liveTimer.current !== undefined) return;
    liveTimer.current = setTimeout(() => {
      liveTimer.current = undefined;
      setLive(liveRef.current);
    }, LIVE_THROTTLE_MS);
  }, []);
  /** Ends the live area (no timer left behind) and returns its final state. */
  const endLive = useCallback((): LiveState | undefined => {
    clearTimeout(liveTimer.current);
    liveTimer.current = undefined;
    const last = liveRef.current;
    liveRef.current = undefined;
    setLive(undefined);
    return last;
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

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
    },
    [setClarify],
  );

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((e) => {
      if (e.type === "usage") {
        const n = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
        setTokens((t) => t + n(e.inputTokens) + n(e.outputTokens));
      }
      if (liveRef.current) {
        liveRef.current = applyEvent(liveRef.current, e);
        scheduleLive();
        return;
      }
      const entry = eventEntry(e);
      if (entry) add(entry);
    });
  }, [subscribe, add, scheduleLive]);

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
          const done = endLive();
          // Streamed text is the turn's text (its last part is the final answer): shown once.
          const final: TranscriptEntry[] =
            !streamedText(done) && turn.text.trim() !== ""
              ? [{ kind: "assistant", text: turn.text }]
              : [];
          add(...liveEntries(done), ...final);
          if (turn.proposal) setProposal(turn.proposal.task);
          else if (turn.endedBy === "turn_limit") {
            note("(the turn stopped at its tool-call limit; send a message to continue)");
          }
        } catch (err) {
          // What already streamed stays, then why the turn ended: Esc or Ctrl-C, or an error.
          const done = endLive();
          add(
            ...liveEntries(done),
            ac.signal.aborted ? { kind: "note", text: INTERRUPTED } : errorEntry(err),
          );
        } finally {
          if (turnAbort.current === ac) turnAbort.current = undefined;
        }
      }),
    [exclusive, add, note, endLive],
  );

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

  const swapSession = useCallback(
    (
      make: () => Promise<ChatSession>,
      entriesOf: (s: ChatSession) => TranscriptEntry[],
      label: string,
    ) =>
      exclusive(async () => {
        try {
          const next = await make();
          const old = sessionRef.current;
          sessionRef.current = next;
          // The old transcript stays in the terminal's scrollback above this separator.
          setEntries([
            { kind: "note", text: `${SEPARATOR} ${label} ${SEPARATOR}` },
            headerEntry(),
            ...entriesOf(next),
          ]);
          setRegion((r) => r + 1);
          setTokens(0);
          // The new session re-resolved the skills: a trust given earlier is now in effect.
          setTrustedLater(false);
          await old.dispose();
        } catch (err) {
          add(errorEntry(err));
        }
      }),
    [exclusive, add, headerEntry],
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
          note(skillsText(skills, trustedLater));
          if (!runRef.current && skills && skills.pendingRepo.length > 0 && !trustedLater)
            setTrustOpen(true);
          return;
        }
        case "checkpoints":
          if (c.set) setCheckpoints(c.set);
          return note(describeCheckpoints(c.set ?? checkpoints));
        case "model": {
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
      trustedLater,
      checkpoints,
      routing,
      resume,
      sessions,
      swapSession,
      doctor,
      onExit,
      note,
      add,
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

  /** Esc in the live area: aborts the turn's signal, like the Ctrl-C machine's abortTurn. */
  const abortTurn = useCallback(() => turnAbort.current?.abort(), []);
  const trustSkills = trustOpen ? skillsNow() : undefined;
  const inputOff =
    proposal !== undefined || trustOpen || (run !== undefined && pending?.kind === "checkpoint");
  const mode =
    run !== undefined && pending?.kind === "checkpoint"
      ? `checkpoint: ${pending.checkpoint.kind}`
      : run !== undefined
        ? `run: ${stage ?? "starting"}`
        : live !== undefined
          ? "thinking"
          : "chat";

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} region={region} />
      {run ? (
        <RunView run={run} onDone={onRunDone} onPending={onPending} onStage={setStage} />
      ) : null}
      {clarify ? (
        <ClarifyPanel questions={clarify.prompt.questions} index={clarify.answers.length} />
      ) : null}
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
      {live ? (
        <LiveTurn
          state={live}
          onInterrupt={abortTurn}
          interruptible={run === undefined && proposal === undefined && !trustOpen}
        />
      ) : null}
      <InputBox busy={busy} disabled={inputOff || live !== undefined} onSubmit={submit} />
      <StatusLine
        model={models?.chat}
        tokens={tokens}
        checkpoints={checkpointsShort(checkpoints)}
        mode={mode}
      />
    </Box>
  );
}
