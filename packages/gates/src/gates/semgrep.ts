import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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
export const SEMGREP_RULES_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "rules",
  "semgrep-default.yml",
);
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
const caBundleEnv = (): string[] => {
  const f = CA_BUNDLES.find((p) => existsSync(p));
  return f ? [`SSL_CERT_FILE=${f}`] : [];
};

const RULES_NOTE = "rewire-original, Apache-2.0";
const MAX_FINDINGS = 50;

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
});

/** Per-file parse failures: the file was (partly) not analysed, so the implementer must fix it. */
const SYNTAX_RE = /syntax|parsing|lexical|parse error/i;
const typeText = (t: unknown): string => (typeof t === "string" ? t : JSON.stringify(t ?? ""));

const err = (summary: string, details: unknown = null): GateOutput => ({
  status: "error",
  summary,
  details,
});

type Finding = { rule: string; file: string; line: number; severity: string; message: string };

/**
 * semgrep over the changed files with rewire's own rules.
 *
 * Fail-closed (#22): a missing binary, timeout, non-0/1 exit, unparseable or schema-invalid JSON,
 * or a semgrep error of level `error` is `error`, never `pass`. A per-file syntax/parse error
 * (any level) is `fail` and lists the file, since that file was not fully analysed; the
 * implementer can fix it, so it is not a tool error. Warn-level errors that are not syntax
 * errors (e.g. a rule timing out on one file) are recorded in details but do not block.
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
      return missingBinaryOutput(e, "semgrep") ?? err(errMsg(e));
    }
    let files: string[];
    try {
      files = await changedScanFiles(ctx, g);
    } catch (e) {
      return err(`cannot list changed files against ${ctx.baseRef}: ${errMsg(e)}`);
    }
    const base = { network: "deny", rules: RULES_NOTE };
    if (files.length === 0) {
      return { status: "pass", summary: "no changed files", details: { ...base, files: 0 } };
    }

    const home = join(ctx.scratch, "semgrep-home");
    const dirs = [home, join(home, ".config"), join(home, ".cache"), join(home, "tmp")];
    try {
      for (const d of dirs) await mkdir(d, { recursive: true, mode: 0o700 });
    } catch (e) {
      return err(`cannot prepare semgrep scratch: ${errMsg(e)}`);
    }

    const findings: Finding[] = [];
    const syntaxFiles = new Set<string>();
    const hardErrors: string[] = [];
    const warnings: string[] = [];
    try {
      for (const chunk of chunks(files, SCAN_CHUNK)) {
        const r = await g.exec([
          ENV_BIN,
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
          SEMGREP_RULES_FILE,
          "--json",
          "--quiet",
          "--metrics=off",
          "--disable-version-check",
          "--disable-nosem",
          "--no-git-ignore",
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
          findings.push({
            rule: x.check_id.replace(/^.*?(rewire\.)/, "$1"),
            file: x.path.replace(/^\.\//, ""),
            line: x.start.line,
            severity: x.extra.severity,
            message: x.extra.message ?? "",
          });
        }
        for (const e of parsed.errors) {
          const text = `${typeText(e.type)} ${e.message ?? ""}`;
          if (SYNTAX_RE.test(typeText(e.type)) && e.path) syntaxFiles.add(e.path);
          else if (e.level === "error") hardErrors.push(text.trim().slice(0, 200));
          else warnings.push(text.trim().slice(0, 200));
        }
      }
    } catch (e) {
      const m = missingBinaryOutput(e, "semgrep");
      return m ?? err(`semgrep failed to run: ${errMsg(e)}`, base);
    }

    const details = {
      ...base,
      files: files.length,
      findings: findings.slice(0, MAX_FINDINGS),
      parseErrors: [...syntaxFiles].sort(),
      warnings: warnings.slice(0, 10),
    };
    if (hardErrors.length > 0) {
      return err(`semgrep reported ${hardErrors.length} error(s): ${hardErrors[0]}`, {
        ...details,
        errors: hardErrors.slice(0, 10),
      });
    }
    const blocking = findings.filter((f) => f.severity === "ERROR");
    if (blocking.length > 0 || syntaxFiles.size > 0) {
      const parts = [
        blocking.length > 0 ? `${blocking.length} security finding(s)` : "",
        syntaxFiles.size > 0 ? `${syntaxFiles.size} file(s) failed to parse` : "",
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
