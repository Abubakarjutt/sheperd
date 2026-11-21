import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TsPack } from "@rewire/pack-typescript";
import { DEFAULT_POLICY } from "@rewire/policy";
import { type ExecResult, profileFor, SandboxClient } from "@rewire/sandbox";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  auditGate,
  type GateContext,
  gitleaksGate,
  INSTALL_HINTS,
  runGates,
  semgrepGate,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const RULES = join(here, "..", "rules", "semgrep-default.yml");

const dirs: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-agnostic-")));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The binaries are required: a missing one fails this file loudly rather than skipping.
beforeAll(() => {
  for (const [bin, args] of [
    ["semgrep", ["--version"]],
    ["gitleaks", ["version"]],
  ] as const) {
    try {
      execFileSync(bin, [...args], { stdio: "ignore" });
    } catch {
      throw new Error(`${bin} is not installed (required by these tests): ${INSTALL_HINTS[bin]}`);
    }
  }
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const pack = (pm: TsPack["packageManager"] = "npm"): TsPack =>
  ({ packageManager: pm, tsconfig: "tsconfig.json" }) as unknown as TsPack;

type Repo = { root: string; ctx: GateContext };

function makeRepo(
  files: Record<string, string> = { "README.md": "base\n" },
  over: Partial<GateContext> = {},
): Repo {
  const root = tmp();
  git(root, "init", "-q", "-b", "main");
  for (const [p, t] of Object.entries(files)) write(root, p, t);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const scratch = tmp();
  const client = new SandboxClient(profileFor("verify", root, DEFAULT_POLICY, scratch));
  const ctx: GateContext = {
    worktree: root,
    baseRef: "HEAD",
    client,
    registryClient: client,
    pack: pack(),
    policy: DEFAULT_POLICY,
    scratch,
    runId: "r",
    stage: "verify",
    ...over,
  };
  return { root, ctx };
}

// "AKIA" + 16 uppercase chars. Built at runtime so this file is not itself a finding.
const AWS_KEY = `${"AKIA"}${"IOSFODNN7EXAMPLQ"}`;

describe("semgrep rules file", () => {
  test("is valid for semgrep --validate and original/Apache-2.0", () => {
    const out = execFileSync("semgrep", ["--validate", "--config", RULES, "--metrics=off"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBeDefined();
  });
});

describe("semgrep gate", () => {
  test("flags eval of request input in a changed file", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/h.js", "export function h(req) { return eval(req.query.x); }\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("src/h.js");
    const d = r.details as { network: string; rules: string };
    expect(d.network).toBe("deny");
    expect(d.rules).toContain("rewire-original, Apache-2.0");
  });

  test("a clean changed file passes", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/ok.js", "export const add = (a, b) => a + b;\n");
    expect((await semgrepGate.run(ctx)).status).toBe("pass");
  });

  test("no changed files passes with 'no changed files'", async () => {
    const { ctx } = makeRepo();
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no changed files");
  });

  test("a nosemgrep comment does not suppress a finding", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.js", "export const f = (req) => eval(req.body.x); // nosemgrep\n");
    expect((await semgrepGate.run(ctx)).status).toBe("fail");
  });

  test("a filename starting with -- is not interpreted as an option", async () => {
    const { root, ctx } = makeRepo();
    write(root, "--config=evil.js", "export const f = (req) => eval(req.query.x);\n");
    write(root, "evil.yml", "rules: []\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("--config=evil.js");
  });

  test("a file outside the worktree reached through a symlink is not scanned", async () => {
    const outside = tmp();
    write(outside, "x.js", "export const f = (req) => eval(req.query.x);\n");
    const { root, ctx } = makeRepo();
    symlinkSync(join(outside, "x.js"), join(root, "link.js"));
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no changed files");
  });

  test("a semgrep parse error on a scanned file fails and lists the file", async () => {
    const { root, ctx } = makeRepo();
    write(root, "broken.js", "const a = 1;\n");
    const real = ctx.client;
    const stub = {
      exec: async (argv: string[], o: { timeoutMs: number; cwd?: string }): Promise<ExecResult> => {
        if (!argv.some((a) => a.endsWith("semgrep"))) return real.exec(argv, o);
        const out = {
          results: [],
          errors: [
            {
              code: 3,
              level: "warn",
              type: "Syntax error",
              message: "Syntax error at line broken.js:1",
              path: "broken.js",
            },
          ],
        };
        return { exitCode: 0, stdout: JSON.stringify(out), stderr: "", timedOut: false };
      },
    } as unknown as SandboxClient;
    const r = await semgrepGate.run({ ...ctx, client: stub });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("broken.js");
  });

  test("a fatal semgrep error and unparseable output are errors, never pass", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.js", "const a = 1;\n");
    const real = ctx.client;
    const stubWith =
      (res: Partial<ExecResult>) =>
      async (argv: string[], o: { timeoutMs: number; cwd?: string }): Promise<ExecResult> =>
        argv.some((a) => a.endsWith("semgrep"))
          ? { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...res }
          : real.exec(argv, o);
    const fatal = JSON.stringify({
      results: [],
      errors: [{ code: 2, level: "error", type: "Fatal error", message: "boom" }],
    });
    for (const res of [
      { stdout: fatal },
      { stdout: "not json", exitCode: 2 },
      { stdout: "{}" },
      { stdout: "{}", timedOut: true },
    ]) {
      const stub = { exec: stubWith(res) } as unknown as SandboxClient;
      expect((await semgrepGate.run({ ...ctx, client: stub })).status).toBe("error");
    }
  });
});

describe("gitleaks gate", () => {
  test("flags a hardcoded AWS key in the diff, redacted", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/cfg.js", `export const key = "${AWS_KEY}";\n`);
    const r = await gitleaksGate.run(ctx);
    expect(r.status).toBe("fail");
    const text = JSON.stringify(r);
    expect(text).not.toContain(AWS_KEY);
    expect(text).toContain("aws-access-token");
    expect(text).toContain("src/cfg.js");
    expect((r.details as { network: string }).network).toBe("deny");
  });

  test("no changed files passes", async () => {
    const { ctx } = makeRepo();
    const r = await gitleaksGate.run(ctx);
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no changed files");
  });

  test("a clean change passes", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/a.js", "export const a = 1;\n");
    expect((await gitleaksGate.run(ctx)).status).toBe("pass");
  });

  test("ignores a repo .gitleaksignore, .gitleaks.toml and gitleaks:allow", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/cfg.js", `export const key = "${AWS_KEY}";\n`);
    write(root, "src/cfg2.js", `export const key = "${AWS_KEY}"; // gitleaks:allow\n`);
    write(root, ".gitleaksignore", "src/cfg.js:aws-access-token:1\n");
    write(root, ".gitleaks.toml", '[extend]\nuseDefault = true\n[allowlist]\npaths = ["src/.*"]\n');
    const r = await gitleaksGate.run(ctx);
    expect(r.status).toBe("fail");
    const found = (r.details as { findings: { file: string }[] }).findings.map((f) => f.file);
    expect(found).toContain("src/cfg.js");
    expect(found).toContain("src/cfg2.js");
  });

  test("leaves no staged copy of the secret in scratch", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/cfg.js", `export const key = "${AWS_KEY}";\n`);
    await gitleaksGate.run(ctx);
    expect(readdirSync(ctx.scratch)).toEqual([]);
  });
});

