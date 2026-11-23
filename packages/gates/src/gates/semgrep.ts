import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { z } from "zod";
import { PACKAGE_ROOT } from "../assets.js";
import type { Gate, GateOutput } from "../types.js";
import {
  changedScanFiles,
  chunks,
  ENV_BIN,
  errMsg,
  GateExec,
  missingBinaryOutput,
  resolveBin,
  SCAN_CHUNK,
} from "./shared.js";

/** rewire's own original ruleset (Apache-2.0); never registry rules (licence, ruling R20). */
export const SEMGREP_RULES_FILE = join(PACKAGE_ROOT, "rules", "semgrep-default.yml");
/**
 * semgrep's OCaml core initialises a CA store at startup even when it never touches the network,
 * and aborts ("empty trust anchors") when the sandbox hides the macOS keychain. Point it at a
 * bundle file (read-only) instead.
 */
const CA_BUNDLES = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
];
/**
 * Python start-up hooks semgrep's interpreter would otherwise honour (C1). The sandbox already
 * drops every PYTHON* variable (env allowlist); unsetting them again here keeps the gate safe
 * if that list ever grows. User site-packages (usercustomize, .pth) and the script-dir
 * sys.path entry are switched off: together with the scrub this is `python -I` for a console
 * script, which cannot take interpreter flags.
 */
const PYTHON_UNSET = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PYTHONINSPECT",
  "PYTHONEXECUTABLE",
  "PYTHONPYCACHEPREFIX",
  "PYTHONBREAKPOINT",
  "PYTHONWARNINGS",
  "PYTHONPLATLIBDIR",
] as const;
const PYTHON_HARDEN = ["PYTHONNOUSERSITE=1", "PYTHONSAFEPATH=1", "PYTHONDONTWRITEBYTECODE=1"];

const caBundleEnv = (): string[] => {
  const f = CA_BUNDLES.find((p) => existsSync(p));
  return f ? [`SSL_CERT_FILE=${f}`] : [];
};

const RULES_NOTE = "rewire-original, Apache-2.0";
const MAX_FINDINGS = 200;
const NET = "deny";

const SemgrepOut = z.object({
  results: z.array(
    z.object({
      check_id: z.string(),
      path: z.string(),
      start: z.object({ line: z.number() }),
      extra: z.object({ severity: z.string(), message: z.string().optional() }),
    }),
  ),
  errors: z.array(
    z.object({
      level: z.string().optional(),
      type: z.unknown().optional(),
      message: z.string().optional(),
      path: z.string().optional(),
    }),
  ),
  paths: z
    .object({
      scanned: z.array(z.string()),
    })
    .loose(),
});

/** A file the implementer can fix, or one semgrep did not (fully) analyse: both are `fail`. */
const SYNTAX_RE = /syntax|parsing|lexical|parse error/i;
const RESOURCE_RE = /timeout|out ?of ?memory|too ?many ?matches/i;
/** Allowlist of warnings known to be harmless; anything else unknown is an `error` (fail closed). */
const BENIGN_WARNING_RE = /deprecat/i;
/** Languages the ruleset covers. A changed file with one of these extensions MUST be scanned. */
const SCANNED_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
/**
 * Second pass (`--scan-unknown-extensions`) covers every other changed file, because node will
 * `require()` JS from `.txt` or extensionless files. Whether a parse error there fails depends
 * on whether node could load the file at all: `.mts`/`.cts`, case variants such as `.JS` and
 * `#!...node|tsx|ts-node|bun|deno` shebang scripts are always strict. Any other file is strict
 * only if node's loader would accept it (`classifyPass2`, rulings R28 and R32; nothing is ever
 * run). A file node cannot load is dropped from pass 2: no false positives on prose or Makefiles.
 */
const JS_LIKE_EXT_RE = /\.(m?[jt]s|c[jt]s|[jt]sx)$/i;
const SHEBANG_RE = /^#!.*\b(node|tsx|ts-node|bun|deno)\b/;
const MAX_COMPILE_BYTES = 8 * 1024 * 1024;
/** node's CommonJS module wrapper parameters (lib/internal/modules/cjs/loader.js). */
const CJS_WRAPPER_PARAMS = ["exports", "require", "module", "__filename", "__dirname"];
/**
 * SyntaxError messages after which node's CommonJS loader retries the source as an ES module
 * (`require(esm)`, node 22.12+). They mirror `esm_syntax_error_messages` and
 * `throws_only_in_cjs_error_messages` in node's src/node_contextify.cc (used by
 * `shouldRetryAsESM` in lib/internal/modules/helpers.js). Every string below is present
 * verbatim in the pinned node binary on the build machine (checked with `strings`).
 */
