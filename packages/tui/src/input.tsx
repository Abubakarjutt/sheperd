import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { CommandMenu, menuItems, menuQuery } from "./command-menu.js";
import { atToken, FilePicker, insertPath, rankFiles } from "./file-picker.js";
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
  /** A gated run is active: the `/` menu lists only the commands allowed in a run. */
  inRun?: boolean;
  /** The repo's files for the `@` picker (empty until loaded). */
  files?: readonly string[];
  /** Called when an `@` token is typed, so the owner can load {@link files} (once per session). */
  onWantFiles?: () => void;
  /** Told whether the `/` menu or the `@` picker is open (it then owns Esc). */
  onPopup?: (open: boolean) => void;
};

type PopupKeys = {
  escape: boolean;
  upArrow: boolean;
  downArrow: boolean;
  tab: boolean;
  return: boolean;
  shift: boolean;
};

/** The open popup for `value`, if any: the `/` menu, else the `@` picker. */
type Popup =
  | { kind: "menu"; query: string; items: ReturnType<typeof menuItems> }
  | { kind: "picker"; token: NonNullable<ReturnType<typeof atToken>>; paths: string[] };

function popupFor(
  value: string,
  dismissed: string | undefined,
  inRun: boolean,
  files: readonly string[],
): Popup | undefined {
  if (dismissed === value) return undefined; // Esc closed it; the next edit may reopen it
  const query = menuQuery(value);
  if (query !== undefined) {
    const items = menuItems(query, inRun);
    return items.length > 0 ? { kind: "menu", query, items } : undefined;
  }
  const token = atToken(value);
  if (token === undefined) return undefined;
  const paths = rankFiles(files, token.query);
  return paths.length > 0 ? { kind: "picker", token, paths } : undefined;
}

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
export function InputBox({
  busy,
  disabled = false,
  helpKey = true,
  onSubmit,
  inRun = false,
  files = [],
  onWantFiles,
  onPopup,
}: InputBoxProps) {
  const [state, setState] = useState(initialInput);
  const ref = useRef(state);
  const [help, setHelpState] = useState(false);
  const helpRef = useRef(false);
  const setHelp = (on: boolean): void => {
    helpRef.current = on;
    setHelpState(on);
  };
  /** The popup selection, reset by every edit. */
  const [selected, setSelectedState] = useState(0);
  const selectedRef = useRef(0);
  const setSelected = (n: number): void => {
    selectedRef.current = n;
    setSelectedState(n);
  };
  /** The value Esc closed the popup for. */
  const [dismissed, setDismissedState] = useState<string | undefined>(undefined);
  const dismissedRef = useRef<string | undefined>(undefined);
  const setDismissed = (v: string | undefined): void => {
    dismissedRef.current = v;
    setDismissedState(v);
  };
  const filesRef = useRef(files);
  filesRef.current = files;
  const cols = useColumns();
  // A panel left open when the input is hidden or busy must not come back with it.
  useEffect(() => {
    if (busy || disabled || !helpKey) {
      helpRef.current = false;
      setHelpState(false);
    }
  }, [busy, disabled, helpKey]);

  const apply = (action: InputAction): void => {
    const before = ref.current.value;
    const r = reduceInput(ref.current, action);
    ref.current = r.state;
    setState(r.state);
    if (r.state.value !== before) setSelected(0);
    if (r.submitted !== undefined) onSubmit(r.submitted);
  };

  const live = !busy && !disabled;
  const popup = live ? popupFor(state.value, dismissed, inRun, files) : undefined;
  const wantsFiles = live && atToken(state.value) !== undefined;
  useEffect(() => {
    if (wantsFiles) onWantFiles?.();
  }, [wantsFiles, onWantFiles]);
  const popupOpen = popup !== undefined;
  useEffect(() => {
    onPopup?.(popupOpen);
  }, [popupOpen, onPopup]);

  /** Keys an open popup takes. True when the key was consumed. */
  const popupKey = (key: PopupKeys): boolean => {
    const value = ref.current.value;
    const p = popupFor(value, dismissedRef.current, inRun, filesRef.current);
    if (!p) return false;
    const count = p.kind === "menu" ? p.items.length : p.paths.length;
    const sel = Math.min(selectedRef.current, count - 1);
    if (key.escape) {
      setDismissed(value);
      return true;
    }
    if (key.upArrow || key.downArrow) {
      setSelected((sel + (key.upArrow ? count - 1 : 1)) % count);
      return true;
    }
    const enter = key.return && !key.shift;
    if (!key.tab && !enter) return false;
    if (p.kind === "picker") {
      apply({ type: "set", value: insertPath(value, p.token, p.paths[sel] as string) });
      return true;
    }
    const c = p.items[sel];
    if (!c) return false;
    // Enter on a complete name that needs no arguments runs it (optional ones may be left out);
    // otherwise Tab or Enter completes the name.
    if (enter && p.query.toLowerCase() === c.name && !c.argsRequired) {
      apply({ type: "set", value: `/${c.name}` });
      apply({ type: "submit" });
      return true;
    }
    const space = key.tab || c.argsRequired === true;
    apply({ type: "set", value: `/${c.name}${space ? " " : ""}` });
    return true;
  };

  useInput((input, key) => {
    if (busy || disabled) return; // one send at a time: typing is ignored while a turn is in flight
    if (helpKey && input === "?" && ref.current.value === "" && !key.ctrl && !key.meta) {
      setHelp(!helpRef.current);
      return;
    }
    if (helpRef.current) setHelp(false); // any other key closes the panel, then acts as usual
    if (popupKey(key)) return;
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
      {popup?.kind === "menu" ? (
        <CommandMenu items={popup.items} selected={Math.min(selected, popup.items.length - 1)} />
      ) : null}
      {popup?.kind === "picker" ? (
        <FilePicker paths={popup.paths} selected={Math.min(selected, popup.paths.length - 1)} />
      ) : null}
      {help && !busy ? <ShortcutsPanel /> : null}
    </Box>
  );
}