describe("missing binaries", () => {
  test("a missing semgrep and gitleaks are errors with install hints", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.js", "const a = 1;\n");
    const bin = tmp();
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      const results = await runGates([semgrepGate, gitleaksGate], ctx);
      expect(results.map((r) => r.status)).toEqual(["error", "error"]);
      expect(results[0]?.summary).toContain(INSTALL_HINTS.semgrep);
      expect(results[1]?.summary).toContain(INSTALL_HINTS.gitleaks);
    } finally {
      process.env.PATH = saved;
    }
    expect(saved?.split(delimiter).length).toBeGreaterThan(0);
  });
});

const NPM_PKG = (deps: Record<string, string> = {}) =>
  JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps }, null, 2);
const NPM_LOCK = (deps: Record<string, string> = {}) =>
  JSON.stringify(
    {
      name: "x",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "x", version: "1.0.0", dependencies: deps },
        ...Object.fromEntries(
          Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v }]),
        ),
      },
    },
    null,
    2,
  );

function registryStub(stdout: string, exitCode = 1, over: Partial<ExecResult> = {}) {
  const calls: string[][] = [];
  const client = {
    exec: async (argv: string[]): Promise<ExecResult> => {
      calls.push(argv);
      return { exitCode, stdout, stderr: "", timedOut: false, ...over };
    },
  } as unknown as SandboxClient;
  return { client, calls };
}

const NPM_CLEAN = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});
const NPM_HIGH = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: { lodash: { name: "lodash", severity: "high", via: [], range: "<4.17.21" } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
});
const PNPM_CRIT = JSON.stringify({
  advisories: { "1": { id: 1, severity: "critical", module_name: "minimist", title: "pp" } },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 } },
});