const ESM_RETRY_MESSAGES = new Set([
  "Cannot use import statement outside a module",
  "Unexpected token 'export'",
  "Cannot use 'import.meta' outside a module",
  "Identifier 'module' has already been declared",
  "Identifier 'exports' has already been declared",
  "Identifier 'require' has already been declared",
  "Identifier '__filename' has already been declared",
  "Identifier '__dirname' has already been declared",
  "await is only valid in async functions and the top level bodies of modules",
]);
/** vm errors may come from another realm, so the name is checked as well as instanceof. */
const isSyntaxError = (e: unknown): boolean =>
  e instanceof SyntaxError ||
  (typeof e === "object" &&
    e !== null &&
    Object.getPrototypeOf(e)?.constructor?.name === "SyntaxError");
const errText = (e: unknown): string =>
  typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string"
    ? (e as { message: string }).message
    : "";

type Load = "always" | "compiles" | "no" | "module?";

/**
 * In-process part of the classification. "module?" means every CommonJS and script parse threw a
 * SyntaxError without an ESM-retry message: only a real module parse (child) can decide it.
 */
function loadability(worktree: string, f: string): Load {
  if (JS_LIKE_EXT_RE.test(f)) return "always";
  let src: string;
  try {
    const full = join(worktree, f);
    if (statSync(full).size > MAX_COMPILE_BYTES) return "compiles"; // cannot cheaply tell: scan strictly
    src = readFileSync(full, "utf8");
  } catch {
    return "no";
  }
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const first = src.split("\n", 1)[0] ?? "";
  if (SHEBANG_RE.test(first)) return "always";
  if (src.startsWith("#!")) src = `//${src}`;
  // R28: `require()` of a non-.js/.mjs extension goes through the CommonJS wrapper, so a
  // function body with exactly node's wrapper parameters is what node loads (top-level
  // `return`, `new.target` ...). R32(a): a SyntaxError node would retry as ESM counts as
  // loadable. Any non-SyntaxError exception (RangeError on deep nesting etc.) is strict.
  try {
    vm.compileFunction(src, CJS_WRAPPER_PARAMS, { filename: f });
    return "compiles";
  } catch (e) {
    if (!isSyntaxError(e) || ESM_RETRY_MESSAGES.has(errText(e))) return "compiles";
  }
  try {
    new vm.Script(src, { filename: f });
    return "compiles";
  } catch (e) {
    if (!isSyntaxError(e)) return "compiles";
  }
  return "module?";
}

/**
 * R32(b): parse each file as an ES module in ONE child `node --experimental-vm-modules` (the
 * pinned node that runs rewire, through the verify sandbox: no network, the gate deadline as
 * timeout). `new vm.SourceTextModule(src)` only parses; link/evaluate are never called. Prints
 * `{"<file>": true|false}`. Files over 8 MB are reported as true (strict).
 */
const MODULE_PARSE_SCRIPT = `
const fs = require("node:fs"), vm = require("node:vm");
const out = {};
for (const f of process.argv.slice(1)) {
  try {
    if (fs.statSync(f).size > ${MAX_COMPILE_BYTES}) { out[f] = true; continue; }
    let src = fs.readFileSync(f, "utf8");
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    if (src.startsWith("#!")) src = "//" + src;
    new vm.SourceTextModule(src, { identifier: "file:///" + encodeURI(f) });
    out[f] = true;
  } catch (e) {
    out[f] = !(e instanceof SyntaxError);
  }
}
process.stdout.write(JSON.stringify(out));
`;
const ModuleParseOut = z.record(z.string(), z.boolean());

/**
 * Files (of `candidates`) that parse as an ES module. Fail-closed: if the child fails, times
 * out, or its output is unparseable or does not cover every candidate, ALL candidates count as
 * parsing (strict), and the reason is returned for the warnings list.
 */
