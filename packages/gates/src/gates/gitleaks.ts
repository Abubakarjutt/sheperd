import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import type { Gate, GateOutput } from "../types.js";
import {
  changedScanFiles,
  errMsg,
  GateExec,
  missingBinaryOutput,
  realRootOf,
  resolveBin,
} from "./shared.js";

const MAX_FINDINGS = 50;

const Report = z.array(
  z.object({
    RuleID: z.string(),
    File: z.string(),
    StartLine: z.number(),
    Match: z.string().optional(),
    Secret: z.string().optional(),
  }),
);

const err = (summary: string, details: unknown = null): GateOutput => ({
  status: "error",
  summary,
  details,
});

/**
 * gitleaks over the changed files.
 *
 * Invocation: `gitleaks dir` accepts a single path, so the changed files are copied (regular
 * files only, already vetted to be inside the worktree) into a private 0700 staging directory
 * under scratch with their relative paths, and scanned in ONE run. This is bounded (one exec,
 * however many files) and keeps reported paths worktree-relative. The staging directory (which
 * holds copies of possibly secret-bearing files) is deleted afterwards.
 *
 * The implementer must not be able to allowlist a secret, so repo-level suppressions are all
 * disabled: `--config` points at a scratch file that only extends the built-in default rules
 * (a repo `.gitleaks.toml` is never read), `--gitleaks-ignore-path` points at an empty
 * directory (a repo `.gitleaksignore` is never read) and `--ignore-gitleaks-allow` neutralises
 * inline `gitleaks:allow` comments. `--redact` keeps secret values out of the report and of
 * this gate's details; as defense in depth a finding whose Secret is not "REDACTED" has its
 * match dropped.
 *
 * Fail-closed (#22): missing binary, timeout, unexpected exit code, missing report or a report
 * failing the schema is `error`.
 */
export const gitleaksGate: Gate = {
  name: "gitleaks",
  category: "security",
  async run(ctx) {
    const g = new GateExec(ctx);
    let gitleaks: string;
    try {
      gitleaks = resolveBin("gitleaks");
    } catch (e) {
      return missingBinaryOutput(e, "gitleaks") ?? err(errMsg(e));
    }
    let files: string[];
    try {
      files = await changedScanFiles(ctx, g);
    } catch (e) {
      return err(`cannot list changed files against ${ctx.baseRef}: ${errMsg(e)}`);
    }
    const base = { network: "deny" };
    if (files.length === 0) {
      return { status: "pass", summary: "no changed files", details: { ...base, files: 0 } };
    }

    let work: string | undefined;
    let stage = "";
    try {
      work = await realpath(await mkdtemp(join(ctx.scratch, "gitleaks-")));
      stage = join(work, "stage");
      const noIgnore = join(work, "no-ignore");
      const report = join(work, "report.json");
      const config = join(work, "config.toml");
      await mkdir(stage, { mode: 0o700 });
      await mkdir(noIgnore, { mode: 0o700 });
      await writeFile(config, "[extend]\nuseDefault = true\n", { mode: 0o600 });
      const root = await realRootOf(ctx);
      for (const f of files) {
        const dest = join(stage, f);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(join(root, f), dest);
      }
      const r = await g.exec([
        gitleaks,
        "dir",
        stage,
        "--config",
        config,
        "--gitleaks-ignore-path",
        noIgnore,
        "--ignore-gitleaks-allow",
        "--redact",
        "--no-banner",
        "--no-color",
        "--log-level",
        "error",
        "--report-format",
        "json",
        "--report-path",
        report,
      ]);
      if (r.timedOut) return err("gitleaks timed out", base);
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        return err(`gitleaks exited ${r.exitCode}: ${r.stderr.trim().slice(0, 300)}`, base);
      }
      let parsed: z.infer<typeof Report>;
      try {
        parsed = Report.parse(JSON.parse(await readFile(report, "utf8")));
      } catch (e) {
        return err(
          `gitleaks report missing or invalid (exit ${r.exitCode}): ${errMsg(e).slice(0, 200)}`,
          base,
        );
      }
      if (r.exitCode === 0 && parsed.length > 0) {
        return err("gitleaks exited 0 but reported findings", base);
      }
      if (r.exitCode === 1 && parsed.length === 0) {
        return err("gitleaks exited 1 with an empty report", base);
      }
      if (parsed.length === 0) {
        return {
          status: "pass",
          summary: `gitleaks clean (${files.length} file(s))`,
          details: { ...base, files: files.length },
        };
      }
      const findings = parsed.map((f) => ({
        rule: f.RuleID,
        file: f.File.startsWith(stage + sep) ? f.File.slice(stage.length + 1) : f.File,
        line: f.StartLine,
        match: f.Secret === "REDACTED" ? f.Match : "REDACTED",
      }));
      return {
        status: "fail",
        summary: `gitleaks found ${findings.length} secret(s)`,
        details: { ...base, files: files.length, findings: findings.slice(0, MAX_FINDINGS) },
      };
    } catch (e) {
      return (
        missingBinaryOutput(e, "gitleaks") ?? err(`gitleaks failed to run: ${errMsg(e)}`, base)
      );
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  },
};
