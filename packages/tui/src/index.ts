import { RewireError } from "@rewire/core";
import type { ChatEvent } from "@rewire/session";
import type { Skill } from "@rewire/skills";
import { type RenderOptions, render, useInput } from "ink";
import { Component, createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { App, type AppProps } from "./app.js";
import { TrustPrompt } from "./trust-prompt.js";

export {
  App,
  type AppConfig,
  type AppProps,
  historyEntries,
  type InterruptTarget,
  RUN_ACTIVE,
  type SessionFactory,
  type SkillsInfo,
  STALE_PROMPT,
  sessionNotices,
  TRUSTED_LATER,
} from "./app.js";
export { CommandMenu, menuItems, menuQuery, menuWindow, POPUP_ROWS } from "./command-menu.js";
export {
  allowedInRun,
  COMMAND_HELP,
  type Command,
  type CommandHelp,
  commandUsage,
  DEFAULT_CHECKPOINTS,
  describeCheckpoints,
  HELP,
  isCommand,
  literalText,
  parseCommand,
} from "./commands.js";
export {
  COMPACT_CANCELLED,
  ContextBody,
  type ContextInfo,
  ContextPanel,
  compactionEntries,
  contextLines,
  INDEPENDENCE_NOTICE,
  type LastCompaction,
  lastCompactionOf,
  recordCounts,
} from "./compaction-view.js";
export {
  type AtToken,
  atToken,
  FilePicker,
  insertPath,
  rankFiles,
  splitPath,
} from "./file-picker.js";
export { listRepoFiles, MAX_REPO_FILES } from "./files.js";
export { Header, type HeaderInfo, type ModelsInfo, shortPath, TIP, WELCOME } from "./header.js";
export {
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINE,
  HIGHLIGHT_MAX_LINES,
  highlight,
  type Segment,
} from "./highlight.js";
export { InputBox, PLACEHOLDER, SHORTCUTS } from "./input.js";
export { type InputAction, type InputState, initialInput, reduceInput } from "./input-state.js";
export {
  ListPicker,
  type ListPickerItem,
  type ListPickerProps,
  moveSelection,
} from "./list-picker.js";
export {
  applyEvent,
  INTERRUPTED,
  LIVE_THROTTLE_MS,
  type LiveItem,
  type LiveState,
  LiveTurn,
  liveEntries,
  splitBlocks,
  takeFinished,
} from "./live-turn.js";
export { cleanForMarkdown, Markdown } from "./markdown.js";
export { ModelPicker, type ModelPickerProps } from "./model-picker.js";
export {
  ROUTING_ROLES,
  type RoutingControlDep,
  type RoutingModel,
  type RoutingPick,
  type RoutingRole,
  type RoutingSource,
  type RoutingView,
  routingLines,
} from "./routing.js";
export { Safe } from "./safe.js";
export { sanitize } from "./sanitize.js";
export {
  COMPACTING_VERB,
  ESC_CANCEL,
  ESC_INTERRUPT,
  formatTokens,
  SPINNER_GLYPHS,
  SPINNER_VERBS,
  Spinner,
} from "./spinner.js";
export {
  CTX_ALERT,
  CTX_WARN,
  type CtxStatus,
  ctxLevel,
  kTokens,
  REASON_INITIAL,
  SHORTCUTS_HINT,
  type StatusLayout,
  StatusLine,
  type StatusParts,
  statusLayout,
  statusText,
} from "./status-line.js";
export { theme } from "./theme.js";
export {
  EntryLine,
  ToolLine,
  Transcript,
  type TranscriptEntry,
  toolLabel,
  toolParts,
} from "./transcript.js";

/** Turns a render-time throw into a settled `renderTui` (exit 1) instead of a hung promise. */
class Boundary extends Component<
  { onError: (e: unknown) => void; children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Ink's raw mode turns Ctrl-C into a key, not SIGINT (`exitOnCtrlC` is false): report it. The
 * other inputs ignore ctrl keys, so the press reaches only this listener's caller.
 */
function InterruptKeys({ onInterrupt }: { onInterrupt: () => void }): null {
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt();
  });
  return null;
}

/** Ink render options; `exitOnCtrlC` is always false (the CLI owns Ctrl-C). */
export type TuiRenderOptions = Omit<RenderOptions, "exitOnCtrlC">;

/**
 * Mounts `node` (plus the Ctrl-C key listener) and resolves with the code passed to `exit`.
 * Settles on every path: `exit(code)`, an unmount from outside (0), a render error (1).
 */
