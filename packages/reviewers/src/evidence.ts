import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { type Finding, normalizeEvidence, type SlopCategory } from "@rewire/core";
import type { SandboxClient } from "@rewire/sandbox";
import type { DiffSummary } from "./diff.js";

/** Largest file the verifier or the prompt builder will read. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Evidence shorter than this (non-whitespace characters) matches almost anything. */
export const MIN_EVIDENCE_CHARS = 8;
const MAX_RANGE = 10;
/** Longer reviewer-supplied paths are dropped as "file outside worktree". */
const MAX_PATH_CHARS = 1024;
const CONTEXT = 3;

export type Dropped = { finding: Finding; reason: string };

export type FilterOptions = {
  /** When set, a finding outside these categories is dropped (reason 5). */
  categories?: readonly SlopCategory[];
  /** Read-only review client. Without it files are read on the host (still realpath-contained). */
  client?: Pick<SandboxClient, "read">;
};

export type SafeRead =
  | { kind: "ok"; path: string; text: string }
  | { kind: "outside" }
  | { kind: "missing" }
  | { kind: "too_large" };

const outsideRoot = (rel: string): boolean =>
  rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null ? ((e as { code?: string }).code ?? undefined) : undefined;

/** A path that simply is not there (or is denied by the sandbox profile): not an infra failure. */
const isMissing = (e: unknown): boolean => {
  const c = codeOf(e);
  return (
    c === "ENOENT" ||
    c === "ENOTDIR" ||
    c === "ENAMETOOLONG" ||
    c === "ELOOP" ||
    c === "EINVAL" ||
    c === "path_protected"
  );
};

/**
 * Resolve `rel` (worktree-relative) to its real path only if that is a regular file inside the
 * real worktree and not under any `.git` segment. Absolute paths, `..` traversal and symlinks
 * leading out are "outside"; a non-regular file is "missing".
 */
export async function resolveInsideWorktree(
  worktree: string,
  rel: string,
): Promise<{ kind: "ok"; path: string; size: number } | { kind: "outside" } | { kind: "missing" }> {
  if (rel === "" || rel.length > MAX_PATH_CHARS || rel.includes("\0") || isAbsolute(rel)) {
    return { kind: "outside" };
  }
  const root = await realpath(worktree);
  const abs = resolve(root, rel);
  if (outsideRoot(relative(root, abs))) return { kind: "outside" };
  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    if (isMissing(e)) return { kind: "missing" };
    throw e;
  }
  const inner = relative(root, real);
  if (outsideRoot(inner) || inner.split(sep).includes(".git")) return { kind: "outside" };
  try {
    const st = await stat(real);
    if (!st.isFile()) return { kind: "missing" };
    return { kind: "ok", path: real, size: st.size };
  } catch (e) {
    if (isMissing(e)) return { kind: "missing" };
    throw e;
  }
}

/**
 * Read `rel` (worktree-relative) only if resolveInsideWorktree accepts it. Reads go through the
 * review sandbox client when given. "missing" covers a path that is not there or not a regular
 * file (ENOENT, ENOTDIR, ENAMETOOLONG, ELOOP, EINVAL, or a sandbox `path_protected` denial); every
 * other I/O or sandbox error is rethrown so the review fails closed instead of treating
 * infrastructure trouble as "no evidence". The check-then-read gap (a swap after realpath) is not
 * closed on the host path; the sandbox read re-checks containment itself.
 */
