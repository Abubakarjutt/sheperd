import { useStdout } from "ink";
import { useEffect, useState } from "react";

const readColumns = (s?: { columns?: number }): number =>
  typeof s?.columns === "number" && s.columns > 0 ? s.columns : 80;

/** Current terminal width, re-read on every resize. Falls back to 80 when unknown. */
export function useColumns(): number {
  const { stdout } = useStdout() as unknown as {
    stdout?: Partial<NodeJS.WriteStream> & NodeJS.EventEmitter;
  };
  const [cols, setCols] = useState(() => readColumns(stdout));
  useEffect(() => {
    const onResize = (): void => setCols(readColumns(stdout));
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  return cols;
}

const readRows = (s?: { rows?: number }): number =>
  typeof s?.rows === "number" && s.rows > 0 ? s.rows : 24;

/** Terminal height, re-read on every resize, with the same fallback behaviour (24). */
export function useRows(): number {
  const { stdout } = useStdout() as unknown as {
    stdout?: Partial<NodeJS.WriteStream> & NodeJS.EventEmitter;
  };
  const [rows, setRows] = useState(() => readRows(stdout));
  useEffect(() => {
    const onResize = (): void => setRows(readRows(stdout));
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  return rows;
}
