import { type GateContext, GateExec } from "@rewire/gates";
import type { SandboxClient } from "@rewire/sandbox";
import { readInsideWorktree, resolveInsideWorktree } from "./evidence.js";

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
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** Extensions whose content is never reviewed as text (R21): matched case-insensitively. */
export const BINARY_ASSET_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "wasm",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "mp3",
  "mp4",
  "webm",
  "ogg",
  "wav",
];
const isBinaryAsset = (p: string): boolean => {
  const ext = /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase();
  return ext !== undefined && BINARY_ASSET_EXTS.includes(ext);
};

/** git's own binary heuristic: a NUL in the first 8000 bytes. */
export const SNIFF_BYTES = 8000;
const HEAD_BIN = "/usr/bin/head";

/**
 * R21b: is the worktree (new-side) content of `rel` really binary? Only the first SNIFF_BYTES
 * bytes are read, inside the review sandbox, after realpath containment. Anything that cannot be
 * proven binary (missing, outside, a symlink out) is "not binary" and is reviewed as text.
 */
async function isBinaryContent(worktree: string, rel: string, g: GateExec): Promise<boolean> {
  const r = await resolveInsideWorktree(worktree, rel);
  if (r.kind !== "ok") return false;
  const out = await g.exec([HEAD_BIN, "-c", String(SNIFF_BYTES), "--", r.path]);
  if (out.timedOut || out.exitCode !== 0) {
    throw new Error(`binary sniff of ${rel} failed (exit ${out.exitCode}): ${out.stderr.trim()}`);
  }
  return out.stdout.includes("\0");
}

/** R22: ignored-file listing cap. */
export const IGNORED_CAP = 10_000;
/** Self-ignoring tool caches: everything under them is ignored silently (R22). */
const CACHE_DIRS = new Set([
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);
/** Conventional build output: silent when the directory was already ignored at baseRef (R22). */
const BUILD_DIRS = new Set(["dist", "build", "out", "coverage", ".next", "target", "lib"]);
/** Ignored files with these extensions escalate by name, never by content (R22). */
export const SOURCE_EXTS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "rb",
  "php",
  "sh",
];
const isSource = (p: string): boolean => {
  const ext = /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase();
  return ext !== undefined && SOURCE_EXTS.includes(ext);
};
const segments = (p: string): string[] => p.split("/").filter((s) => s !== "");
const inCacheDir = (p: string): boolean => segments(p).some((s) => CACHE_DIRS.has(s));
/** Files that steer git itself; any change (or new ignored copy) is a forced finding. */
const PROTECTED_NAMES = new Set([".gitattributes", ".gitignore"]);
const protectedBase = (p: string): string | undefined => {
  const base = (p.split("/").pop() ?? "").normalize("NFC").toLowerCase();
  return PROTECTED_NAMES.has(base) ? base : undefined;
};

type RawChange = { path: string; status: string; oldMode: string; newMode: string; oldSha: string };

/** Parse `git diff --raw -z --no-renames`: `:om nm osha nsha S\0path\0` records. */
function parseRaw(out: string): RawChange[] {
  const t = out.split("\0");
  const res: RawChange[] = [];
  for (let i = 0; i < t.length; i++) {
    const meta = t[i] ?? "";
    if (!meta.startsWith(":")) continue;
    const [om = "", nm = "", osha = "", , status = ""] = meta.slice(1).split(" ");
    const path = t[++i];
    if (path) res.push({ path, status: status[0] ?? "", oldMode: om, newMode: nm, oldSha: osha });
  }
  return res;
}

