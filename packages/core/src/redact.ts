// biome-ignore-all lint/suspicious/noControlCharactersInRegex: matching control characters is the job

/**
 * The one secret matcher (I9). Every sink for model, repo or tool text (event log, headless
 * stream, terminal, report, prompts, commit message) redacts through `redact`; never copy it.
 */
const SECRET_SOURCES: readonly string[] = [
  // PEM private-key blocks, through the END line or, when truncated, the end of the text.
  "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
  // OpenAI / Anthropic (sk-, sk-ant-, sk-proj-), GitHub classic, AWS key ids (the v0.1 set).
  "(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]+",
  // GitHub OAuth, user-to-server, server-to-server and refresh tokens; fine-grained PATs.
  "gh[ousr]_[A-Za-z0-9_]{16,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  // Slack bot / app / user / refresh / config tokens.
  "xox[abprs]-[A-Za-z0-9-]{8,}",
  // Google API keys.
  "AIza[0-9A-Za-z_-]{30,}",
  // GitLab personal access tokens.
  "glpat-[A-Za-z0-9_-]{16,}",
];

/** Global pattern matching every secret `redact` removes. */
export const SECRET = new RegExp(SECRET_SOURCES.join("|"), "g");

/** Replace every secret-looking token with `[redacted]`. */
export const redact = (s: string): string => s.replace(SECRET, "[redacted]");

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_PAIR = /\u001b[@-Z\\-_]?/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * Untrusted text (#23) on its way to a terminal, a file people `cat`, or `git log`: drop ANSI
 * OSC/CSI sequences, every C0/C1 control character except the newline, and bidi/invisible
 * marks. Run it before `redact` so a secret split by an escape code is rejoined first.
 */
export function stripControls(s: string): string {
  return s
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_PAIR, "")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "");
}
