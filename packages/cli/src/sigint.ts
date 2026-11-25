export type SigintDeps = {
  on: (handler: () => void) => void;
  abort: () => void;
  exit: (code: number) => void;
  /** Called after the first interrupt, for a user-facing note. */
  notify?: () => void;
};

/** First Ctrl-C aborts the run (the orchestrator writes an interrupted report); the second exits 130. */
export function installSigint(deps: SigintDeps): void {
  let count = 0;
  deps.on(() => {
    count += 1;
    if (count === 1) {
      deps.abort();
      deps.notify?.();
    } else {
      deps.exit(130);
    }
  });
}

/**
 * Installs `handler` on the process's SIGINT and returns its uninstaller. The interactive TUI
 * feeds it to its Ctrl-C state machine (`interactive.ts`) alongside Ink's Ctrl-C key: while Ink
 * holds the terminal in raw mode, Ctrl-C arrives as a key, not as SIGINT.
 */
export function onProcessSigint(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}
