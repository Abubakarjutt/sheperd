import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { fit } from "./fit.js";
import { type InputAction, initialInput, reduceInput } from "./input-state.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export const PLACEHOLDER = "Ask about the code, or /run a task";

/** The `?` panel: key, then what it does. */
export const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["Enter", "send"],
  ["Shift+Enter or \\+Enter", "newline"],
  ["↑/↓", "history"],
  ["Esc", "interrupt or close"],
  ["Ctrl-C", "abort run or quit"],
  ["/", "commands"],
  ["@", "files"],
];

export type InputBoxProps = {
  busy: boolean;
  /** Hidden and deaf (a panel owns the keys), keeping its text and history. */
  disabled?: boolean;
  /** Whether `?` on an empty input toggles the shortcuts panel (default); false types it. */
  helpKey?: boolean;
  onSubmit: (text: string) => void;
};

function ShortcutsPanel() {
  const cols = useColumns();
  const keyWidth = Math.max(...SHORTCUTS.map(([k]) => k.length));
  return (
    <Box flexDirection="column" paddingX={1}>
      {SHORTCUTS.map(([k, what]) => (
        <Text key={k} wrap="truncate" color={theme.dim}>
          {fit(`${k.padEnd(keyWidth)}  ${what}`, cols - 2)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Multi-line input in a round border. Shift+Enter (where Ink reports it) or a trailing `\` +
 * Enter adds a line. `?` on an empty input toggles the shortcuts panel; any other key closes it.
 */
export function InputBox({ busy, disabled = false, helpKey = true, onSubmit }: InputBoxProps) {
  const [state, setState] = useState(initialInput);
  const ref = useRef(state);
  const [help, setHelpState] = useState(false);
  const helpRef = useRef(false);
  const setHelp = (on: boolean): void => {
    helpRef.current = on;
    setHelpState(on);
  };
  const cols = useColumns();
  // A panel left open when the input is hidden or busy must not come back with it.
  useEffect(() => {
    if (busy || disabled || !helpKey) {
      helpRef.current = false;
      setHelpState(false);
    }
  }, [busy, disabled, helpKey]);

  const apply = (action: InputAction): void => {
    const r = reduceInput(ref.current, action);
    ref.current = r.state;
    setState(r.state);
    if (r.submitted !== undefined) onSubmit(r.submitted);
  };

  useInput((input, key) => {
    if (busy || disabled) return; // one send at a time: typing is ignored while a turn is in flight
    if (helpKey && input === "?" && ref.current.value === "" && !key.ctrl && !key.meta) {
      setHelp(!helpRef.current);
      return;
    }
    if (helpRef.current) setHelp(false); // any other key closes the panel, then acts as usual
    if (key.return) apply({ type: key.shift ? "newline" : "submit" });
    else if (key.upArrow) apply({ type: "up" });
    else if (key.downArrow) apply({ type: "down" });
    else if (key.backspace || key.delete) apply({ type: "backspace" });
    else if (!key.ctrl && !key.meta && !key.escape && !key.tab && input) {
      apply({ type: "insert", text: input });
    }
  });

  if (disabled) return null;
  const typing = !busy && state.value !== "";
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={typing ? theme.accent : theme.border}
        paddingX={1}
        width={Math.max(4, cols)}
      >
        {busy ? (
          <Text wrap="truncate" color={theme.busy}>
            {fit("… working (Ctrl-C to interrupt)", cols - 4)}
          </Text>
        ) : (
          <>
            <Text color={theme.user}>{`${theme.glyph.user} `}</Text>
            <Box flexGrow={1}>
              {state.value === "" ? (
                <Text wrap="truncate" color={theme.dim}>
                  {fit(PLACEHOLDER, cols - 6)}
                </Text>
              ) : (
                <Safe>{`${state.value}▌`}</Safe>
              )}
            </Box>
          </>
        )}
      </Box>
      {help && !busy ? <ShortcutsPanel /> : null}
    </Box>
  );
}