function mount(
  node: (exit: (code: number) => void) => ReactElement,
  opts: {
    onInterrupt?: (() => void) | undefined;
    bindExit?: ((exit: (code: number) => void) => void) | undefined;
    renderOptions?: TuiRenderOptions | undefined;
    /** Called with a render-time throw, before `exit(1)`. */
    onError?: ((e: unknown) => void) | undefined;
  },
): Promise<number> {
  return new Promise<number>((resolve) => {
    // Hoisted so `exit` can reach the instance created below. `exit` may run during the first
    // synchronous render, before `render` returns: the instance is then not assigned yet.
    let instance: ReturnType<typeof render> | undefined;
    let requested = false;
    let unmounted = false;
    const unmount = (): void => {
      if (unmounted || !instance) return;
      unmounted = true;
      instance.unmount();
    };
    const exit = (code: number): void => {
      resolve(code);
      requested = true;
      unmount();
    };
    const onInterrupt = opts.onInterrupt;
    instance = render(
      createElement(
        Fragment,
        null,
        onInterrupt ? createElement(InterruptKeys, { onInterrupt }) : null,
        createElement(
          Boundary,
          {
            onError: (e: unknown) => {
              opts.onError?.(e);
              exit(1);
            },
          },
          node(exit),
        ),
      ),
      { ...opts.renderOptions, exitOnCtrlC: false },
    );
    // An exit during the first render could not unmount yet: do it now.
    if (requested) unmount();
    opts.bindExit?.(exit);
    // Settle on every path: an unmount from outside resolves 0, a render error resolves 1.
    instance.waitUntilExit().then(
      () => resolve(0),
      () => resolve(1),
    );
  });
}

export type TuiDeps = Omit<AppProps, "onExit" | "subscribe"> & {
  /** Hands out the listener to pass as the ChatSession's `emit`. Called before rendering. */
  bindEmit?: (emit: (e: ChatEvent) => void) => void;
  /** Hands out `exit(code)`, which resolves `renderTui` (for Task 14's Ctrl-C and `/exit`). */
  bindExit?: (exit: (code: number) => void) => void;
  /** Ink's Ctrl-C key (raw mode): feed it to the CLI's Ctrl-C state machine. */
  onInterrupt?: () => void;
  /** Test seam: streams for Ink. `exitOnCtrlC` is always false (the CLI owns Ctrl-C). */
  renderOptions?: TuiRenderOptions;
};

/**
 * Renders the app and resolves with the exit code once `onExit(code)` is called. A render error
 * rejects with `tui_render_failed` (never a silent exit 1), as the trust prompt does.
 */
export async function renderTui(deps: TuiDeps): Promise<number> {
  const listeners = new Set<(e: ChatEvent) => void>();
  deps.bindEmit?.((e) => {
    for (const l of listeners) l(e);
  });
  const { renderOptions, bindEmit: _bind, bindExit, onInterrupt, ...appDeps } = deps;
  let failure: { error: unknown } | undefined;
  const code = await mount(
    (exit) =>
      createElement(App, {
        ...appDeps,
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        onExit: exit,
      }),
    {
      onInterrupt,
      bindExit,
      renderOptions,
      onError: (error) => {
        failure = { error };
      },
    },
  );
  if (failure) {
    const e = failure.error;
    throw new RewireError(
      "tui_render_failed",
      `the interactive session failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return code;
}

export type TrustPromptRenderDeps = {
  found: Skill[];
  pendingRepo: Skill[];
  repo: string;
  trustFile: string;
  onInterrupt?: () => void;
  /** Hands out `exit()`, which closes the prompt: it then resolves `undefined`. */
  bindExit?: (exit: (code: number) => void) => void;
  renderOptions?: TuiRenderOptions;
};

/**
 * The startup trust prompt, on its own before the app: resolves `true` once the approval is
 * saved, `false` when declined, and `undefined` when closed by `exit` (Ctrl-C). A render error
 * rejects with `tui_render_failed` (never a silent close). The message is not sanitized here.
 */
export async function renderTrustPrompt(deps: TrustPromptRenderDeps): Promise<boolean | undefined> {
  let answer: boolean | undefined;
  let failure: { error: unknown } | undefined;
  await mount(
    (exit) =>
      createElement(TrustPrompt, {
        pending: deps.pendingRepo,
        found: deps.found,
        repo: deps.repo,
        trustFile: deps.trustFile,
        onDone: (trusted: boolean) => {
          answer = trusted;
          exit(0);
        },
      }),
    {
      onInterrupt: deps.onInterrupt,
      bindExit: deps.bindExit,
      renderOptions: deps.renderOptions,
      onError: (error) => {
        failure = { error };
      },
    },
  );
  if (failure) {
    const e = failure.error;
    throw new RewireError(
      "tui_render_failed",
      `the trust prompt failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return answer;
}

export {
  type BoardState,
  currentStage,
  initialBoard,
  reduceBoard,
  STAGES,
  withCheckpoint,
} from "./board.js";
export { Board, RunView } from "./board-view.js";
export { CheckpointPanel, type CheckpointPrompt, diffStat } from "./checkpoint.js";
export { fit, fitClean, fitStartClean } from "./fit.js";
export { ClarifyPanel, ProposalCard } from "./proposal.js";
export {
  listSkillFiles,
  type SkillFile,
  TrustPrompt,
  type TrustPromptProps,
  VIEW_FILES_CAP,
} from "./trust-prompt.js";
