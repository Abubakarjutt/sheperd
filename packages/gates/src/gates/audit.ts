import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { z } from "zod";
import type { Gate, GateContext, GateOutput } from "../types.js";
import {
  baseFileList,
  baseText,
  checkRef,
  errMsg,
  GateExec,
  inNodeModules,
  missingBinaryOutput,
  realRootOf,
  resolveBin,
  splitZ,
} from "./shared.js";

type PM = "npm" | "pnpm" | "yarn";
const LOCKFILES: Record<string, PM> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
};
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const MANIFEST_PATHSPECS = [
  ":(glob)**/package.json",
  ...Object.keys(LOCKFILES).map((n) => `:(glob)**/${n}`),
  ":(glob,exclude)**/node_modules/**",
];
const MAX_LIST = 50;

const err = (summary: string, details: unknown = null): GateOutput => ({
  status: "error",
  summary,
  details,
});

// ---- audit output (npm and pnpm share this shape; yarn classic is NDJSON) --------------------

const Counts = z.object({ high: z.number(), critical: z.number() }).loose();
const JsonAudit = z.object({
  metadata: z.object({ vulnerabilities: Counts }).loose(),
  // npm v7+: keyed by package name
  vulnerabilities: z.record(z.string(), z.object({ severity: z.string() }).loose()).optional(),
  // pnpm / npm v6: keyed by advisory id
  advisories: z
    .record(
      z.string(),
      z.object({ severity: z.string(), module_name: z.string().optional() }).loose(),
    )
    .optional(),
});
const YarnLine = z.object({ type: z.string(), data: z.unknown() });
const YarnSummary = z.object({ vulnerabilities: Counts });
const YarnAdvisory = z.object({
  advisory: z.object({ severity: z.string(), module_name: z.string().optional() }).loose(),
});

type AuditVerdict = { high: number; critical: number; packages: string[] };
const BLOCKING = new Set(["high", "critical"]);

function parseJsonAudit(stdout: string): AuditVerdict {
  const raw: unknown = JSON.parse(stdout);
  if (typeof raw === "object" && raw !== null && "error" in raw) {
    throw new Error(
      `audit reported an error: ${JSON.stringify((raw as { error: unknown }).error).slice(0, 200)}`,
    );
  }
  const a = JsonAudit.parse(raw);
  const packages = new Set<string>();
  for (const [name, v] of Object.entries(a.vulnerabilities ?? {})) {
    if (BLOCKING.has(v.severity)) packages.add(name);
  }
  for (const v of Object.values(a.advisories ?? {})) {
    if (BLOCKING.has(v.severity) && v.module_name) packages.add(v.module_name);
  }
  return {
    high: a.metadata.vulnerabilities.high,
    critical: a.metadata.vulnerabilities.critical,
    packages: [...packages].sort(),
  };
}

function parseYarnAudit(stdout: string): AuditVerdict {
  let summary: z.infer<typeof YarnSummary> | undefined;
  const packages = new Set<string>();
  for (const line of stdout.split("\n").filter((l) => l.trim() !== "")) {
    const l = YarnLine.parse(JSON.parse(line));
    if (l.type === "error")
      throw new Error(`yarn audit error: ${JSON.stringify(l.data).slice(0, 200)}`);
    if (l.type === "auditSummary") summary = YarnSummary.parse(l.data);
    if (l.type === "auditAdvisory") {
      const adv = YarnAdvisory.parse(l.data).advisory;
      if (BLOCKING.has(adv.severity) && adv.module_name) packages.add(adv.module_name);
    }
  }
  if (!summary) throw new Error("yarn audit emitted no auditSummary");
  return {
    high: summary.vulnerabilities.high,
    critical: summary.vulnerabilities.critical,
    packages: [...packages].sort(),
  };
}

// ---- changed manifests ------------------------------------------------------------------------

async function changedManifests(ctx: GateContext, g: GateExec): Promise<string[]> {
  checkRef(ctx.baseRef);
  const diff = await g.git([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--relative",
    ctx.baseRef,
    "--",
    ...MANIFEST_PATHSPECS,
  ]);
  const others = await g.git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...MANIFEST_PATHSPECS,
  ]);
  return [...new Set([...splitZ(diff), ...splitZ(others)])].filter((p) => !inNodeModules(p)).sort();
}

// ---- dependency names -------------------------------------------------------------------------

function depNames(text: string): Set<string> {
  const j = JSON.parse(text) as Record<string, unknown>;
  const names = new Set<string>();
  for (const f of DEP_FIELDS) {
    const v = j[f];
    if (typeof v === "object" && v !== null) for (const n of Object.keys(v)) names.add(n);
  }
  return names;
}

// ---- lockfile parsing -------------------------------------------------------------------------

type LockInfo = {
  kind: PM;
  /** Names the lock lists for the project at `dir` (relative to the lock's dir; "" = same dir). */
  projectDeps(dir: string): Set<string>;
  /** Loose: is `name` anywhere in the lockfile (used for peerDependencies). */
  has(name: string): boolean;
};

