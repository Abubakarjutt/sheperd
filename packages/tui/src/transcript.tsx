import { Box, Text } from "ink";
import { fit } from "./fit.js";
import { Safe } from "./safe.js";
import { sanitize } from "./sanitize.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; summary: string; isError: boolean }
  | { kind: "skill"; name: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "note"; text: string; error?: boolean };

/** `read src/x.ts` renders as `Read src/x.ts`. */
export function toolLabel(summary: string): string {
  return summary === "" ? summary : summary.charAt(0).toUpperCase() + summary.slice(1);
}

/**
 * Single-line entries (user echo, tool, skill, error) are cut to the terminal width with an
 * ellipsis; assistant text and notes are prose and may wrap.
 */
export function EntryLine({ entry }: { entry: TranscriptEntry }) {
  const cols = useColumns();
  const one = (s: string): string => fit(s, cols);
  switch (entry.kind) {
    case "user":
      return (
        <Box flexDirection="column">
          {sanitize(entry.text)
            .split("\n")
            .map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed entry
              <Safe key={i} wrap="truncate" color={theme.user}>
                {one(`${i === 0 ? `${theme.glyph.user} ` : "  "}${l}`)}
              </Safe>
            ))}
        </Box>
      );
    case "assistant":
      return <Safe>{entry.text}</Safe>;
    case "tool":
      return entry.isError ? (
        <Safe wrap="truncate" color={theme.error}>
          {one(`${theme.glyph.toolError} ${toolLabel(entry.summary)}`)}
        </Safe>
      ) : (
        <Safe wrap="truncate" color={theme.tool}>
          {one(`${theme.glyph.tool} ${toolLabel(entry.summary)}`)}
        </Safe>
      );
    case "skill":
      return (
        <Safe wrap="truncate" color={theme.dim}>
          {one(`${theme.glyph.tool} Skill ${entry.name}`)}
        </Safe>
      );
    case "error":
      return (
        <Safe wrap="truncate" color={theme.error}>
          {one(`${theme.glyph.toolError} ${entry.code}: ${entry.message}`)}
        </Safe>
      );
    case "note":
      return <Safe color={entry.error ? theme.error : theme.dim}>{entry.text}</Safe>;
  }
}

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <Box flexDirection="column">
      {entries.map((e, i) => (
        // Append-only list: the index is a stable identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: entries are never reordered
        <EntryLine key={i} entry={e} />
      ))}
      {entries.length === 0 && (
        <Text color={theme.dim}>Ask about this repo, or describe a change.</Text>
      )}
    </Box>
  );
}
