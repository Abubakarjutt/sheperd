import type { ChatEvent } from "@rewire/session";
import { render } from "ink";
import { createElement } from "react";
import { App, type AppProps } from "./app.js";

export { App, type AppConfig, type AppProps, historyEntries } from "./app.js";
export { type InputAction, type InputState, initialInput, reduceInput } from "./input-state.js";
export { Safe } from "./safe.js";
export { sanitize } from "./sanitize.js";
export { theme } from "./theme.js";
export { EntryLine, Transcript, type TranscriptEntry, toolLabel } from "./transcript.js";

export type TuiDeps = Omit<AppProps, "onExit" | "subscribe"> & {
  /** Hands out the listener to pass as the ChatSession's `emit`. Called before rendering. */
  bindEmit?: (emit: (e: ChatEvent) => void) => void;
};

/** Renders the app and resolves with the exit code once `onExit(code)` is called. */
export async function renderTui(deps: TuiDeps): Promise<number> {
  const listeners = new Set<(e: ChatEvent) => void>();
  deps.bindEmit?.((e) => {
    for (const l of listeners) l(e);
  });
  return await new Promise<number>((resolve) => {
    const instance = render(
      createElement(App, {
        ...deps,
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        onExit: (code: number) => {
          instance.unmount();
          resolve(code);
        },
      }),
    );
  });
}