async function moduleParses(
  g: GateExec,
  candidates: string[],
): Promise<{ parses: Set<string>; failure?: string }> {
  if (candidates.length === 0) return { parses: new Set() };
  const all = { parses: new Set(candidates) };
  const parses = new Set<string>();
  try {
    for (const chunk of chunks(candidates, SCAN_CHUNK)) {
      const r = await g.exec([
        process.execPath,
        "--experimental-vm-modules",
        "--no-warnings",
        "-e",
        MODULE_PARSE_SCRIPT,
        "--",
        ...chunk,
      ]);
      if (r.timedOut || r.exitCode !== 0) {
        return {
          ...all,
          failure: `module-parse child ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.stderr.trim().slice(0, 200)}`,
        };
      }
      const out = ModuleParseOut.parse(JSON.parse(r.stdout));
      for (const f of chunk) {
        const v = out[f];
        if (v === undefined) return { ...all, failure: `module-parse child skipped ${f}` };
        if (v) parses.add(f);
      }
    }
  } catch (e) {
    return { ...all, failure: `module-parse child unusable: ${errMsg(e).slice(0, 200)}` };
  }
  return { parses };
}
const typeText = (t: unknown): string => (typeof t === "string" ? t : JSON.stringify(t ?? ""));
const norm = (p: string): string => p.replace(/^\.\//, "");

const err = (summary: string, details: Record<string, unknown> = {}): GateOutput => ({
  status: "error",
  summary,
  details: { network: NET, ...details },
});

type Finding = { rule: string; file: string; line: number; severity: string; message: string };

/**
 * semgrep over the changed files with rewire's own rules, in two passes: pass 1 the JS/TS
 * extensions semgrep recognises; pass 2 every other changed file with `--scan-unknown-extensions`.
 *
 * Fail-closed (#22): a missing binary, timeout, non-0/1 exit, unparseable or schema-invalid JSON,
 * or a semgrep error that is not about a changed file is `error`, never `pass`. A syntax/parse
 * error, timeout or out-of-memory on a changed file is `fail` and lists the file, since it was
 * not fully analysed; the implementer can fix it, so it is not a tool error. In pass 2, syntax
 * errors never occur for files that cannot compile as JS, because those are not scanned (see `loadability`).
 * Only a warn-level `deprecat*` message is ignored as benign.
 *
 * `paths.skipped` is NOT used: semgrep only fills it under `--verbose`, so it is dead without
 * it. Instead every changed file that must be scanned is checked against `paths.scanned`.
 *
 * Host-state: semgrep writes ~/.semgrep (settings, log) and caches. Sandbox exec has no env
 * option, so the command runs through `/usr/bin/env` with HOME, XDG_*, TMPDIR pointing at
 * subdirectories of scratch (the only writable place). Nothing then writes outside scratch.
 * Network is denied by the verify profile; additionally `--metrics=off`, no version check and
 * a local rules file only. `--disable-nosem` stops `// nosemgrep` comments from suppressing
 * findings; `--no-git-ignore` stops a repo .gitignore from hiding an explicitly passed file.
 */
export const semgrepGate: Gate = {
  name: "semgrep",
  category: "security",
  async run(ctx) {
    const g = new GateExec(ctx);
    let semgrep: string;
    try {
      semgrep = resolveBin("semgrep");
    } catch (e) {
      return missingBinaryOutput(e, "semgrep", NET) ?? err(errMsg(e));
    }
    let files: string[];
    try {
      files = await changedScanFiles(ctx, g);
    } catch (e) {
      return err(`cannot list changed files against ${ctx.baseRef}: ${errMsg(e)}`);
    }
    const base = { network: NET, rules: RULES_NOTE };
    if (files.length === 0) {
      return { status: "pass", summary: "no changed files", details: { ...base, files: 0 } };
    }
    const changed = new Set(files);

    // C1: a fresh, unpredictable HOME per run, created here (mkdtemp is exclusive, so nothing an
    // earlier sandboxed command wrote can already be in it) and removed when the scan ends.
    // The ruleset is copied in too: the sandbox need not see where rewire is installed (bwrap
    // gives every command a fresh /tmp, and an npm install can live anywhere).
    let home: string;
    let rules: string;
    try {
      home = await mkdtemp(join(ctx.scratch, "semgrep-home-"));
      await chmod(home, 0o700);
      for (const d of [".config", ".cache", "tmp"]) await mkdir(join(home, d), { mode: 0o700 });
      rules = join(home, "rules.yml");
      await copyFile(SEMGREP_RULES_FILE, rules);
      await chmod(rules, 0o400);
    } catch (e) {
      return err(`cannot prepare semgrep scratch: ${errMsg(e)}`, base);
    }

    const findings: Finding[] = [];
    /** file -> why it is a problem (syntax error, timeout, not scanned, ...) */
    const problemFiles = new Map<string, string[]>();
    const flag = (file: string, why: string) => {
      const l = problemFiles.get(file) ?? [];
      if (!l.includes(why)) l.push(why);
      problemFiles.set(file, l);
    };
    const hardErrors: string[] = [];
    const warnings: string[] = [];
    try {
      const pass1 = files.filter((f) => SCANNED_EXT_RE.test(f));
      const load = new Map(
        files.filter((f) => !SCANNED_EXT_RE.test(f)).map((f) => [f, loadability(ctx.worktree, f)]),
      );
      const maybeModules = [...load].filter(([, v]) => v === "module?").map(([f]) => f);
      const mod = await moduleParses(g, maybeModules);
      if (mod.failure)
        warnings.push(`${mod.failure}; ${maybeModules.length} file(s) scanned strictly`);
      for (const f of maybeModules) load.set(f, mod.parses.has(f) ? "compiles" : "no");
      const pass2 = [...load].filter(([, v]) => v !== "no").map(([f]) => f);
      const strict = new Set(pass2);
      const jobs = [
        ...chunks(pass1, SCAN_CHUNK).map((chunk) => ({ chunk, unknown: false })),
        ...chunks(pass2, SCAN_CHUNK).map((chunk) => ({ chunk, unknown: true })),
      ];
      for (const { chunk, unknown } of jobs) {
        const r = await g.exec([
          ENV_BIN,
          ...PYTHON_UNSET.flatMap((v) => ["-u", v]),
          ...PYTHON_HARDEN,
          `HOME=${home}`,
          `XDG_CONFIG_HOME=${join(home, ".config")}`,
          `XDG_CACHE_HOME=${join(home, ".cache")}`,
          `TMPDIR=${join(home, "tmp")}`,
          "SEMGREP_SEND_METRICS=off",
          "SEMGREP_ENABLE_VERSION_CHECK=0",
          ...caBundleEnv(),
          semgrep,
          "scan",
          "--config",
          rules,
          "--json",
          "--quiet",
          "--metrics=off",
          "--disable-version-check",
          "--disable-nosem",
          "--no-git-ignore",
          ...(unknown ? ["--scan-unknown-extensions"] : []),
          "--",
          ...chunk,
        ]);
        if (r.timedOut) return err("semgrep timed out", base);
        if (r.exitCode !== 0 && r.exitCode !== 1) {
          return err(`semgrep exited ${r.exitCode}: ${r.stderr.trim().slice(0, 300)}`, base);
        }
        let parsed: z.infer<typeof SemgrepOut>;
        try {
          parsed = SemgrepOut.parse(JSON.parse(r.stdout));
        } catch (e) {
          return err(
            `semgrep output unparseable (exit ${r.exitCode}): ${errMsg(e).slice(0, 200)}`,
            base,
          );
        }
        for (const x of parsed.results) {
          const f = {
            rule: x.check_id.replace(/^.*?(rewire\.)/, "$1"),
            file: norm(x.path),
            line: x.start.line,
            severity: x.extra.severity,
            message: x.extra.message ?? "",
          };
          // semgrep reports one finding per matching pattern branch; keep one per rule and line
          if (!findings.some((o) => o.rule === f.rule && o.file === f.file && o.line === f.line)) {
            findings.push(f);
          }
        }
        // Every changed file in a language the rules cover must actually have been scanned:
        // semgrep silently skips oversized, ignored or unreadable files.
        const scanned = new Set(parsed.paths.scanned.map(norm));
        for (const f of chunk) {
          if ((!unknown || strict.has(f)) && !scanned.has(f)) flag(f, "not scanned");
        }
        for (const e of parsed.errors) {
          const typ = typeText(e.type);
          const text = `${typ} ${e.message ?? ""}`.trim().slice(0, 200);
          const path = e.path ? norm(e.path) : undefined;
          const lenient = unknown && path !== undefined && !strict.has(path);
          if (RESOURCE_RE.test(typ)) {
            flag(path ?? "(no path)", text);
          } else if (SYNTAX_RE.test(typ)) {
            if (lenient) warnings.push(`${path}: ${text}`);
            else flag(path ?? "(no path)", text);
          } else if (path !== undefined && changed.has(path)) {
            if (lenient) warnings.push(`${path}: ${text}`);
            else flag(path, text);
          } else if (e.level === "warn" && BENIGN_WARNING_RE.test(text)) {
            warnings.push(text);
          } else {
            hardErrors.push(text);
          }
        }
      }
    } catch (e) {
      return (
        missingBinaryOutput(e, "semgrep", NET) ?? err(`semgrep failed to run: ${errMsg(e)}`, base)
      );
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }

    const unscanned = [...problemFiles.entries()]
      .map(([file, why]) => ({ file, why }))
      .sort((a, b) => (a.file < b.file ? -1 : 1));
    const details = {
      ...base,
      files: files.length,
      findings: findings.slice(0, MAX_FINDINGS),
      problemFiles: unscanned,
      warnings: warnings.slice(0, 10),
    };
    if (hardErrors.length > 0) {
      return err(`semgrep reported ${hardErrors.length} error(s): ${hardErrors[0]}`, {
        ...details,
        errors: hardErrors.slice(0, 10),
      });
    }
    const blocking = findings.filter((f) => f.severity === "ERROR");
    if (blocking.length > 0 || unscanned.length > 0) {
      const parts = [
        blocking.length > 0 ? `${blocking.length} security finding(s)` : "",
        unscanned.length > 0
          ? `${unscanned.length} file(s) not scanned or errored: ${unscanned
              .slice(0, 3)
              .map((u) => u.file)
              .join(", ")}`
          : "",
      ].filter(Boolean);
      return { status: "fail", summary: `semgrep: ${parts.join(", ")}`, details };
    }
    return {
      status: "pass",
      summary: `semgrep clean (${files.length} file(s), ${findings.length} warning(s))`,
      details,
    };
  },
};