describe("audit gate", () => {
  test("is skipped when no manifest changed", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "src/a.ts", "export {};\n");
    const { client, calls } = registryStub(NPM_CLEAN);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no dependency changes");
    expect(calls).toEqual([]);
  });

  test("a new dependency missing from the lockfile fails (hallucinated package)", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "package.json", NPM_PKG({ "totally-made-up-pkg": "^1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("totally-made-up-pkg");
  });

  test("a new dependency present in the lockfile passes, via the registry client", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, "package-lock.json", NPM_LOCK({ left: "1.0.0" }));
    const { client, calls } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("pass");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(-2)).toEqual(["audit", "--json"]);
    expect((r.details as { network: string }).network).toBe("registry");
  });

  test("a nested package.json with a missing dependency fails", async () => {
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "package-lock.json": NPM_LOCK(),
      "packages/a/package.json": NPM_PKG(),
    });
    write(root, "packages/a/package.json", NPM_PKG({ ghost: "1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("ghost");
  });

  test("a high npm finding fails", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "package.json", NPM_PKG({ lodash: "^4.0.0" }));
    write(root, "package-lock.json", NPM_LOCK({ lodash: "4.0.0" }));
    const { client } = registryStub(NPM_HIGH, 1);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lodash");
  });

  test("a critical pnpm finding fails", async () => {
    const lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n";
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "pnpm-lock.yaml": lock });
    write(root, "package.json", NPM_PKG({ minimist: "^1.0.0" }));
    write(
      root,
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      minimist:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
    );
    const { client, calls } = registryStub(PNPM_CRIT, 1);
    const r = await auditGate.run({ ...ctx, pack: pack("pnpm"), registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("minimist");
    expect(calls[0]?.slice(-2)).toEqual(["audit", "--json"]);
  });

  test("an unparseable registry response is an error", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, "package-lock.json", NPM_LOCK({ left: "1.0.0" }));
    for (const s of [
      registryStub("<html>502</html>", 1),
      registryStub("{}", 0),
      registryStub(JSON.stringify({ error: { code: "ENOTFOUND", summary: "offline" } }), 1),
      registryStub(NPM_CLEAN, 0, { timedOut: true }),
    ]) {
      const r = await auditGate.run({ ...ctx, registryClient: s.client });
      expect(r.status).toBe("error");
    }
  });

  test("a missing registryClient is an error when an audit is needed", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": NPM_LOCK() });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    const r = await auditGate.run({ ...ctx, registryClient: undefined });
    expect(r.status).toBe("error");
    expect(r.summary).toContain("registry client required for dependency audit");
  });

  test("yarn classic NDJSON with a high advisory fails", async () => {
    const lock = '# yarn lockfile v1\n\nleft@^1.0.0:\n  version "1.0.0"\n';
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "yarn.lock": "# yarn lockfile v1\n",
    });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, "yarn.lock", lock);
    const nd = [
      JSON.stringify({
        type: "auditAdvisory",
        data: { advisory: { severity: "high", module_name: "left", title: "t" } },
      }),
      JSON.stringify({
        type: "auditSummary",
        data: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
      }),
    ].join("\n");
    const { client } = registryStub(nd, 8);
    // yarn need not be installed here: put a stand-in on PATH (the stubbed client never runs it).
    const bin = tmp();
    writeFileSync(join(bin, "yarn"), "#!/bin/sh\n");
    chmodSync(join(bin, "yarn"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${saved}`;
    try {
      const r = await auditGate.run({ ...ctx, pack: pack("yarn"), registryClient: client });
      expect(r.status).toBe("fail");
    } finally {
      process.env.PATH = saved;
    }
  });

  test.skipIf(!process.env.REWIRE_LIVE_AUDIT)(
    "live npm audit through the registry profile",
    async () => {
      const { root, ctx } = makeRepo({
        "package.json": NPM_PKG(),
        "package-lock.json": NPM_LOCK(),
      });
      write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
      const registry = new SandboxClient(
        profileFor("verify-registry", root, DEFAULT_POLICY, ctx.scratch),
      );
      const r = await auditGate.run({ ...ctx, registryClient: registry });
      expect(["pass", "fail", "error"]).toContain(r.status);
    },
  );
});

describe("policy protects scanner config", () => {
  test("gitleaks/semgrep config files are protected globs", () => {
    for (const g of ["**/.gitleaks.toml", "**/.gitleaksignore", "**/.semgrepignore"]) {
      expect(DEFAULT_POLICY.protectedGlobs).toContain(g);
    }
  });
  test("adding .gitleaksignore is config drift", async () => {
    const { root, ctx } = makeRepo();
    write(root, ".gitleaksignore", "x\n");
    const { configDrift } = await import("../src/gates/drift.js");
    const { GateExec } = await import("../src/gates/shared.js");
    const d = await configDrift(ctx, new GateExec(ctx));
    expect(d.map((x) => x.path)).toContain(".gitleaksignore");
  });
});
