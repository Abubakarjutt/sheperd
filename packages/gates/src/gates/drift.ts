import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
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

const PKG_KEYS = ["scripts", "jest", "vitest"] as const;

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
 * into a symlink), plus the `scripts`, `jest` and `vitest` keys of package.json.
 */
export async function configDrift(ctx: GateContext, g: GateExec): Promise<ConfigDrift[]> {
  const base = new Set(await baseFileList(ctx, g));
  const cur = splitZ(
    await g.git(["ls-files", "--cached", "--others", "-z", "--", ...CONFIG_PATHSPECS]),
  ).filter((p) => !inNodeModules(p) && isConfigFile(p));
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
  if (base.has("package.json")) {
    const was = pkgSlice(await baseText(ctx, g, "package.json"));
    let now: string | undefined;
    let missing = false;
    try {
      now = pkgSlice(await readFile(join(ctx.worktree, "package.json"), "utf8"));
    } catch {
      missing = true;
    }
    if (missing) out.push({ path: "package.json", change: "deleted" });
    else if (now !== was) out.push({ path: "package.json", change: "scripts/jest/vitest differ" });
  }
  return out;
}
