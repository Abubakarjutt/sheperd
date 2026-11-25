import { Box, Text } from "ink";
import { fitClean, fitStartClean } from "./fit.js";
import { Safe } from "./safe.js";
import { theme } from "./theme.js";
import { useColumns } from "./use-columns.js";

/** The models the session routes to: the chat model, and the gated run's roles. */
export type ModelsInfo = {
  chat: string;
  spec?: string;
  implementer?: string;
  /** Reviewer and verifier models, in order (duplicates are shown once). */
  reviewers?: readonly string[];
};

/** What the welcome header shows, snapshotted when it is printed. */
export type HeaderInfo = {
  cwd: string;
  /** The home directory, shown as `~`. */
  home?: string | undefined;
  models?: ModelsInfo | undefined;
  /** Active skills and repo skills waiting for trust; the line is shown only when nonzero. */
  skills?: { active: number; pending: number } | undefined;
};

export const WELCOME = `${theme.glyph.welcome} Welcome to rewire`;
export const TIP =
  "/help for commands · /run <task> for a gated change · @ to mention a file · esc to interrupt";
/** The header box is never wider than this, however wide the terminal. */
const HEADER_MAX = 100;

/** `path` with the home directory replaced by `~` (only the directory itself or a path under it). */
export function shortPath(path: string, home: string | undefined): string {
  if (!home) return path;
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  if (h === "") return path;
  if (path === h) return "~";
  if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
  return path;
}

/** `run: spec a · impl b · review c, d`, or undefined when no run model is known. */
export function runModelsLine(m: ModelsInfo | undefined): string | undefined {
  if (!m) return undefined;
  const parts: string[] = [];
  if (m.spec) parts.push(`spec ${m.spec}`);
  if (m.implementer) parts.push(`impl ${m.implementer}`);
  const reviewers = [...new Set(m.reviewers ?? [])].filter((r) => r !== "");
  if (reviewers.length > 0) parts.push(`review ${reviewers.join(", ")}`);
  return parts.length > 0 ? `run: ${parts.join(" · ")}` : undefined;
}

/**
 * The welcome box, printed once per transcript region through `<Static>`. Every value from the
 * config or the environment is cut with `fit` (which sanitizes) and rendered through `<Safe>`.
 */
export function Header({ info }: { info: HeaderInfo }) {
  const cols = useColumns();
  const boxWidth = Math.max(4, Math.min(cols, HEADER_MAX));
  const inner = boxWidth - 4; // two border columns and one column of padding on each side
  // Sanitized, then redacted, then cut (fitClean).
  const one = (s: string): string => fitClean(s, inner);
  const CWD = "cwd: ";
  const run = runModelsLine(info.models);
  const skills = info.skills;
  const skillParts: string[] = [];
  if (skills && skills.active > 0) skillParts.push(`${skills.active} active`);
  if (skills && skills.pending > 0) skillParts.push(`${skills.pending} pending trust`);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      width={boxWidth}
    >
      <Text bold wrap="truncate">
        {one(WELCOME)}
      </Text>
      <Safe wrap="truncate" color={theme.dim}>
        {`${CWD}${fitStartClean(shortPath(info.cwd, info.home), inner - CWD.length)}`}
      </Safe>
      {info.models ? <Safe wrap="truncate">{one(`chat: ${info.models.chat}`)}</Safe> : null}
      {run ? <Safe wrap="truncate">{one(run)}</Safe> : null}
      {skillParts.length > 0 ? (
        <Safe wrap="truncate">{one(`skills: ${skillParts.join(" · ")}`)}</Safe>
      ) : null}
      <Text> </Text>
      <Text color={theme.dim}>{TIP}</Text>
    </Box>
  );
}
