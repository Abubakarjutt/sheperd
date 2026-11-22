import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { z } from "zod";
import type { Gate, GateContext, GateOutput } from "../types.js";
import {
  baseFileList,
  baseText,
  checkRef,
  ENV_BIN,
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

const NET = "registry";
const REGISTRY = "https://registry.npmjs.org/";
const err = (summary: string, details: Record<string, unknown> = {}): GateOutput => ({
  status: "error",
  summary,
  details: { network: NET, ...details },
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
      new RegExp(`^ {2}['"]?/?${escapeRe(name)}[@/]`, "m").test(text),
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

const dirOf = (p: string): string => (dirname(p) === "." ? "" : dirname(p));

type BaseLock = { path: string; info: LockInfo };

/**
 * The lockfile covering `dir` AS IT WAS AT baseRef (nearest ancestor-or-self directory that had
 * one; the pack's package manager wins ties). Never read from the worktree: lockfiles are
 * protected, and a rewritten one must not vouch for itself.
 */
async function baseLockFor(
  ctx: GateContext,
  g: GateExec,
  baseFiles: Set<string>,
  dir: string,
  cache: Map<string, BaseLock> = new Map(),
): Promise<(BaseLock & { dir: string }) | undefined> {
  for (let d = dir; ; d = dirOf(d)) {
    const found = Object.entries(LOCKFILES)
      .map(([name, kind]) => ({ path: d === "" ? name : `${d}/${name}`, kind }))
      .filter((f) => baseFiles.has(f.path));
    const pick = found.find((f) => f.kind === ctx.pack.packageManager) ?? found[0];
    if (pick) {
      let hit = cache.get(pick.path);
      if (!hit) {
        const text = await baseText(ctx, g, pick.path);
        const info =
          pick.kind === "pnpm"
            ? parsePnpm(text)
            : pick.kind === "npm"
              ? parseNpmLock(text)
              : parseYarn(text);
        hit = { path: pick.path, info };
        cache.set(pick.path, hit);
      }
      return { ...hit, dir: d };
    }
    if (d === "") return undefined;
  }
}

type Missing = { manifest: string; dependency: string; reason: string };

function peerNames(text: string): Set<string> {
  const j = JSON.parse(text) as { peerDependencies?: Record<string, unknown> };
  return new Set(Object.keys(j.peerDependencies ?? {}));
}

/**
 * `packageManager` / `devEngines` make npm, pnpm and corepack download and run another package
 * manager version: drop them from the isolated copy so only the pinned binary runs.
 */
function stripPmFields(text: string): string {
  // fail closed: an unparseable manifest is never copied verbatim (the caller reports an error)
  const j = JSON.parse(text) as Record<string, unknown>;
  delete j.packageManager;
  delete j.devEngines;
  return JSON.stringify(j);
}

/** A worktree manifest's text, or undefined only when it does not exist (ENOENT/ENOTDIR). */
async function readWorktreeManifest(abs: string): Promise<string | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${abs} is not a regular file`);
  return readFile(abs, "utf8");
}

/** Corepack shims download and run whatever `packageManager` names: refuse them. */
async function isCorepackShim(bin: string): Promise<boolean> {
  if (/corepack/i.test(bin)) return true;
  const real = await realpath(bin);
  if (/corepack/i.test(real)) return true;
  const st = await stat(real);
  if (st.size > 0 && st.size < 8192) {
    return /corepack/i.test(await readFile(real, "utf8").catch(() => ""));
  }
  return false;
}

const COREPACK_HINT = "install a real pnpm/yarn binary; corepack shims are refused";

type GroupResult = { dir: string; lockfile: string; verdict?: AuditVerdict; error?: string };

/**
 * Audit one project (a lockfile directory) in an isolated scratch copy. The package manager
 * runs with the network but must never execute worktree code or read worktree config, so the
 * copy holds only package.json files, the baseRef lockfile and pnpm-workspace.yaml; no .npmrc,
 * .pnpmfile.* or .yarn/. exec cannot set env or a cwd outside the worktree, so the command runs
 * via /usr/bin/env with every state dir in scratch and the project selected with --prefix/-C/--cwd.
 */
async function auditGroup(
  ctx: GateContext,
  g: GateExec,
  client: NonNullable<GateContext["registryClient"]>,
  pmBin: string,
  baseFiles: Set<string>,
  lock: BaseLock & { dir: string },
  manifestDirs: string[],
  root: string,
): Promise<GroupResult> {
  const pm = ctx.pack.packageManager;
  const work = await realpath(await mkdtemp(join(ctx.scratch, "audit-")));
  const res: GroupResult = { dir: lock.dir, lockfile: lock.path };
  try {
    const proj = join(work, "proj");
    const target = lock.dir === "" ? proj : join(proj, lock.dir);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, basename(lock.path)), await baseText(ctx, g, lock.path), {
      mode: 0o600,
    });
    const wsPath = lock.dir === "" ? "pnpm-workspace.yaml" : `${lock.dir}/pnpm-workspace.yaml`;
    if (baseFiles.has(wsPath)) {
      await writeFile(join(proj, wsPath), await baseText(ctx, g, wsPath), { mode: 0o600 });
    }
    for (const d of manifestDirs) {
      const rel = d === "" ? "package.json" : `${d}/package.json`;
      const dest = join(proj, rel);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      // Only a manifest that is ABSENT from the worktree falls back to baseRef. Any other read
      // problem, a non-regular file or unparseable JSON (stripPmFields throws) propagates, and
      // the gate reports `error` (fail closed): the baseRef copy is never audited in its place.
      const text = await readWorktreeManifest(join(root, rel));
      if (text !== undefined) {
        await writeFile(dest, stripPmFields(text), { mode: 0o600 });
      } else if (baseFiles.has(rel)) {
        await writeFile(dest, stripPmFields(await baseText(ctx, g, rel)), { mode: 0o600 });
      }
    }
    const home = join(work, "home");
    const sub = ["", ".config", ".cache", ".local/share", ".local/state", "tmp", "store"];
    for (const d of sub) await mkdir(join(home, d), { recursive: true, mode: 0o700 });
    const rc = join(home, "empty-user-npmrc");
    const grc = join(home, "empty-global-npmrc");
    await writeFile(rc, "", { mode: 0o600 });
    await writeFile(grc, "", { mode: 0o600 });
    const env = [
      `HOME=${home}`,
      `XDG_CONFIG_HOME=${join(home, ".config")}`,
      `XDG_CACHE_HOME=${join(home, ".cache")}`,
      `XDG_DATA_HOME=${join(home, ".local/share")}`,
      `XDG_STATE_HOME=${join(home, ".local/state")}`,
      `TMPDIR=${join(home, "tmp")}`,
      `npm_config_cache=${join(home, ".cache", "npm")}`,
      `npm_config_userconfig=${rc}`,
      `npm_config_globalconfig=${grc}`,
      `npm_config_store_dir=${join(home, "store")}`,
      `npm_config_state_dir=${join(home, ".local/state")}`,
      `npm_config_cache_dir=${join(home, ".cache", "pnpm")}`,
      `PNPM_HOME=${join(home, ".local/share/pnpm")}`,
      `YARN_CACHE_FOLDER=${join(home, ".cache", "yarn")}`,
      `COREPACK_HOME=${join(home, ".cache", "corepack")}`,
      "COREPACK_ENABLE_NETWORK=0",
      "COREPACK_ENABLE_STRICT=0",
      "npm_config_ignore_scripts=true",
      "npm_config_manage_package_manager_versions=false",
      "YARN_IGNORE_SCRIPTS=true",
      `npm_config_registry=${REGISTRY}`,
      `YARN_REGISTRY=${REGISTRY}`,
    ];
    const cmd =
      pm === "npm"
        ? [pmBin, "--prefix", target, "audit", "--json"]
        : pm === "pnpm"
          ? [pmBin, "-C", target, "audit", "--json", "--ignore-pnpmfile"]
          : [pmBin, "--cwd", target, "audit", "--json"];
    const r = await g.exec([ENV_BIN, ...env, ...cmd], client);
    if (r.timedOut) {
      res.error = `${pm} audit timed out`;
      return res;
    }
    try {
      res.verdict = pm === "yarn" ? parseYarnAudit(r.stdout) : parseJsonAudit(r.stdout);
    } catch (e) {
      res.error = `${pm} audit output unusable (exit ${r.exitCode}): ${errMsg(e).slice(0, 200)}; stderr: ${r.stderr.trim().slice(0, 300)}`;
    }
    return res;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Dependency audit.
 *
 * Runs only when a package.json or lockfile (nested included) differs from baseRef. Checks:
 * (1) lockfiles are protected: any lockfile added, modified or deleted versus baseRef fails;
 * (2) every dependency name added to a package.json (dependencies, devDependencies,
 * optionalDependencies, peerDependencies) must be listed in the covering lockfile AS OF
 * baseRef, which catches hallucinated or never-installed packages. By name only: the declared
 * range is not compared (npm/pnpm look at the project's own entry, yarn at all entry headers);
 * (3) `<pm> audit --json` through the registry client, once per distinct covering-lockfile
 * directory with a changed manifest, in an isolated scratch copy (see auditGroup), fails on any
 * high or critical advisory. npm and pnpm JSON share one zod schema; yarn classic NDJSON is
 * supported; yarn berry (`yarn npm audit`) is not and gives `error`. Corepack shims are refused.
 * Registry or parse trouble is `error`, never `pass` (#22). The registry is fixed to
 * registry.npmjs.org (a user override belongs in rewire policy later). This is the only gate
 * with `network: "registry"`.
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
        details: { network: NET, audited: false },
      };
    }
    const base = { packageManager: ctx.pack.packageManager, manifests };
    if (!ctx.registryClient) {
      return err("registry client required for dependency audit", base);
    }
    const client = ctx.registryClient;

    const lockfileChanged = manifests.filter((m) => basename(m) in LOCKFILES);
    const missing: Missing[] = [];
    const groups = new Map<string, { lock: BaseLock & { dir: string }; dirs: Set<string> }>();
    let root: string;
    let baseFiles: Set<string>;
    try {
      root = await realRootOf(ctx);
      baseFiles = new Set(await baseFileList(ctx, g));
      const lockCache = new Map<string, BaseLock>();
      const notePkgDir = async (dir: string): Promise<(BaseLock & { dir: string }) | undefined> =>
        baseLockFor(ctx, g, baseFiles, dir, lockCache);
      const touch = async (dir: string, memberDir?: string) => {
        const lock = await notePkgDir(dir);
        if (!lock) return undefined;
        const grp = groups.get(lock.dir) ?? { lock, dirs: new Set<string>() };
        groups.set(lock.dir, grp);
        if (memberDir !== undefined) grp.dirs.add(memberDir);
        return lock;
      };
      for (const m of manifests.filter((p) => basename(p) === "package.json")) {
        let curText: string;
        try {
          curText = await readFile(join(root, m), "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted
          throw e;
        }
        const now = depNames(curText);
        let before = new Set<string>();
        if (baseFiles.has(m)) {
          try {
            before = depNames(await baseText(ctx, g, m));
          } catch {
            before = new Set();
          }
        }
        const added = [...now].filter((n) => !before.has(n)).sort();
        const lock = await touch(dirOf(m), dirOf(m));
        if (added.length === 0) continue;
        if (!lock) {
          for (const n of added) {
            missing.push({ manifest: m, dependency: n, reason: `no lockfile at ${ctx.baseRef}` });
          }
          continue;
        }
        const locked = lock.info.projectDeps(posix.relative(lock.dir, dirOf(m)));
        const peers = peerNames(curText);
        for (const n of added) {
          if (!(locked.has(n) || (peers.has(n) && lock.info.has(n)))) {
            missing.push({ manifest: m, dependency: n, reason: `not in ${lock.path} at baseRef` });
          }
        }
      }
      for (const l of lockfileChanged) await touch(dirOf(l));
      // workspace members and sibling manifests of every audited project are copied too
      for (const f of baseFiles) {
        if (basename(f) !== "package.json" || inNodeModules(f)) continue;
        const lock = await notePkgDir(dirOf(f));
        const grp = lock ? groups.get(lock.dir) : undefined;
        if (grp) grp.dirs.add(dirOf(f));
      }
    } catch (e) {
      return err(`cannot check dependencies against the lockfile: ${errMsg(e)}`, base);
    }

    const problems: string[] = [];
    if (lockfileChanged.length > 0)
      problems.push(`lockfile changed (protected): ${lockfileChanged.slice(0, 5).join(", ")}`);
    if (missing.length > 0) {
      problems.push(
        `${missing.length} dependency(ies) missing from the lockfile: ${missing
          .slice(0, 5)
          .map((m) => m.dependency)
          .join(", ")}`,
      );
    }

    const results: GroupResult[] = [];
    if (groups.size > 0) {
      let pmBin: string;
      try {
        pmBin = resolveBin(ctx.pack.packageManager);
        if (await isCorepackShim(pmBin)) {
          return err(`${ctx.pack.packageManager} is a corepack shim — ${COREPACK_HINT}`, {
            ...base,
            binary: pmBin,
            hint: COREPACK_HINT,
          });
        }
      } catch (e) {
        return missingBinaryOutput(e, ctx.pack.packageManager, NET) ?? err(errMsg(e), base);
      }
      try {
        for (const grp of [...groups.values()].sort((a, b) => (a.lock.dir < b.lock.dir ? -1 : 1))) {
          results.push(
            await auditGroup(
              ctx,
              g,
              client,
              pmBin,
              baseFiles,
              grp.lock,
              [...grp.dirs].sort(),
              root,
            ),
          );
        }
      } catch (e) {
        return (
          missingBinaryOutput(e, ctx.pack.packageManager, NET) ??
          err(`audit failed to run: ${errMsg(e)}`, base)
        );
      }
    }

    const audits = results.map((r) => ({
      dir: r.dir === "" ? "." : r.dir,
      lockfile: r.lockfile,
      ...(r.verdict
        ? {
            high: r.verdict.high,
            critical: r.verdict.critical,
            packages: r.verdict.packages.slice(0, MAX_LIST),
          }
        : {}),
      ...(r.error ? { error: r.error } : {}),
    }));
    const details = {
      network: NET,
      ...base,
      lockfileChanged,
      ...(lockfileChanged.length > 0 ? { lockfile: "lockfile changed (protected)" } : {}),
      missingFromLockfile: missing.slice(0, MAX_LIST),
      audits,
    };
    for (const r of results) {
      const v = r.verdict;
      if (v && v.high + v.critical > 0) {
        problems.push(
          `${r.dir || "."}: ${v.high} high and ${v.critical} critical advisory(ies)${v.packages.length ? ` (${v.packages.slice(0, 5).join(", ")})` : ""}`,
        );
      }
    }
    const errored = results.filter((r) => r.error);
    if (problems.length > 0) {
      // a problem the gate itself found wins over an audit that could not run: fail, note the error
      return {
        status: "fail",
        summary: `audit: ${problems.join("; ")}`,
        details: { ...details, auditErrors: errored.map((r) => `${r.dir || "."}: ${r.error}`) },
      };
    }
    if (errored.length > 0) {
      return {
        status: "error",
        summary: `audit ${errored[0]?.dir || "."}: ${errored[0]?.error}`,
        details,
      };
    }
    return { status: "pass", summary: "audit clean", details };
  },
};
