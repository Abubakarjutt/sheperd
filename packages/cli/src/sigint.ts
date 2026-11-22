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
