import { sanitizeTerminal } from "./terminal.js";

/**
 * The one secret matcher (I9). Every sink for model, repo or tool text (event log, headless
 * stream, terminal, report, prompts, commit message) redacts through `redact`; never copy it.
 */
const SECRET_SOURCES: readonly string[] = [
  // PEM private-key blocks, through the END line or, when truncated, the end of the text.
  "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
  // OpenAI / Anthropic (sk-, sk-ant-, sk-proj-), GitHub classic, AWS key ids (the v0.1 set).
  // Only at the start of a token: a letter or digit right before the prefix makes it part of a
  // word ("ask-matt", "--task-file", "disk-usage"), which is never a key.
  "(?<![A-Za-z0-9])(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]+",
  // GitHub OAuth, user-to-server, server-to-server and refresh tokens; fine-grained PATs.
  "gh[ousr]_[A-Za-z0-9_]{16,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  // Slack bot / app / user / refresh / config tokens.
  "xox[abprs]-[A-Za-z0-9-]{8,}",
  // Google API keys.
  "AIza[0-9A-Za-z_-]{30,}",
  // GitLab personal access tokens.
  "glpat-[A-Za-z0-9_-]{16,}",
  // Tavily API keys (tvly-dev-…, tvly-…). Brave and Ollama keys have no fixed prefix.
  "tvly-[A-Za-z0-9_-]{20,}",
];

/** Global pattern matching every secret `redact` removes. */
export const SECRET = new RegExp(SECRET_SOURCES.join("|"), "g");

/** Replace every secret-looking token with `[redacted]`. */
export const redact = (s: string): string => s.replace(SECRET, "[redacted]");

/**
 * Untrusted text (#23) on its way to a terminal, a file people `cat`, or `git log`:
 * `sanitizeTerminal` (ANSI sequences and control-string bodies, every C0/C1 control except the
 * newline, CR, bidi/invisible marks), with tabs dropped too. Run it before `redact` so a secret
 * split by an escape code is rejoined first.
 */
export function stripControls(s: string): string {
  return sanitizeTerminal(s).replaceAll("\t", "");
}
