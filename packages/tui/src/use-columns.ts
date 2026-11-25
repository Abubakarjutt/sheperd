import { useStdout } from "ink";
import { useSyncExternalStore } from "react";

type Out = Partial<NodeJS.WriteStream> & NodeJS.EventEmitter;

const readColumns = (s?: { columns?: number }): number =>
  typeof s?.columns === "number" && s.columns > 0 ? s.columns : 80;
const readRows = (s?: { rows?: number }): number =>
  typeof s?.rows === "number" && s.rows > 0 ? s.rows : 24;

/**
 * One `resize` listener per stdout, shared by every component that reads the terminal size
 * (I2): a listener per component tripped Node's MaxListenersExceededWarning once a turn had a
 * dozen tool lines mounted. The listener is added with the first subscriber and removed with
 * the last. Snapshots are read straight from the stream, so they are always current.
 */
type SizeStore = { subscribe: (onChange: () => void) => () => void };
const stores = new WeakMap<object, SizeStore>();
const noStore: SizeStore = { subscribe: () => () => {} };

function storeFor(stdout: Out | undefined): SizeStore {
  if (!stdout || typeof stdout.on !== "function") return noStore;
  let store = stores.get(stdout);
  if (store) return store;
  const subscribers = new Set<() => void>();
  const onResize = (): void => {
    for (const s of [...subscribers]) s();
  };
  store = {
    subscribe(onChange) {
      if (subscribers.size === 0) stdout.on("resize", onResize);
      subscribers.add(onChange);
      return () => {
        subscribers.delete(onChange);
        if (subscribers.size === 0) stdout.off("resize", onResize);
      };
    },
  };
  stores.set(stdout, store);
  return store;
}

function useStdoutStream(): Out | undefined {
  return (useStdout() as unknown as { stdout?: Out }).stdout;
}

/** Current terminal width, re-read on every resize. Falls back to 80 when unknown. */
export function useColumns(): number {
  const stdout = useStdoutStream();
  const read = (): number => readColumns(stdout);
  return useSyncExternalStore(storeFor(stdout).subscribe, read, read);
}

/** Terminal height, re-read on every resize, with the same fallback behaviour (24). */
export function useRows(): number {
  const stdout = useStdoutStream();
  const read = (): number => readRows(stdout);
  return useSyncExternalStore(storeFor(stdout).subscribe, read, read);
}
