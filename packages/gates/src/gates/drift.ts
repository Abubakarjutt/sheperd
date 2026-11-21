import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GateContext } from "../types.js";
import {
  baseFileList,
  baseText,
  CONFIG_PATHSPECS,
  type GateExec,
  inNodeModules,
  isConfigFile,
  splitZ,
} from "./shared.js";

export type ConfigDrift = { path: string; change: string };

const PKG_KEYS = [
  "scripts",
  "jest",
  "vitest",
  "eslintConfig",
  "eslintIgnore",
  "babel",
  "prettier",
] as const;
const isPkg = (p: string): boolean => basename(p) === "package.json" && !inNodeModules(p);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function pkgSlice(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return stable(Object.fromEntries(PKG_KEYS.map((k) => [k, j[k] ?? null])));
  } catch {
    return undefined;
  }
}

/**
 * Runner/lint/compiler config that differs from baseRef (added, modified, deleted or turned
 * into a symlink), plus the runner/lint keys of every package.json in the repo.
 */
export async function configDrift(ctx: GateContext, g: GateExec): Promise<ConfigDrift[]> {
  const base = new Set(await baseFileList(ctx, g));
  const allCur = splitZ(
    await g.git(["ls-files", "--cached", "--others", "-z", "--", ...CONFIG_PATHSPECS]),
  ).filter((p) => !inNodeModules(p));
  const cur = allCur.filter(isConfigFile);
  const paths = new Set([...[...base].filter(isConfigFile), ...cur]);
  const out: ConfigDrift[] = [];
  for (const p of [...paths].sort()) {
    const abs = join(ctx.worktree, p);
    let st: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      st = await lstat(abs);
    } catch {
      st = undefined;
    }
    if (!base.has(p)) {
      if (st) out.push({ path: p, change: "added" });
      continue;
    }
    if (!st) {
      out.push({ path: p, change: "deleted" });
      continue;
    }
    if (st.isSymbolicLink()) {
      out.push({ path: p, change: "symlink" });
      continue;
    }
    if ((await readFile(abs, "utf8")) !== (await baseText(ctx, g, p))) {
      out.push({ path: p, change: "modified" });
    }
  }
  const pkgs = new Set([...[...base].filter(isPkg), ...allCur.filter(isPkg)]);
  for (const p of [...pkgs].sort()) {
    let now: string | undefined;
    let present = true;
    try {
      now = pkgSlice(await readFile(join(ctx.worktree, p), "utf8"));
    } catch {
      present = false;
    }
    if (!base.has(p)) {
      if (present) out.push({ path: p, change: "added" });
    } else if (!present) {
      out.push({ path: p, change: "deleted" });
    } else if (now !== pkgSlice(await baseText(ctx, g, p))) {
      out.push({ path: p, change: "runner/lint keys differ" });
    }
  }
  return out;
}