const KEY_RE = /^(?:'([^']+)'|"([^"]+)"|([^:\s'"]+)):/;
const keyOf = (s: string): string | undefined => {
  const m = KEY_RE.exec(s);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};
const PNPM_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

/** pnpm-lock.yaml importers (v6+/v9) or top-level sections (single-project v5). Line based. */
function parsePnpm(text: string): LockInfo {
  const importers = new Map<string, Set<string>>();
  const add = (proj: string, name: string) => {
    const s = importers.get(proj) ?? new Set<string>();
    importers.set(proj, s);
    s.add(name);
  };
  let mode: "none" | "importers" | "root" = "none";
  let proj = "";
  let inSection = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    if (indent === 0) {
      const k = keyOf(body);
      mode = k === "importers" ? "importers" : k && PNPM_SECTIONS.has(k) ? "root" : "none";
      if (mode === "root") {
        proj = ".";
        inSection = !/\{\s*\}\s*$/.test(body);
      }
      continue;
    }
    if (mode === "importers") {
      if (indent === 2) {
        proj = keyOf(body) ?? "";
        importers.set(proj, importers.get(proj) ?? new Set());
        inSection = false;
      } else if (indent === 4) {
        const k = keyOf(body);
        inSection = k !== undefined && PNPM_SECTIONS.has(k) && !/\{\s*\}\s*$/.test(body);
      } else if (indent === 6 && inSection) {
        const n = keyOf(body);
        if (n) add(proj, n);
      }
    } else if (mode === "root" && indent === 2 && inSection) {
      const n = keyOf(body);
      if (n) add(".", n);
    }
  }
  return {
    kind: "pnpm",
    projectDeps: (dir) => importers.get(dir === "" ? "." : dir) ?? new Set(),
    has: (name) =>
      [...importers.values()].some((s) => s.has(name)) ||
      new RegExp(`(^|[\\s'"/])${escapeRe(name)}@`, "m").test(text),
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseNpmLock(text: string): LockInfo {
  const j = JSON.parse(text) as {
    packages?: Record<string, Record<string, unknown>>;
    dependencies?: Record<string, unknown>;
  };
  return {
    kind: "npm",
    projectDeps(dir) {
      if (j.packages) {
        const entry = j.packages[dir];
        const names = new Set<string>();
        for (const f of DEP_FIELDS) {
          const v = entry?.[f];
          if (typeof v === "object" && v !== null) for (const n of Object.keys(v)) names.add(n);
        }
        return names;
      }
      // lockfileVersion 1 has no per-project entries: only the root project is covered.
      return dir === "" ? new Set(Object.keys(j.dependencies ?? {})) : new Set();
    },
    has(name) {
      if (j.packages) {
        return Object.keys(j.packages).some(
          (k) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`),
        );
      }
      return name in (j.dependencies ?? {});
    },
  };
}

/** yarn.lock (classic and berry): entry headers only; per-project listing is not available. */
function parseYarn(text: string): LockInfo {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith(" ") || !line.endsWith(":"))
      continue;
    for (const spec of line.slice(0, -1).split(",")) {
      const s = spec.trim().replace(/^["']|["']$/g, "");
      const at = s.indexOf("@", 1);
      if (at > 0) names.add(s.slice(0, at));
    }
  }
  return { kind: "yarn", projectDeps: () => names, has: (n) => names.has(n) };
}

async function readLock(
  worktreeRoot: string,
  pm: PM,
  dir: string,
): Promise<{ path: string; info: LockInfo } | undefined> {
  // nearest ancestor-or-self directory holding a lockfile; the pack's package manager wins ties
  for (let d = dir; ; d = posix.dirname(d)) {
    const here = d === "." ? "" : d;
    const found: { name: string; kind: PM }[] = [];
    for (const [name, kind] of Object.entries(LOCKFILES)) {
      try {
        await access(join(worktreeRoot, here, name));
        found.push({ name, kind });
      } catch {
        // absent
      }
    }
    const pick = found.find((f) => f.kind === pm) ?? found[0];
    if (pick) {
      const path = join(worktreeRoot, here, pick.name);
      const text = await readFile(path, "utf8");
      const info =
        pick.kind === "pnpm"
          ? parsePnpm(text)
          : pick.kind === "npm"
            ? parseNpmLock(text)
            : parseYarn(text);
      return { path: posix.join(here, pick.name), info };
    }
    if (here === "") return undefined;
  }
}

type Missing = { manifest: string; dependency: string; reason: string };

/** Dependencies added to a package.json since baseRef that the lockfile does not list. */
async function missingFromLockfile(
  ctx: GateContext,
  g: GateExec,
  manifests: string[],
): Promise<Missing[]> {
  const root = await realRootOf(ctx);
  const baseFiles = new Set(await baseFileList(ctx, g));
  const out: Missing[] = [];
  for (const m of manifests.filter((p) => basename(p) === "package.json")) {
    let now: Set<string>;
    try {
      now = depNames(await readFile(join(root, m), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted
      throw new Error(`cannot parse ${m}: ${errMsg(e)}`);
    }
    let before = new Set<string>();
    if (baseFiles.has(m)) {
      try {
        before = depNames(await baseText(ctx, g, m));
      } catch {
        before = new Set(); // unparseable at base: everything counts as added
      }
    }
    const added = [...now].filter((n) => !before.has(n)).sort();
    if (added.length === 0) continue;
    const dir = dirname(m) === "." ? "" : dirname(m);
    const lock = await readLock(root, ctx.pack.packageManager, dir);
    if (!lock) {
      for (const n of added) out.push({ manifest: m, dependency: n, reason: "no lockfile" });
      continue;
    }
    const lockDir = dirname(lock.path) === "." ? "" : dirname(lock.path);
    const rel = posix.relative(lockDir, dir);
    const locked = lock.info.projectDeps(rel);
    const peers = peerNames(await readFile(join(root, m), "utf8"));
    for (const n of added) {
      const ok = locked.has(n) || (peers.has(n) && lock.info.has(n));
      if (!ok) out.push({ manifest: m, dependency: n, reason: `not in ${lock.path}` });
    }
  }
  return out;
}

function peerNames(text: string): Set<string> {
  const j = JSON.parse(text) as { peerDependencies?: Record<string, unknown> };
  return new Set(Object.keys(j.peerDependencies ?? {}));
}

/**
 * Dependency audit.
 *
 * Runs only when a package.json or lockfile (nested included) differs from baseRef. Two checks:
 * (1) every dependency name added to a package.json (any of dependencies, devDependencies,
 * optionalDependencies, peerDependencies) must be listed in the covering lockfile, which
 * catches hallucinated or never-installed packages; the check is by name (npm/pnpm look at the
 * project's own entry, yarn at all entry headers; the declared version range is not compared);
 * (2) `<pm> audit --json` through the registry client fails on any high or critical advisory.
 * npm and pnpm JSON are parsed with one zod schema; yarn classic NDJSON is supported; yarn berry
 * (`yarn npm audit`) is not, and `yarn audit` failing there is an error. Registry or parse
 * trouble is `error`, never `pass` (#22). This is the only gate with `network: "registry"`.
 */
export const auditGate: Gate = {
  name: "audit",
  category: "security",
  async run(ctx) {
    const g = new GateExec(ctx);
    let manifests: string[];
    try {
      manifests = await changedManifests(ctx, g);
    } catch (e) {
      return err(`cannot list manifest changes against ${ctx.baseRef}: ${errMsg(e)}`);
    }
    if (manifests.length === 0) {
      return {
        status: "pass",
        summary: "no dependency changes",
        details: { network: "registry", audited: false },
      };
    }
    const base = { network: "registry", packageManager: ctx.pack.packageManager, manifests };
    if (!ctx.registryClient) {
      return err("registry client required for dependency audit", base);
    }

    let missing: Missing[];
    try {
      missing = await missingFromLockfile(ctx, g, manifests);
    } catch (e) {
      return err(`cannot check dependencies against the lockfile: ${errMsg(e)}`, base);
    }

    let pmBin: string;
    try {
      pmBin = resolveBin(ctx.pack.packageManager);
    } catch (e) {
      return missingBinaryOutput(e, ctx.pack.packageManager) ?? err(errMsg(e), base);
    }
    let verdict: AuditVerdict;
    try {
      const r = await g.exec([pmBin, "audit", "--json"], ctx.registryClient);
      if (r.timedOut) return err(`${ctx.pack.packageManager} audit timed out`, base);
      try {
        verdict =
          ctx.pack.packageManager === "yarn" ? parseYarnAudit(r.stdout) : parseJsonAudit(r.stdout);
      } catch (e) {
        return err(
          `${ctx.pack.packageManager} audit output unusable (exit ${r.exitCode}): ${errMsg(e).slice(0, 200)}`,
          { ...base, stderr: r.stderr.trim().slice(0, 300) },
        );
      }
    } catch (e) {
      return (
        missingBinaryOutput(e, ctx.pack.packageManager) ??
        err(`audit failed to run: ${errMsg(e)}`, base)
      );
    }

    const details = {
      ...base,
      missingFromLockfile: missing.slice(0, MAX_LIST),
      vulnerabilities: { high: verdict.high, critical: verdict.critical },
      packages: verdict.packages.slice(0, MAX_LIST),
    };
    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(
        `${missing.length} dependency(ies) missing from the lockfile: ${missing
          .slice(0, 5)
          .map((m) => m.dependency)
          .join(", ")}`,
      );
    }
    if (verdict.high + verdict.critical > 0) {
      problems.push(`${verdict.high} high and ${verdict.critical} critical advisory(ies)`);
    }
    if (problems.length > 0) {
      return { status: "fail", summary: `audit: ${problems.join("; ")}`, details };
    }
    return { status: "pass", summary: "audit clean", details };
  },
};
