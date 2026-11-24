#!/usr/bin/env node
// Installs the packed npm tarballs the way a user would, into a project and globally
// (`npm i -g --prefix`, the documented install), offline so the registry never takes part, and
// checks the installed CLI (docs/RELEASING.md):
//   - `rewire --help` exits 0 and prints the usage;
//   - `rewire doctor` resolves rewire-sandbox from the installed sheperd-<os>-<arch> package, in
//     both installs (other doctor checks, e.g. a missing semgrep or no models, are not asserted);
//   - a platform binary whose bytes differ from the ones the bundle recorded is refused.
// With --faux-run it also drives one headless `rewire run` with the faux provider against a copy
// of the sum-lib fixture and requires a verified result. That loads every prompt and the semgrep
// rules from the installed package, so it proves the bundled assets resolve. It needs git, rg,
// semgrep and gitleaks on PATH and a node_modules with vitest and typescript (--modules).
//
//   node scripts/npm/smoke.mjs [--tarballs dir] [--work dir] [--faux-run] [--modules dir]
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values } = parseArgs({
  options: {
    tarballs: { type: "string", default: join(ROOT, "dist-npm", "tarballs") },
    work: { type: "string" },
    "faux-run": { type: "boolean", default: false },
    modules: { type: "string", default: join(ROOT, "node_modules") },
  },
});

const fail = (msg) => {
  process.stderr.write(`smoke: FAIL ${msg}\n`);
  process.exit(1);
};
const pass = (msg) => process.stdout.write(`smoke: ok   ${msg}\n`);

const target = `${process.platform}-${process.arch}`;
const platformPkg = `sheperd-${target}`;
const tarballDir = resolve(values.tarballs);
const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith(".tgz"));
const sheperdTgz = tarballs.find((f) => /^sheperd-\d/.test(f));
const platformTgz = tarballs.find((f) => f.startsWith(`${platformPkg}-`));
if (!sheperdTgz) fail(`no sheperd-<version>.tgz in ${tarballDir}`);
if (!platformTgz) fail(`no ${platformPkg}-<version>.tgz in ${tarballDir}`);

if (values.work) mkdirSync(values.work, { recursive: true });
const work = realpathSync(values.work ?? mkdtempSync(join(tmpdir(), "sheperd-smoke-")));
const app = mkdtempSync(join(work, "install-"));
writeFileSync(join(app, "package.json"), '{ "name": "sheperd-smoke", "private": true }\n');
// Both tarballs in one install: sheperd's optional dependency on this host's platform package is
// then satisfied by the local tarball. The other platforms' optional packages do not match this
// host's os/cpu and are skipped, as they are for a user. --offline: a registry copy of the same
// version (after a release) must never replace the tarball under test.
const npmInstall = (extra, cwd) =>
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      ...extra,
      join(tarballDir, sheperdTgz),
      join(tarballDir, platformTgz),
    ],
    { cwd, stdio: "inherit" },
  );
npmInstall([], app);
const bin = join(app, "node_modules", ".bin", "rewire");
pass(`installed ${sheperdTgz} and ${platformTgz} into ${app}`);

// A user's environment: no rewire overrides and the caller's PATH. --help and doctor also get a
// fresh HOME (no models.toml of the caller's); the faux run keeps the caller's HOME, because the
// fixture's package manager (pnpm, run by the gates) needs its own state there.
const userEnv = { ...process.env };
for (const k of Object.keys(userEnv)) if (k.startsWith("REWIRE_")) delete userEnv[k];
const freshHome = mkdtempSync(join(work, "home-"));
const env = { ...userEnv, HOME: freshHome, XDG_CONFIG_HOME: join(freshHome, ".config") };
const run = (args, extra = {}, cwd = app, base = env, exe = bin) =>
  spawnSync(exe, args, { cwd, env: { ...base, ...extra }, encoding: "utf8", timeout: 600_000 });

const help = run(["--help"]);
if (help.status !== 0 || !help.stdout.includes("usage:")) {
  fail(`rewire --help exited ${help.status}: ${help.stdout}${help.stderr}`);
}
pass("rewire --help");

