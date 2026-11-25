/** Pure state of the input box: text, multi-line editing and submitted-line history. */
export type InputState = {
  value: string;
  history: string[];
  /** Index into `history` while browsing it; undefined when editing fresh text. */
  cursor?: number;
  /** The fresh text saved when the user starts browsing history. */
  draft: string;
};

export type InputAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "newline" }
  | { type: "submit" }
  | { type: "up" }
  | { type: "down" };

export const initialInput: InputState = { value: "", history: [], draft: "" };

/**
 * Enter handling: a trailing backslash is the portable "newline" fallback for terminals that
 * do not report Shift+Enter (the backslash is removed). Otherwise the text is submitted
 * unless blank. Returns the next state and the submitted text, if any.
 */
export function reduceInput(
  s: InputState,
  a: InputAction,
): { state: InputState; submitted?: string } {
  switch (a.type) {
    case "insert":
      return { state: { ...s, value: s.value + a.text, cursor: undefined } };
    case "backspace":
      return { state: { ...s, value: s.value.slice(0, -1), cursor: undefined } };
    case "newline":
      return { state: { ...s, value: `${s.value}\n`, cursor: undefined } };
    case "submit": {
      if (s.value.endsWith("\\")) {
        return { state: { ...s, value: `${s.value.slice(0, -1)}\n`, cursor: undefined } };
      }
      const text = s.value;
      if (text.trim() === "") return { state: { ...s, value: "", cursor: undefined } };
      const last = s.history[s.history.length - 1];
      const history = last === text ? s.history : [...s.history, text];
      return { state: { value: "", history, draft: "" }, submitted: text };
    }
    case "up": {
      if (s.history.length === 0) return { state: s };
      const cursor = s.cursor === undefined ? s.history.length - 1 : Math.max(0, s.cursor - 1);
      const draft = s.cursor === undefined ? s.value : s.draft;
      return { state: { ...s, cursor, draft, value: s.history[cursor] ?? "" } };
    }
    case "down": {
      if (s.cursor === undefined) return { state: s };
      if (s.cursor >= s.history.length - 1) {
        return { state: { ...s, cursor: undefined, value: s.draft } };
      }
      const cursor = s.cursor + 1;
      return { state: { ...s, cursor, value: s.history[cursor] ?? "" } };
    }
  }
}
