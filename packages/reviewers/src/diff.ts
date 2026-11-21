import { type GateContext, GateExec } from "@rewire/gates";
import type { SandboxClient } from "@rewire/sandbox";
import { readInsideWorktree } from "./evidence.js";

export type DiffSummary = {
  files: { path: string; addedLines: number[] }[];
  patch: string;
  /** True when `patch` was cut at PATCH_CAP characters (added lines still cover the whole diff). */
  truncated: boolean;
  /** Files whose content is not in `patch` or not reviewable (binary, too large, unreadable). */
  omitted: string[];
  /**
   * Mandatory findings decided by code, never left to the model: a NUL byte in an added line, or
   * a changed `.gitattributes`. runReviewer turns each into a kept `security` finding.
   */
  forced: ForcedFinding[];
};

export type ForcedFinding = {
  file: string;
  lineStart: number;
  lineEnd: number;
  evidence: string;
  failureScenario: string;
};

export const NUL_EVIDENCE = "NUL byte in added line";

export const PATCH_CAP = 400_000;
const GIT_TIMEOUT_MS = 60_000;

/** Same guard as gates' checkRef (not exported there): a ref can never be read as an option. */
function checkRef(ref: string): void {
  if (ref === "" || ref.startsWith("-")) throw new Error(`invalid baseRef: ${ref}`);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Decode a git C-quoted name (`"..."` with \\a \\b \\t \\n \\v \\f \\r \\" \\\\ and octal bytes). */
export function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw.replace(/\t.*$/, "");
  const bytes: number[] = [];
  const esc: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  let i = 1;
  for (; i < raw.length; i++) {
    const c = String.fromCodePoint(raw.codePointAt(i) as number);
    if (c === '"') break;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      i += c.length - 1; // astral characters take two UTF-16 units
      continue;
    }
    const n = raw[++i] ?? "";
    const oct = /^[0-7]{1,3}/.exec(raw.slice(i, i + 3))?.[0];
    if (oct !== undefined) {
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += oct.length - 1;
    } else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse `git diff -U0` into per-file added line numbers (new-file numbering). */
export function parseDiff(
  patch: string,
): { path: string; addedLines: number[]; nulLine?: number }[] {
  const out = new Map<string, number[]>();
  const nul = new Map<string, number>();
  let currentPath = "";
  let current: number[] | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let nextNew = 0;
  let oldPath = "";
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: every line is content, even one that looks like a header.
      if (line.startsWith("+")) {
        newLeft--;
        if (line.includes("\0") && !nul.has(currentPath)) nul.set(currentPath, nextNew);
        current?.push(nextNew++);
      } else if (line.startsWith("-")) oldLeft--;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPath = "";
    } else if (line.startsWith("--- ")) {
      const p = unquote(line.slice(4));
      oldPath = p === "/dev/null" ? "" : p.replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      const path = p === "/dev/null" ? oldPath : p.replace(/^b\//, "");
      if (path !== "") {
        currentPath = path;
        current = out.get(path) ?? [];
        out.set(path, current);
      }
    } else {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
        nextNew = Number(m[3]);
      }
    }
  }
  return [...out].map(([path, addedLines]) => {
    const nulLine = nul.get(path);
    return nulLine === undefined ? { path, addedLines } : { path, addedLines, nulLine };
  });
}

