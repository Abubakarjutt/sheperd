import { Box, Text } from "ink";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; summary: string; isError: boolean }
  | { kind: "skill"; name: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "note"; text: string };

/** `read src/x.ts` renders as `Read src/x.ts`. */
export function toolLabel(summary: string): string {
  return summary === "" ? summary : summary.charAt(0).toUpperCase() + summary.slice(1);
}

export function EntryLine({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "user":
      return <Safe color={theme.user}>{`${theme.glyph.user} ${entry.text}`}</Safe>;
    case "assistant":
      return <Safe>{entry.text}</Safe>;
    case "tool":
      return entry.isError ? (
        <Safe color={theme.error}>{`${theme.glyph.toolError} ${toolLabel(entry.summary)}`}</Safe>
      ) : (
        <Safe color={theme.tool}>{`${theme.glyph.tool} ${toolLabel(entry.summary)}`}</Safe>
      );
    case "skill":
      return <Safe color={theme.dim}>{`${theme.glyph.tool} Skill ${entry.name}`}</Safe>;
    case "error":
      return (
        <Safe
          color={theme.error}
        >{`${theme.glyph.toolError} ${entry.code}: ${entry.message}`}</Safe>
      );
    case "note":
      return <Safe color={theme.dim}>{entry.text}</Safe>;
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
