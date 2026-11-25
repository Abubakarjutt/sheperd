import { RewireError, redact } from "@rewire/core";
import {
  type ChatEvent,
  type ChatSession,
  PROPOSAL_NOTE,
  type RunController,
  TURN_LIMIT_NOTE,
} from "@rewire/session";
import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { InputBox } from "./input.js";
import { Transcript, type TranscriptEntry } from "./transcript.js";

export type AppConfig = Record<string, unknown>;

export type AppProps = {
  session: ChatSession;
  /** Used by the run board in Task 12; the shell only carries it. */
  runController: RunController;
  config: AppConfig;
  /** Receives the chat events: wire `emit` of the ChatSession to the function it hands out. */
  subscribe?: (listener: (e: ChatEvent) => void) => () => void;
  /** Resolves the exit code of `renderTui` (`/exit`, Ctrl-C: wired in Tasks 13 and 14; Ink runs with exitOnCtrlC false, so Task 14 owns Ctrl-C). */
  onExit?: (code: number) => void;
};

const HIDDEN_NOTES = new Set([PROPOSAL_NOTE, TURN_LIMIT_NOTE]);

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

export function App({ session, subscribe }: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>(() => historyEntries(session));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const add = useCallback((...e: TranscriptEntry[]) => setEntries((cur) => [...cur, ...e]), []);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((e) => {
      const entry = eventEntry(e);
      if (entry) add(entry);
    });
  }, [subscribe, add]);

  const submit = useCallback(
    (text: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      add({ kind: "user", text });
      session
        .send(text)
        .then((turn) => {
          if (turn.text.trim() !== "") add({ kind: "assistant", text: turn.text });
        })
        .catch((err: unknown) => {
          const code = err instanceof RewireError ? err.code : "error";
          const message = redact(err instanceof Error ? err.message : String(err));
          add({ kind: "error", code, message });
        })
        .finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
    },
    [session, add],
  );

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      <InputBox busy={busy} onSubmit={submit} />
    </Box>
  );
}