export async function readInsideWorktree(
  worktree: string,
  rel: string,
  client?: Pick<SandboxClient, "read">,
): Promise<SafeRead> {
  const r = await resolveInsideWorktree(worktree, rel);
  if (r.kind !== "ok") return r;
  if (r.size > MAX_FILE_BYTES) return { kind: "too_large" };
  try {
    const text = client ? await client.read(r.path) : await readFile(r.path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return { kind: "too_large" };
    return { kind: "ok", path: r.path, text };
  } catch (e) {
    if (isMissing(e)) return { kind: "missing" };
    throw e;
  }
}

/** #23 closers were defanged to `<\/tag` in the prompt; fold both spellings to `</tag`. */
const CLOSER_FOLD = /<\s*\\?\s*\/\s*(diff|file|contract)/gi;

/**
 * Matching-only normaliser (ids use core's normalizeEvidence, unchanged): NFKC, drop format
 * characters (zero-width, bidi), fold escaped and spaced closing tags, then fold whitespace.
 */
const foldForMatch = (s: string): string =>
  normalizeEvidence(
    s
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .replace(CLOSER_FOLD, "</$1"),
  );

const validLine = (n: number): boolean => Number.isInteger(n) && n >= 1;

/**
 * Verify findings against the real files. A finding is dropped with the FIRST failing reason,
 * checked in this order:
 *   "file outside worktree"        file is absolute, escapes via `..`, or resolves out via symlink
 *   "invalid range"                lineStart < 1, lineEnd < lineStart, or a non-integer
 *   "evidence too short"           fewer than 8 non-whitespace characters
 *   "evidence not found in file"   (1) file missing/unreadable/too large, or normalized evidence
 *                                  not in lines [lineStart-3, lineEnd+3] (normalized)
 *   "range too wide"               (2) lineEnd - lineStart > 10
 *   "outside changed lines"        (3) no line in [lineStart, lineEnd] is an added line in the diff
 *   "low confidence"               (4) confidence < minConfidence
 *   "category out of scope"        (5) only when `opts.categories` is given (runReviewer passes
 *                                  the reviewer's); `security` is always in scope (#23 findings)
 */
export async function filterEvidence(
  findings: Finding[],
  worktree: string,
  diff: DiffSummary,
  minConfidence: number,
  opts: FilterOptions = {},
): Promise<{ kept: Finding[]; dropped: Dropped[] }> {
  const kept: Finding[] = [];
  const dropped: Dropped[] = [];
  const cache = new Map<string, SafeRead>();
  for (const f of findings) {
    const reason = await firstFailure(f, worktree, diff, minConfidence, opts, cache);
    if (reason === undefined) kept.push(f);
    else dropped.push({ finding: f, reason });
  }
  return { kept, dropped };
}

async function firstFailure(
  f: Finding,
  worktree: string,
  diff: DiffSummary,
  minConfidence: number,
  opts: FilterOptions,
  cache: Map<string, SafeRead>,
): Promise<string | undefined> {
  let file = cache.get(f.file);
  if (file === undefined) {
    file = await readInsideWorktree(worktree, f.file, opts.client);
    cache.set(f.file, file);
  }
  if (file.kind === "outside") return "file outside worktree";
  if (!validLine(f.lineStart) || !validLine(f.lineEnd) || f.lineEnd < f.lineStart) {
    return "invalid range";
  }
  const needle = foldForMatch(f.evidence);
  if (needle.replace(/\s/g, "").length < MIN_EVIDENCE_CHARS) return "evidence too short";

  // (1) evidence in the window around the claimed lines.
  if (file.kind !== "ok") return "evidence not found in file";
  const lines = file.text.split(/\r?\n/);
  const from = Math.max(0, f.lineStart - 1 - CONTEXT);
  const window = foldForMatch(lines.slice(from, f.lineEnd + CONTEXT).join("\n"));
  if (!window.includes(needle)) return "evidence not found in file";

  // (2)
  if (f.lineEnd - f.lineStart > MAX_RANGE) return "range too wide";

  // (3)
  const path = posix.normalize(f.file);
  const added = diff.files.find((x) => posix.normalize(x.path) === path)?.addedLines ?? [];
  if (!added.some((n) => n >= f.lineStart && n <= f.lineEnd)) return "outside changed lines";

  // (4)
  if (!(f.confidence >= minConfidence)) return "low confidence";

  // (5)
  // `security` is always in scope: #23 injection findings must reach every reviewer's output.
  if (opts.categories && f.category !== "security" && !opts.categories.includes(f.category))
    return "category out of scope";
  return undefined;
}
