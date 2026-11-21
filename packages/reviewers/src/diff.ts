import { type GateContext, GateExec } from "@rewire/gates";
import type { SandboxClient } from "@rewire/sandbox";
import { readInsideWorktree } from "./evidence.js";

export type DiffSummary = {
  files: { path: string; addedLines: number[] }[];
  patch: string;
  /** True when `patch` was cut at PATCH_CAP characters (added lines still cover the whole diff). */
  truncated: boolean;
};

export const PATCH_CAP = 400_000;
const GIT_TIMEOUT_MS = 60_000;

/** Same guard as gates' checkRef (not exported there): a ref can never be read as an option. */
function checkRef(ref: string): void {
  if (ref === "" || ref.startsWith("-")) throw new Error(`invalid baseRef: ${ref}`);
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(p: string): string {
  if (!p.startsWith('"')) return p.replace(/\t.*$/, "");
  try {
    return JSON.parse(p.replace(/\t.*$/, "")) as string;
  } catch {
    return p;
  }
}

/** Parse `git diff -U0` into per-file added line numbers (new-file numbering). */
export function parseDiff(patch: string): { path: string; addedLines: number[] }[] {
  const out = new Map<string, number[]>();
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
        current = out.get(path) ?? [];
        out.set(path, current);
      }
    } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      const m = /^Binary files (?:.+) and (.+) differ$/.exec(line);
      const p = m?.[1] === undefined ? "" : unquote(m[1]);
      const path = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      if (path !== "" && !out.has(path)) out.set(path, []);
    } else {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
        nextNew = Number(m[3]);
      }
    }
  }
  return [...out].map(([path, addedLines]) => ({ path, addedLines }));
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
  const tracked = await g.git([
    "-c",
    "core.quotepath=off",
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    baseRef,
    "--",
  ]);
  const others = (await g.git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p !== "" && !p.split("/").includes("node_modules") && !p.startsWith(".git/"));

  const files = parseDiff(tracked);
  let patch = tracked;
  for (const path of others.sort()) {
    const r = await readInsideWorktree(worktree, path, opts.client);
    if (r.kind === "ok") {
      const u = untrackedPatch(path, r.text);
      files.push({ path, addedLines: u.added });
      patch += u.patch;
    } else if (r.kind === "too_large") {
      files.push({ path, addedLines: [] });
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
  return { files, patch, truncated };
}