const sandboxLine = (path) => `✓ rewire-sandbox ${path} (platform package ${platformPkg})`;
/** Runs doctor and requires its sandbox line to be one of `paths`; returns the path found. */
function doctorFinds(exe, paths, label) {
  const doctor = run(["doctor"], {}, app, env, exe);
  process.stdout.write(`${doctor.stdout.trimEnd().replace(/^/gm, "  | ")}\n`);
  const lines = doctor.stdout.split("\n");
  const found = paths.find((p) => lines.includes(sandboxLine(p)));
  if (!found) {
    fail(
      `${label}: doctor did not resolve the sandbox from ${platformPkg}; wanted one of:\n  ${paths.map(sandboxLine).join("\n  ")}`,
    );
  }
  pass(`${label}: rewire doctor resolves the sandbox from ${platformPkg}`);
  return found;
}
const localBinary = doctorFinds(
  bin,
  [join(app, "node_modules", platformPkg, "rewire-sandbox")],
  "project install",
);

// The documented install. npm nests the optional platform package under sheperd, or (installed
// from a tarball, offline) leaves it a hoisted sibling in the global node_modules.
const prefix = mkdtempSync(join(work, "global-"));
npmInstall(["--global", "--prefix", prefix], work);
const globalModules = join(prefix, "lib", "node_modules");
doctorFinds(
  join(prefix, "bin", "rewire"),
  [
    join(globalModules, "sheperd", "node_modules", platformPkg, "rewire-sandbox"),
    join(globalModules, platformPkg, "rewire-sandbox"),
  ],
  "npm i -g --prefix",
);

// A substituted binary (same package name and version, other bytes) is refused, fail closed.
const original = readFileSync(localBinary);
writeFileSync(localBinary, Buffer.concat([original, Buffer.from("\n")]));
const tampered = run(["doctor"]);
writeFileSync(localBinary, original);
if (
  tampered.stdout.includes("✓ rewire-sandbox") ||
  !/sha256 does not match/.test(tampered.stdout)
) {
  fail(`doctor accepted a modified platform binary:\n${tampered.stdout}`);
}
pass("a modified platform binary is refused (sha256 mismatch)");

if (values["faux-run"]) {
  const repo = mkdtempSync(join(work, "repo-"));
  cpSync(join(ROOT, "packages", "pipeline", "test", "fixtures", "sum-lib"), repo, {
    recursive: true,
  });
  writeFileSync(join(repo, ".gitignore"), ".rewire/\nnode_modules\n*.log\n");
  symlinkSync(resolve(values.modules), join(repo, "node_modules"));
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "smoke");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");

  const contract = JSON.stringify({
    id: "c1",
    title: "add sum",
    criteria: [{ id: "x", kind: "change", statement: "sum(a, b) returns a + b" }],
    nonGoals: [],
    affectedAreas: ["src/sum.ts"],
    openQuestions: [],
  });
  const testSrc =
    'import { expect, test } from "vitest";\n' +
    'test("AC-1: adds two numbers", async () => {\n' +
    '  const mod = await import("../src/sum.js").catch(() => ({}) as Record<string, any>);\n' +
    '  expect(typeof mod.sum).toBe("function");\n' +
    "  expect(mod.sum?.(2, 3)).toBe(5);\n" +
    "});\n";
  const sum = "export function sum(a: number, b: number): number {\n  return a + b;\n}\n";
  const write = (path, content) => ({
    toolCalls: [{ name: "write", arguments: { path, content } }],
  });
  const none = { text: JSON.stringify({ findings: [] }) };
  // One faux model plays every role: spec (explore, contract), test-writer, implementer, then an
  // endless supply of "no findings" for the reviewers and verifier.
  const script = {
    scripts: {
      m: [
        { text: "explored" },
        { text: contract },
        write("tests/sum.test.ts", testSrc),
        { text: "done" },
        write("src/sum.ts", sum),
        { text: "done" },
        ...Array.from({ length: 200 }, () => none),
      ],
    },
  };
  const scriptFile = join(work, "faux.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  const r = run(
    ["run", "--headless", "--repo", repo, "add sum(a, b) to src/sum.ts"],
    { REWIRE_FAUX_SCRIPT: scriptFile },
    repo,
    userEnv,
  );
  const events = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const end = events.find((e) => e.type === "run_end");
  if (r.status !== 0 || end?.status !== "verified") {
    const report = end?.reportPath ? readFileSync(end.reportPath, "utf8") : "(no report)";
    fail(`faux rewire run exited ${r.status} (${end?.status}):\n${r.stderr}\n${report}`);
  }
  if (git("show", `rewire/${end.runId}:src/sum.ts`) !== sum) {
    fail("the verified branch does not hold the implementer's src/sum.ts");
  }
  pass(`faux rewire run is verified (${events.length} events, report ${end.reportPath})`);
}
process.stdout.write("smoke: all checks passed\n");