async function isEmptyFile(
  worktree: string,
  path: string,
  client: SandboxClient,
): Promise<boolean> {
  const r = await readInsideWorktree(worktree, path, client);
  return r.kind === "ok" && r.text === "";
}

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
 * plus untracked, non-ignored files with every line counted as added; ignored files are listed
 * by name only and never read (R22). git runs through the
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
  // Binary assets never expand into the patch; they escalate through `omitted` (R21).
  const excludeAssets = BINARY_ASSET_EXTS.map((e) => `:(exclude,icase,glob)**/*.${e}`);
  const textDiff = (paths: string[]): Promise<string> =>
    g.git([
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
      ...paths,
    ]);
  let raw = await textDiff([".", ...excludeAssets]);
  const changed = parseRaw(
    await g.git([...attr, "diff", "--raw", "-z", "--no-abbrev", "--no-renames", baseRef, "--"]),
  );
  // R21b: an asset extension alone never removes a file from review. Excluded tracked assets
  // whose new side is text are re-diffed as text; only real binary content stays an asset.
  const binaryAssets = new Set<string>();
  const textAssets: string[] = [];
  for (const c of changed) {
    if (!isBinaryAsset(c.path)) continue;
    if (c.status === "D" || (await isBinaryContent(worktree, c.path, g))) binaryAssets.add(c.path);
    else textAssets.push(c.path);
  }
  if (textAssets.length > 0) raw += await textDiff(textAssets.map((p) => `:(literal)${p}`));
  const parsed = parseDiff(raw);
  const tracked = raw.replace(/\0/g, "");
  const notInternal = (p: string): boolean =>
    p !== "" && !segments(p).includes("node_modules") && !segments(p).includes(".git");
  const scope = ["--", ".", ":(exclude,glob)**/node_modules/**", ":(exclude,glob).git/**"];
  // R22: only non-ignored untracked files are ever read; ignored ones are listed by name below.
  const others = (await g.git(["ls-files", "--others", "--exclude-standard", "-z", ...scope]))
    .split("\0")
    .filter(notInternal);

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
  // A changed path with no parsed hunks is never dropped silently.
  const seen = new Set(files.map((f) => f.path));
  for (const c of changed) {
    const modeChange = c.status === "M" && c.oldMode !== c.newMode;
    if (seen.has(c.path)) {
      // A content change does not hide a mode change.
      if (modeChange) omitted.push(`${c.path} (mode change)`);
      continue;
    }
    files.push({ path: c.path, addedLines: [] });
    if (binaryAssets.has(c.path)) {
      omitted.push(`${c.path} (binary asset)`);
    } else if (modeChange) {
      omitted.push(`${c.path} (mode change)`);
    } else if (c.status === "A" && (await isEmptyFile(worktree, c.path, opts.client))) {
      // An empty added file has nothing to review.
    } else if (c.status === "D" && c.oldSha === EMPTY_BLOB) {
      // An empty deleted file has nothing to review.
    } else {
      omitted.push(`${c.path} (no textual diff)`);
    }
  }
  let patch = tracked;
  for (const path of others.sort()) {
    if (isBinaryAsset(path) && (await isBinaryContent(worktree, path, g))) {
      files.push({ path, addedLines: [] });
      omitted.push(`${path} (binary asset)`);
      continue;
    }
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
  const ignored = await listIgnored(g, baseRef, changed, scope, notInternal);
  omitted.push(...ignored.omitted);
  // Files that steer git itself (diff attributes, ignore rules) are protected: any change to
  // one, and any new ignored (self-ignoring) copy, is a mandatory security finding. Names are
  // NFC-normalized and compared case-insensitively.
  for (const p of new Set([
    ...files.map((f) => f.path),
    ...changed.map((c) => c.path),
    ...others,
    ...ignored.protectedPaths,
  ])) {
    const base = protectedBase(p);
    if (base === undefined) continue;
    omitted.push(`${p} ${base} changed (protected)`);
    forced.push({
      file: p,
      lineStart: 1,
      lineEnd: 1,
      evidence: `${base} changed`,
      failureScenario: `A changed ${base} can alter how git diffs, lists or checks out files and hide changes from review; it is protected and must not be modified by the implementer.`,
    });
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

/**
 * R22: ignored untracked files, by NAME only (never read, never sent to the provider).
 * `--directory` keeps huge ignored trees as one entry. Each entry is classified from its path:
 * cache dirs are silent; an ignored `.gitignore`/`.gitattributes` is a protected path (forced
 * finding); an ignored source file escalates as `"<path> (ignored source file)"`; everything
 * else is silent. A directory entry is silent when it is conventional build output that was
 * already ignored at baseRef; any other directory entry is expanded by a second name-only listing
 * restricted to source and protected names. The listing is capped at IGNORED_CAP entries.
 */
async function listIgnored(
  g: GateExec,
  baseRef: string,
  changed: RawChange[],
  scope: string[],
  keep: (p: string) => boolean,
): Promise<{ omitted: string[]; protectedPaths: string[] }> {
  const omitted: string[] = [];
  const protectedPaths: string[] = [];
  let truncated = false;
  const capped = (list: string[]): string[] => {
    if (list.length <= IGNORED_CAP) return list;
    truncated = true;
    return list.slice(0, IGNORED_CAP);
  };
  const ls = (extra: string[], specs: string[]) =>
    g.git(["ls-files", "--others", "--ignored", "--exclude-standard", ...extra, "-z", ...specs]);
  const entries = capped(
    (await ls(["--directory"], scope)).split("\0").filter((p) => keep(p) && !inCacheDir(p)),
  );
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) (e.endsWith("/") ? dirs : files).push(e);

  const changedSet = new Set(changed.map((c) => c.path));
  const expand: string[] = [];
  for (const d of dirs) {
    const name = segments(d).pop() ?? "";
    if (BUILD_DIRS.has(name) && (await ignoredAtBase(g, baseRef, d, changedSet))) continue;
    expand.push(d);
  }
  if (expand.length > 0) {
    const specs = [
      ...SOURCE_EXTS.map((x) => `:(glob,icase)**/*.${x}`),
      ...[...PROTECTED_NAMES].map((n) => `:(glob,icase)**/${n}`),
      ":(exclude,glob)**/node_modules/**",
      ":(exclude,glob).git/**",
      ...[...CACHE_DIRS].map((c) => `:(exclude,glob)**/${c}/**`),
    ];
    const inner = (await ls([], ["--", ...specs]))
      .split("\0")
      .filter((p) => keep(p) && !inCacheDir(p) && expand.some((d) => p.startsWith(d)));
    const room = Math.max(0, IGNORED_CAP - entries.length);
    if (inner.length > room) truncated = true;
    files.push(...inner.slice(0, room));
  }
  for (const p of new Set(files)) {
    if (protectedBase(p) !== undefined) protectedPaths.push(p);
    else if (isSource(p)) omitted.push(`${p} (ignored source file)`);
  }
  if (truncated) omitted.push("ignored-file listing truncated");
  return { omitted, protectedPaths };
}

/**
 * Is directory `dir` (with trailing slash) ignored by a rule that already existed at baseRef?
 * The deciding rule (`check-ignore -v`) must come from a `.gitignore` on the directory's own
 * ancestor chain that exists in the baseRef tree and is unchanged; a rule from a new or changed
 * `.gitignore`, `.git/info/exclude` or a global excludes file does not count.
 */
async function ignoredAtBase(
  g: GateExec,
  baseRef: string,
  dir: string,
  changedSet: Set<string>,
): Promise<boolean> {
  const segs = segments(dir);
  const candidates = segs.map((_, i) => [...segs.slice(0, i), ".gitignore"].join("/"));
  let out: string;
  try {
    out = await g.git(["-c", "core.quotepath=off", "check-ignore", "-v", "--no-index", "--", dir]);
  } catch {
    return false; // not ignored (exit 1) or unknown: never exempt.
  }
  const line = out.split("\n")[0] ?? "";
  const source = candidates.find((c) => new RegExp(`^${escapeRe(c)}:\\d+:`).test(line));
  if (source === undefined || changedSet.has(source)) return false;
  const inBase = await g.git(["ls-tree", "-r", "-z", "--name-only", baseRef, "--", source]);
  return inBase.split("\0").includes(source);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
