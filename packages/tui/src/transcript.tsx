import { redact } from "@rewire/core";
import { Box, Static, Text } from "ink";
import { fit } from "./fit.js";
import { cleanForMarkdown, Markdown } from "./markdown.js";
import { Safe } from "./safe.js";
import { sanitize } from "./sanitize.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      summary: string;
      isError: boolean;
      /** The start of the tool's result (already sanitized and redacted by the session). */
      preview?: string[];
      /** Result lines left out of `preview`. */
      more?: number;
    }
  | { kind: "skill"; name: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "note"; text: string; error?: boolean };

/** `read src/x.ts` renders as `Read src/x.ts`. */
export function toolLabel(summary: string): string {
  return summary === "" ? summary : summary.charAt(0).toUpperCase() + summary.slice(1);
}

/** Splits a tool summary (`read src/x.ts`) into its display name (`Read`) and its arguments. */
export function toolParts(summary: string): { name: string; args: string } {
  const clean = redact(sanitize(summary))
    .replace(/[\n\t]+/g, " ")
    .trim();
  const sp = clean.indexOf(" ");
  if (sp < 0) return { name: toolLabel(clean), args: "" };
  return { name: toolLabel(clean.slice(0, sp)), args: clean.slice(sp + 1).trim() };
}

/** Prefix of a tool's first preview line, and the indent of the lines under it. */
const PREVIEW_HEAD = "  ⎿  ";
const PREVIEW_INDENT = "     ";

/**
 * `● Read(src/x.ts)` with the name bold, then the result preview under `  ⎿  ` (dim) and
 * `… +N lines`. An error is red with `✗`. Every line is cut to the terminal width.
 */
export function ToolLine({
  summary,
  isError,
  preview = [],
  more = 0,
}: {
  summary: string;
  isError: boolean;
  preview?: readonly string[];
  more?: number;
}) {
  const cols = useColumns();
  const { name, args } = toolParts(summary);
  const glyph = isError ? theme.glyph.toolError : theme.glyph.tool;
  const head = `${glyph} `;
  // Redacted before it is cut, so a cut can never split a secret out of its pattern.
  const line = fit(args === "" ? `${head}${name}` : `${head}${name}(${args})`, cols);
  const nameEnd = Math.min(line.length, head.length + name.length);
  const color = isError ? theme.error : theme.dim;
  const rest = Number.isFinite(more) && more > 0 ? Math.floor(more) : 0;
  const lines = preview.map(
    (l, i) => `${i === 0 ? PREVIEW_HEAD : PREVIEW_INDENT}${redact(sanitize(l))}`,
  );
  if (rest > 0) {
    lines.push(`${lines.length === 0 ? PREVIEW_HEAD : PREVIEW_INDENT}… +${rest} lines`);
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Safe color={isError ? theme.error : theme.tool}>{line.slice(0, head.length)}</Safe>
        <Safe bold color={isError ? theme.error : undefined}>
          {line.slice(head.length, nameEnd)}
        </Safe>
        <Safe color={isError ? theme.error : undefined}>{line.slice(nameEnd)}</Safe>
      </Text>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of one fixed preview
        <Safe key={i} wrap="truncate" color={color}>
          {fit(l, cols)}
        </Safe>
      ))}
    </Box>
  );
}

/**
 * Single-line entries (user echo, tool, skill, error) are cut to the terminal width with an
 * ellipsis; assistant text renders as Markdown at the terminal width, and notes are prose that
 * may wrap.
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
      // Cleaned whole (never per streamed delta), then parsed: see cleanForMarkdown.
      return <Markdown text={cleanForMarkdown(entry.text)} width={cols} />;
    case "tool":
      return (
        <ToolLine
          summary={entry.summary}
          isError={entry.isError}
          {...(entry.preview ? { preview: entry.preview } : {})}
          {...(entry.more !== undefined ? { more: entry.more } : {})}
        />
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

/**
 * Finished entries are printed once through Ink's `<Static>` (I3): once the transcript is taller
 * than the terminal, a dynamic transcript would be rewritten, and pushed into scrollback again,
 * on every keystroke. The list is append-only; a session swap (`/clear`, `/resume`) replaces it
 * and changes `region`, which remounts `<Static>` so the new list prints from its start. Lines are
 * cut to the width at the time they are printed; a later resize does not re-flow them.
 */
export function Transcript({
  entries,
  region = 0,
}: {
  entries: TranscriptEntry[];
  region?: number;
}) {
  return (
    <>
      <Static key={region} items={entries}>
        {(e, i) => (
          // Append-only list: the index is a stable identity.
          <EntryLine key={i} entry={e} />
        )}
      </Static>
      {entries.length === 0 && (
        <Text color={theme.dim}>Ask about this repo, or describe a change.</Text>
      )}
    </>
  );
}
