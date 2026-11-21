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
};

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
    const c = raw[i] as string;
    if (c === '"') break;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
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
): { path: string; addedLines: number[]; binary: boolean }[] {
  const out = new Map<string, number[]>();
  const binary = new Set<string>();
  let currentPath = "";
  let current: number[] | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let nextNew = 0;
  let oldPath = "";
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: every line is content, even one that looks like a header.
      if (line.includes("\0")) binary.add(currentPath);
      if (line.startsWith("+")) {
        newLeft--;
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
  return [...out].map(([path, added]) => {
    const isBinary = binary.has(path);
    return { path, addedLines: isBinary ? [] : added, binary: isBinary };
  });
}

function untrackedPatch(path: string, text: string): { patch: string; added: number[] } {
  if (text.includes("\0")) return { patch: `Binary file ${path} (untracked)\n`, added: [] };
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const head = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n`;
  const hunk =
    lines.length === 0
      ? ""
      : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
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
  const raw = await g.git([
    "-c",
    "core.quotepath=off",
    "-c",
    "core.attributesFile=/dev/null",
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    // A tracked .gitattributes (`* -diff`, `binary`) must not hide text changes: force text.
    "--text",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseRef,
    "--",
  ]);
  const parsed = parseDiff(raw);
  const tracked = raw.replace(/\0/g, "");
  const others = (await g.git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(
      (p) => p !== "" && !p.split("/").includes("node_modules") && !p.split("/").includes(".git"),
    );

  const omitted: string[] = [];
  const files: DiffSummary["files"] = [];
  for (const f of parsed) {
    files.push({ path: f.path, addedLines: f.addedLines });
    if (f.binary) omitted.push(`${f.path} (binary)`);
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
      if (r.text.includes("\0")) omitted.push(`${path} (binary)`);
    } else if (r.kind === "too_large") {
      files.push({ path, addedLines: [] });
      omitted.push(`${path} (too large)`);
      patch += `Untracked file ${path} too large to include\n`;
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
  return { files, patch, truncated, omitted };
}
