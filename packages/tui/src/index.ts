import type { ChatEvent } from "@rewire/session";
import { type RenderOptions, render } from "ink";
import { Component, createElement, type ReactNode } from "react";
import { App, type AppProps } from "./app.js";

export { App, type AppConfig, type AppProps, historyEntries } from "./app.js";
export { type InputAction, type InputState, initialInput, reduceInput } from "./input-state.js";
export { Safe } from "./safe.js";
export { sanitize } from "./sanitize.js";
export { theme } from "./theme.js";
export { EntryLine, Transcript, type TranscriptEntry, toolLabel } from "./transcript.js";

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

export type TuiDeps = Omit<AppProps, "onExit" | "subscribe"> & {
  /** Hands out the listener to pass as the ChatSession's `emit`. Called before rendering. */
  bindEmit?: (emit: (e: ChatEvent) => void) => void;
  /** Hands out `exit(code)`, which resolves `renderTui` (for Task 14's Ctrl-C and `/exit`). */
  bindExit?: (exit: (code: number) => void) => void;
  /** Test seam: streams for Ink. `exitOnCtrlC` is always false (Task 14 owns Ctrl-C). */
  renderOptions?: Omit<RenderOptions, "exitOnCtrlC">;
};

/** Renders the app and resolves with the exit code once `onExit(code)` is called. */
export async function renderTui(deps: TuiDeps): Promise<number> {
  const listeners = new Set<(e: ChatEvent) => void>();
  deps.bindEmit?.((e) => {
    for (const l of listeners) l(e);
  });
  const { renderOptions, bindEmit: _bind, bindExit, ...appDeps } = deps;
  return await new Promise<number>((resolve) => {
    // Hoisted so `exit` can reach the instance created below.
    let instance: ReturnType<typeof render>;
    const exit = (code: number): void => {
      resolve(code);
      instance.unmount();
    };
    instance = render(
      createElement(
        Boundary,
        { onError: () => exit(1) },
        createElement(App, {
          ...appDeps,
          subscribe: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
          },
          onExit: exit,
        }),
      ),
      { ...renderOptions, exitOnCtrlC: false },
    );
    bindExit?.(exit);
    // Settle on every path: an unmount from outside resolves 0, a render error resolves 1.
    instance.waitUntilExit().then(
      () => resolve(0),
      () => resolve(1),
    );
  });
}