function untrackedPatch(path: string, text: string): { patch: string; added: number[] } {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const head = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`;
  const hunk =
    lines.length === 0
      ? ""
      : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l.replace(/\0/g, "")}`).join("\n")}\n`;
  return { patch: head + hunk, added: lines.map((_, i) => i + 1) };
}

/**
 * Collect the changes since `baseRef`: `git diff -U0` (tracked files, working tree vs baseRef)
 * plus untracked, non-ignored files with every line counted as added. git runs through the
 * pinned git inside the given (review) sandbox client.
 */
export async function buildDiffSummary(
  worktree: string,
  baseRef: string,
  opts: { client: SandboxClient; signal?: AbortSignal },
): Promise<DiffSummary> {
  checkRef(baseRef);
  const ctx = {
    worktree,
    client: opts.client,
    deadline: Date.now() + GIT_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as unknown as GateContext;
  const g = new GateExec(ctx);
  // Attributes come from the trusted base tree, never the worktree (--attr-source, git >= 2.40);
  // GIT_ATTR_SOURCE needs the same version, so an older git cannot be supported at all.
  const attr = [
    `--attr-source=${baseRef}`,
    "-c",
    "core.quotepath=off",
    "-c",
    "core.attributesFile=/dev/null",
  ];
  try {
    await g.git([`--attr-source=${baseRef}`, "rev-parse", "--git-dir"]);
  } catch (e) {
    throw new Error(`git with --attr-source (>= 2.40) is required: ${(e as Error).message}`);
  }
  const raw = await g.git([
    ...attr,
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    // Never let attributes (`-diff`, `binary`, encodings) hide text changes: force text.
    "--text",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseRef,
    "--",
  ]);
  const changedNames = (
    await g.git([...attr, "diff", "--name-only", "-z", "--no-renames", baseRef, "--"])
  )
    .split("\0")
    .filter((p) => p !== "");
  const parsed = parseDiff(raw);
  const tracked = raw.replace(/\0/g, "");
  const others = (await g.git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(
      (p) => p !== "" && !p.split("/").includes("node_modules") && !p.split("/").includes(".git"),
    );

  const omitted: string[] = [];
  const forced: ForcedFinding[] = [];
  const files: DiffSummary["files"] = [];
  const nulFinding = (file: string, line: number): void => {
    omitted.push(`${file} (NUL byte in added line)`);
    forced.push({
      file,
      lineStart: line,
      lineEnd: line,
      evidence: NUL_EVIDENCE,
      failureScenario:
        "A NUL byte in added text can hide or truncate content from text tools and reviewers; the file's real content may differ from what was reviewed.",
    });
  };
  for (const f of parsed) {
    files.push({ path: f.path, addedLines: f.addedLines });
    if (f.nulLine !== undefined) nulFinding(f.path, f.nulLine);
  }
  // A changed path with no parsed hunks (empty file, mode change, unparsed name) is never dropped.
  const seen = new Set(files.map((f) => f.path));
  for (const p of changedNames) {
    if (seen.has(p)) continue;
    files.push({ path: p, addedLines: [] });
    omitted.push(`${p} (no textual diff)`);
  }
  let patch = tracked;
  for (const path of others.sort()) {
    let r: Awaited<ReturnType<typeof readInsideWorktree>>;
    try {
      r = await readInsideWorktree(worktree, path, opts.client);
    } catch (e) {
      const c = (e as { code?: string }).code;
      if (c !== "EACCES" && c !== "EPERM") throw e;
      files.push({ path, addedLines: [] });
      omitted.push(`${path} (unreadable)`);
      patch += `Untracked file ${path} unreadable\n`;
      continue;
    }
    if (r.kind === "ok") {
      const u = untrackedPatch(path, r.text);
      files.push({ path, addedLines: u.added });
      patch += u.patch;
      const at = r.text.split("\n").findIndex((l) => l.includes("\0"));
      if (at >= 0) nulFinding(path, at + 1);
    } else {
      files.push({ path, addedLines: [] });
      const why = r.kind === "too_large" ? "too large" : r.kind;
      omitted.push(`${path} (${why})`);
      patch += `Untracked file ${path} not included: ${why}\n`;
    }
  }
  for (const p of new Set([...files.map((f) => f.path), ...changedNames, ...others])) {
    if (p.split("/").pop() === ".gitattributes") {
      omitted.push(".gitattributes changed (protected)");
      forced.push({
        file: p,
        lineStart: 1,
        lineEnd: 1,
        evidence: ".gitattributes changed",
        failureScenario:
          "A changed .gitattributes can alter how git diffs or checks out files and hide changes from review; it is protected and must not be modified by the implementer.",
      });
    }
  }
  let truncated = false;
  if (patch.length > PATCH_CAP) {
    truncated = true;
    let cut = patch.slice(0, PATCH_CAP);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    patch = `${cut}\n[patch truncated at ${PATCH_CAP} characters]\n`;
  }
  return { files, patch, truncated, omitted, forced };
}
