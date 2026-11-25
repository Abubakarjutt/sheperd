import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { type InputAction, initialInput, reduceInput } from "./input-state.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";

export type InputBoxProps = {
  busy: boolean;
  /** Hidden and deaf (a panel owns the keys), keeping its text and history. */
  disabled?: boolean;
  onSubmit: (text: string) => void;
};

/** Multi-line input. Shift+Enter (where Ink reports it) or a trailing `\` + Enter adds a line. */
export function InputBox({ busy, disabled = false, onSubmit }: InputBoxProps) {
  const [state, setState] = useState(initialInput);
  const ref = useRef(state);

  const apply = (action: InputAction): void => {
    const r = reduceInput(ref.current, action);
    ref.current = r.state;
    setState(r.state);
    if (r.submitted !== undefined) onSubmit(r.submitted);
  };

  useInput((input, key) => {
    if (busy || disabled) return; // one send at a time: typing is ignored while a turn is in flight
    if (key.return) apply({ type: key.shift ? "newline" : "submit" });
    else if (key.upArrow) apply({ type: "up" });
    else if (key.downArrow) apply({ type: "down" });
    else if (key.backspace || key.delete) apply({ type: "backspace" });
    else if (!key.ctrl && !key.meta && !key.escape && !key.tab && input) {
      apply({ type: "insert", text: input });
    }
  });

  if (disabled) return null;
  if (busy) {
    return (
      <Box>
        <Text color={theme.busy}>… working</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={theme.user}>{`${theme.glyph.user} `}</Text>
      <Safe>{`${state.value}▌`}</Safe>
    </Box>
  );
}
