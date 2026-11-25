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
import {
  age,
  type Command,
  DEFAULT_CHECKPOINTS,
  describeCheckpoints,
  HELP,
  literalText,
  parseCommand,
} from "./commands.js";
import { InputBox } from "./input.js";
import { ClarifyPanel, ProposalCard } from "./proposal.js";
import { sanitize } from "./sanitize.js";
import { Transcript, type TranscriptEntry } from "./transcript.js";
import { TrustPrompt } from "./trust-prompt.js";

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

export type AppProps = {
  session: ChatSession;
  runController: RunController;
  config: AppConfig;
  /** A run already in progress (tests); `/run` and accepted proposals set it from then on. */
  run?: RunHandle;
  /** Receives the chat events: wire `emit` of every ChatSession to the function it hands out. */
  subscribe?: (listener: (e: ChatEvent) => void) => () => void;
  /** Resolves the exit code of `renderTui` (`/exit`; Task 14 owns Ctrl-C). */
  onExit?: (code: number) => void;
  /** For `/clear` and `/resume`. */
  sessions?: SessionFactory;
  skills?: SkillsInfo;
  /** The `rewire doctor` output, for `/doctor` (injected: the CLI depends on this package). */
  doctor?: () => Promise<string>;
  /** The model routing, for `/model`. */
  routing?: string | (() => string);
  /** Initial checkpoints (default contract and tests). */
  checkpoints?: ReadonlySet<CheckpointKind>;
};

const HIDDEN_NOTES = new Set([PROPOSAL_NOTE, TURN_LIMIT_NOTE]);

export const RUN_ACTIVE = "a run is active; answer its prompt or press Ctrl-C to abort";
export const STALE_PROMPT = "that prompt is no longer active";
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

export function App(props: AppProps) {
  const { subscribe, runController, sessions, skills, doctor, routing, onExit } = props;
  const sessionRef = useRef(props.session);
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => historyEntries(props.session));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [run, setRun] = useState<RunHandle | undefined>(props.run);
  const [pending, setPending] = useState<PendingPrompt | undefined>(undefined);
  const [clarify, setClarify] = useState<Clarify | undefined>(undefined);
  const [proposal, setProposal] = useState<string | undefined>(undefined);
  const [checkpoints, setCheckpoints] = useState<ReadonlySet<CheckpointKind>>(
    () => props.checkpoints ?? DEFAULT_CHECKPOINTS,
  );
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustedLater, setTrustedLater] = useState(false);

  // A run handed in later by the parent replaces the current one.
  useEffect(() => {
    if (props.run) setRun(props.run);
  }, [props.run]);

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
    },
    [add],
  );
  const onPending = useCallback((p: PendingPrompt | undefined) => {
    setPending(p);
    setClarify(p?.kind === "clarify" ? { prompt: p, answers: [] } : undefined);
  }, []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((e) => {
      const entry = eventEntry(e);
      if (entry) add(entry);
    });
  }, [subscribe, add]);

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
        try {
          const turn = await sessionRef.current.send(text);
          if (turn.text.trim() !== "") add({ kind: "assistant", text: turn.text });
          if (turn.proposal) setProposal(turn.proposal.task);
          else if (turn.endedBy === "turn_limit") {
            note("(the turn stopped at its tool-call limit; send a message to continue)");
          }
        } catch (err) {
          add(errorEntry(err));
        }
      }),
    [exclusive, add, note],
  );

  const startRun = useCallback(
    (task: string) => {
      try {
        const handle = runController.start(task, { checkpoints: new Set(checkpoints) });
        setPending(undefined);
        setClarify(undefined);
        setRun(handle);
      } catch (err) {
        add(errorEntry(err));
      }
    },
    [runController, checkpoints, add],
  );

  const swapSession = useCallback(
    (make: () => Promise<ChatSession>, entriesOf: (s: ChatSession) => TranscriptEntry[]) =>
      exclusive(async () => {
        try {
          const next = await make();
          const old = sessionRef.current;
          sessionRef.current = next;
          setEntries(entriesOf(next));
          await old.dispose();
        } catch (err) {
          add(errorEntry(err));
        }
      }),
    [exclusive, add],
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
      swapSession(async () => {
        const known = (await sessions.list()).some((s) => s.id === id);
        if (!known) {
          throw new RewireError("session_not_found", `no stored session ${id} in this repo`);
        }
        return await sessions.resume(id);
      }, historyEntries);
    },
    [sessions, swapSession, note, add],
  );

  const runCommand = useCallback(
    (c: Command) => {
      switch (c.kind) {
        case "run":
          return startRun(c.task);
        case "skills": {
          note(skillsText(skills, trustedLater));
          if (!run && skills && skills.pendingRepo.length > 0 && !trustedLater) setTrustOpen(true);
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
          );
        case "doctor":
          if (!doctor) return note("doctor is not available here", true);
          doctor().then(
            (out) => note(out),
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
      skills,
      trustedLater,
      run,
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
    [run, note],
  );

  const submit = useCallback(
    (line: string) => {
      if (inFlight.current) return;
      add({ kind: "user", text: line });
      const cmd = parseCommand(line);
      if (run) {
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
    [run, clarify, add, note, answerClarify, runCommand, sendChat],
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

  const inputOff =
    proposal !== undefined || trustOpen || (run !== undefined && pending?.kind === "checkpoint");

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {run ? <RunView run={run} onDone={onRunDone} onPending={onPending} /> : null}
      {clarify ? (
        <ClarifyPanel questions={clarify.prompt.questions} index={clarify.answers.length} />
      ) : null}
      {proposal !== undefined ? <ProposalCard task={proposal} onAnswer={onProposal} /> : null}
      {trustOpen && skills ? (
        <TrustPrompt
          pending={skills.pendingRepo}
          found={skills.found}
          repo={skills.repo}
          trustFile={skills.trustFile}
          onDone={onTrust}
        />
      ) : null}
      <InputBox busy={busy} disabled={inputOff} onSubmit={submit} />
    </Box>
  );
}
