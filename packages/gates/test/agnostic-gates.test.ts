import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { gitleaksArgs } from "../src/gates/gitleaks.js";
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
    const home = tmp();
    const out = execFileSync("semgrep", ["--validate", "--config", RULES, "--metrics=off"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home },
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
          paths: { scanned: ["broken.js"] },
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

const EVASION_BAD: Record<string, string> = {
  "eval-global.js": "export const f = (x) => globalThis.eval(x);\n",
  "eval-window.js": "export const f = (x) => window.eval(x);\n",
  "eval-bracket.js": 'export const f = (x) => window["eval"](x);\n',
  "eval-indirect.js": "export const f = (x) => (0, eval)(x);\n",
  "eval-alias.js": "const e = eval;\nexport const f = (x) => e(x);\n",
  "fn-ctor.js": 'export const f = (b) => new Function("a", b);\n',
  "exec-var-template.js":
    'import { exec } from "node:child_process";\nexport function f(dir) { const cmd = `ls \x24{dir}`; exec(cmd); }\n',
  "exec-var-concat.js":
    'import cp from "node:child_process";\nexport function f(dir) { const cmd = "ls " + dir; cp.execSync(cmd); }\n',
  "exec-req.js":
    'import cp from "node:child_process";\nexport function f(req) { const c = req.query.c; cp.exec(c); }\n',
  "sql-var-template.js":
    "export function f(db, id) { const q = `select * from t where id=\x24{id}`; return db.query(q); }\n",
  "sql-var-concat.js":
    'export function f(db, id) { const q = "select * from t where id=" + id; return db.execute(q); }\n',
  "fs-var-join.js":
    'import fs from "node:fs";\nimport path from "node:path";\nexport function f(req) { const p = path.join("/base", req.query.f); return fs.readFileSync(p); }\n',
  "fs-destructure.js":
    'import fs from "node:fs";\nexport function f(req) { const { name } = req.params; return fs.readFileSync(name); }\n',
  "promisify-alias.js":
    'import cp from "node:child_process";\nimport util from "node:util";\nexport async function f(d) { const run = util.promisify(cp.exec); await run(`ls \x24{d}`); }\n',
  "promisify-require.js":
    'export async function f(d) { await require("util").promisify(require("child_process").exec)(`ls \x24{d}`); }\n',
  "promisify-concat.js":
    'import { exec } from "node:child_process";\nimport { promisify } from "node:util";\nexport async function f(d) { const r = promisify(exec); await r("ls " + d); }\n',
  "spawn-shell-template.js":
    'import cp from "node:child_process";\nexport function f(d) { cp.spawn(`ls \x24{d}`, { shell: true }); }\n',
  "spawn-shell-args.js":
    'import { spawn } from "node:child_process";\nexport function f(d) { spawn("ls " + d, [], { shell: true }); }\n',
  "execfile-shell-req.js":
    'import { execFile } from "node:child_process";\nexport function f(req, cb) { execFile(req.query.c, { shell: true }, cb); }\n',
  "spawnsync-shell.js":
    'import cp from "node:child_process";\nexport function f(d) { cp.spawnSync(`ls \x24{d}`, ["x"], { shell: true }); }\n',
  "reflect-eval.js": "export const f = (x) => Reflect.apply(eval, null, [x]);\n",
  "then-callback.js":
    'import { exec } from "node:child_process";\nexport function f(req) { Promise.resolve(req.query.c).then((c) => exec(c)); }\n',
  "then-fs.js":
    'import fs from "node:fs";\nexport function f(req) { Promise.resolve(req.query.p).then((p) => fs.readFileSync(p)); }\n',
  "then-sql.js":
    "export function f(req, db) { Promise.resolve(req.query.q).then((q) => db.query(q)); }\n",
  "shell-var.js":
    'import cp from "node:child_process";\nexport function f(d, opt) { cp.spawn(`ls \x24{d}`, [], { shell: opt }); }\n',
  "shell-string.js":
    'import cp from "node:child_process";\nexport function f(d) { cp.execFile("ls " + d, { shell: "/bin/sh" }, () => 1); }\n',
  "execfile-args-shell.js":
    'import { execFile } from "node:child_process";\nexport function f(req) { execFile("ls", [req.query.x], { shell: true }, () => 1); }\n',
  "settimeout-string.js": 'export const f = () => setTimeout("doit()", 1);\n',
  "setinterval-template.js": "export const f = (d) => setInterval(`run(\x24{d})`, 1);\n",
  "ctor-ctor.js": "export const f = (req) => (() => 1).constructor.constructor(req.query.c)();\n",
  "ctor-destructure.js":
    "export function f(req) { const { constructor: F } = function () {}; return F(req.query.c); }\n",
  "ctor-alias.js":
    "export function f(req) { const F = (function () {}).constructor; return F(req.query.c)(); }\n",
  "html-var.js": "export function f(el, x) { const h = x; el.innerHTML = h; }\n",
  "html-bracket.js": 'export const f = (el, x) => { el["innerHTML"] = x; };\n',
  "vm-var.js": 'import vm from "node:vm";\nexport const f = (x) => vm.runInNewContext(x);\n',
};
const EVASION_OK = `import cp from "node:child_process";
import fs from "node:fs";
export const a = () => eval("1+1");
export const b = () => cp.exec("ls -la");
export const c = () => { const s = "ls"; cp.exec(s); };
export const d = (db) => db.query("select 1");
export const e = (db) => { const q = "select 1"; return db.query(q); };
export const f = () => fs.readFileSync("a.txt");
export const g = (el) => { el.innerHTML = "<b>x</b>"; };
export const width = Math.random();
export const valid = Math.random();
export const h = () => cp.spawn("ls", ["-la", "x"]);
export const i = (dir) => cp.spawn("ls", [dir], { shell: false });
export const j = async (util) => { const run = util.promisify(cp.exec); await run("ls -la"); };
export const k = () => Reflect.apply(eval, null, ["1+1"]);
export const l = (d) => cp.spawn("ls", [d], { shell: false });
export const m = () => setTimeout(() => 1, 10);
export const n = (fn) => setInterval(fn, 10);
export const o = () => cp.execFile("ls", ["-la"], { shell: false }, () => 1);
`;

describe("semgrep ruleset evasion resistance (real semgrep)", () => {
  test("indirect, aliased and variable-carried injections are all flagged", async () => {
    const { root, ctx } = makeRepo();
    for (const [f, t] of Object.entries(EVASION_BAD)) write(root, `bad/${f}`, t);
    write(root, "ok/ok.js", EVASION_OK);
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    const found = new Set(
      (r.details as { findings: { file: string; severity: string }[] }).findings
        .filter((f) => f.severity === "ERROR")
        .map((f) => f.file),
    );
    const missed = Object.keys(EVASION_BAD).filter((f) => !found.has(`bad/${f}`));
    expect(missed).toEqual([]);
    expect(found.has("ok/ok.js")).toBe(false);
    const warned = (r.details as { findings: { file: string }[] }).findings.filter(
      (f) => f.file === "ok/ok.js",
    );
    expect(warned).toEqual([]);
  });

  test("Math.random only warns for whole-word token-like names", async () => {
    const { root, ctx } = makeRepo();
    write(
      root,
      "r.js",
      "export const userId = Math.random();\nexport const sessionToken = Math.random();\nexport const width = Math.random();\nexport const monkey = Math.random();\n",
    );
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("pass");
    const lines = (r.details as { findings: { line: number }[] }).findings.map((f) => f.line);
    expect(lines.sort()).toEqual([1, 2]);
  });
});

describe("semgrep second pass: non-standard extensions", () => {
  const BAD = "export const f = (req) => eval(req.query.x);\n";
  const hit = (r: { details: unknown }, f: string): boolean =>
    (r.details as { findings: { file: string; severity: string }[] }).findings.some(
      (x) => x.file === f && x.severity === "ERROR",
    );

  test("a clean .mts passes and an .mts with eval of req.query fails", async () => {
    const a = makeRepo();
    write(a.root, "ok.mts", "export const ok: number = 1;\n");
    expect((await semgrepGate.run(a.ctx)).status).toBe("pass");
    const b = makeRepo();
    write(b.root, "bad.mts", BAD);
    const r = await semgrepGate.run(b.ctx);
    expect(r.status).toBe("fail");
    expect(hit(r, "bad.mts")).toBe(true);
  });

  test("JS hiding in .txt, an upper-case .JS, .cts and an extensionless node script fails", async () => {
    const { root, ctx } = makeRepo();
    write(root, "payload.txt", "eval(req.query.x)\n");
    write(root, "UP.JS", BAD);
    write(root, "x.cts", BAD);
    write(root, "bin/cli", `#!/usr/bin/env node\n${BAD}`);
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    for (const f of ["payload.txt", "UP.JS", "x.cts", "bin/cli"]) expect(hit(r, f), f).toBe(true);
  });

  test("prose in README.md passes: no PartialParsing failure for non-JS files", async () => {
    const { root, ctx } = makeRepo();
    write(root, "README.md", '# T\n\nSome *prose* (with parens, "quotes" and `code`.\n\n- a\n');
    write(root, "notes.txt", "just words, nothing to see (here\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("pass");
  });

  test("an unparseable node-shebang script and an unparseable .mts fail and are listed", async () => {
    const { root, ctx } = makeRepo();
    write(root, "badcli", "#!/usr/bin/env node\nconst a = (;\n");
    writeFileSync(join(root, "junk.mts"), Buffer.from("00010203ff".repeat(100), "hex"));
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("badcli");
    expect(JSON.stringify(r.details)).toContain("junk.mts");
  });
});

describe("semgrep pass 2 strictness is decided by whether the file compiles", () => {
  test("prose and Makefiles that do not compile as JS pass", async () => {
    const { root, ctx } = makeRepo();
    write(
      root,
      "INSTALL.md",
      "# Install\n\nThen document.write(out) to show it.\n\nrun (the thing\n",
    );
    write(root, "Makefile", "all:\n\teval $(shell cat env)\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("pass");
  });

  test("helper.txt holding valid JS that evals req.query fails", async () => {
    const { root, ctx } = makeRepo();
    write(root, "helper.txt", "const x = 1;\neval(req.query.x);\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
  });

  test("a BOM before a node shebang, and tsx/bun/deno shebangs, are strict", async () => {
    for (const sh of [
      "#!/usr/bin/env node",
      "#!/usr/bin/env tsx",
      "#!/usr/bin/env bun",
      "#!/usr/bin/env -S deno run",
    ]) {
      const { root, ctx } = makeRepo();
      writeFileSync(join(root, "cli"), `\ufeff${sh}\nconst a = (;\n`);
      const r = await semgrepGate.run(ctx);
      expect(r.status, sh).toBe("fail");
      expect(JSON.stringify(r.details), sh).toContain("cli");
    }
  });

  test("a module-syntax .txt with eval of req.query fails", async () => {
    const { root, ctx } = makeRepo();
    write(root, "mod.txt", "import fs from 'fs';\nexport const f = (req) => eval(req.query.x);\n");
    expect((await semgrepGate.run(ctx)).status).toBe("fail");
  });
});

describe("semgrep pass 2 mirrors the CommonJS loader (R28)", () => {
  test("a .txt that only compiles as a CommonJS function body (top-level return) fails", async () => {
    const { root, ctx } = makeRepo();
    write(root, "ret.txt", "module.exports = (req) => eval(req.query.x);\nif (!module) return;\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("ret.txt");
  });

  test("an extensionless file using new.target (function-body only) fails", async () => {
    const { root, ctx } = makeRepo();
    write(root, "lib/helper", "if (new.target) {}\nmodule.exports = (req) => eval(req.query.x);\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lib/helper");
  });

  test("INSTALL.md and a Makefile still pass", async () => {
    const { root, ctx } = makeRepo();
    write(
      root,
      "INSTALL.md",
      "# Install\n\nThen document.write(out) to show it.\n\nrun (the thing\n",
    );
    write(root, "Makefile", "all:\n\teval $(shell cat env)\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("pass");
  });
});

describe("semgrep pass 2 classifies ES modules like node's require(esm) (R32)", () => {
  const listed = (r: { details: unknown }, f: string): boolean => {
    const d = r.details as {
      findings: { file: string; severity: string }[];
      problemFiles: { file: string }[];
    };
    return (
      d.findings.some((x) => x.file === f && x.severity === "ERROR") ||
      d.problemFiles.some((x) => x.file === f)
    );
  };
  const PAYLOAD = "globalThis.pwn = (q) => eval(q);\n";
  const MODULES: Record<string, string> = {
    "esm6.txt": "const h = (req) => eval(req.query.x);export{h as default};\n",
    "e1.txt": `${PAYLOAD}export{};\n`,
    "e2.txt": "globalThis.pwn = (q) => eval(q);; export default 1;\n",
    "e3.txt": `/* c */ export const z = 1;\n${PAYLOAD}`,
    "e4.txt": `${PAYLOAD}export\n{};\n`,
    "e5.txt": `${PAYLOAD};import fs from "fs";\n`,
    "lib/meta": `const u = import.meta.url;\nmodule.exports = (req) => eval(req.query.x);\n`,
    "im3.txt": `${PAYLOAD}import.meta.dirname;\n`,
    "tla.txt": `${PAYLOAD}await 0;\n`,
    "redecl.txt": `const module = 1;\n${PAYLOAD}`,
  };

  test("module-syntax files node would load are scanned and fail", async () => {
    const { root, ctx } = makeRepo();
    for (const [f, t] of Object.entries(MODULES)) write(root, f, t);
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    const missed = Object.keys(MODULES).filter((f) => !listed(r, f));
    expect(missed, JSON.stringify(r.details)).toEqual([]);
  });

  test("prose with an `import this from that` line, INSTALL.md and a Makefile pass", async () => {
    const { root, ctx } = makeRepo();
    write(root, "notes.md", "# Notes\n\nimport this from that\nexport the data later\n");
    write(
      root,
      "INSTALL.md",
      "# Install\n\nThen document.write(out) to show it.\n\nrun (the thing\n",
    );
    write(root, "Makefile", "all:\n\teval $(shell cat env)\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status, JSON.stringify(r.details)).toBe("pass");
  });

  test("if the module-parse child fails, every candidate is scanned strictly", async () => {
    const { root, ctx } = makeRepo();
    write(root, "notes.md", "# Notes\n\nimport this from that\n");
    const real = ctx.client;
    const client = {
      exec: (argv: string[], opts: unknown) =>
        argv.includes("--experimental-vm-modules")
          ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false })
          : real.exec(argv, opts as Parameters<SandboxClient["exec"]>[1]),
    } as unknown as SandboxClient;
    const r = await semgrepGate.run({ ...ctx, client });
    expect(r.status, JSON.stringify(r.details)).toBe("fail");
    expect(listed(r, "notes.md")).toBe(true);
    const garbled = {
      exec: (argv: string[], opts: unknown) =>
        argv.includes("--experimental-vm-modules")
          ? Promise.resolve({ exitCode: 0, stdout: "{not json", stderr: "", timedOut: false })
          : real.exec(argv, opts as Parameters<SandboxClient["exec"]>[1]),
    } as unknown as SandboxClient;
    expect((await semgrepGate.run({ ...ctx, client: garbled })).status).toBe("fail");
  });
});

describe("semgrep fail-closed on skipped and errored files", () => {
  const stubSemgrep = (ctx: GateContext, out: unknown, exitCode = 0): GateContext => {
    const real = ctx.client;
    const client = {
      exec: async (argv: string[], o: { timeoutMs: number; cwd?: string }): Promise<ExecResult> =>
        argv.some((a) => a.endsWith("semgrep"))
          ? { exitCode, stdout: JSON.stringify(out), stderr: "", timedOut: false }
          : real.exec(argv, o),
    } as unknown as SandboxClient;
    return { ...ctx, client };
  };

  test("real semgrep: a file that cannot be parsed fails and is listed", async () => {
    const { root, ctx } = makeRepo();
    writeFileSync(join(root, "junk.js"), Buffer.from("00010203ff".repeat(100), "hex"));
    write(root, "fine.js", "export const a = 1;\n");
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("junk.js");
    expect(JSON.stringify(r.details)).not.toContain("fine.js");
  });

  test("real semgrep: a file that makes a rule time out fails and is listed", async () => {
    const { root, ctx } = makeRepo();
    write(root, "slow.js", `var a=${"a+".repeat(50000)}1;`);
    const r = await semgrepGate.run(ctx);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("slow.js");
    expect(JSON.stringify(r.details)).toContain("Timeout");
  }, 120_000);

  test("a changed JS file missing from paths.scanned fails; non-JS files are ignored", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "notes.txt", "hello there, plain prose (not code\n");
    const out = { results: [], errors: [], paths: { scanned: [] } };
    const r = await semgrepGate.run(stubSemgrep(ctx, out));
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("a.ts");
    expect(JSON.stringify(r.details)).not.toContain("notes.txt");
    const ok = await semgrepGate.run(
      stubSemgrep(ctx, { results: [], errors: [], paths: { scanned: ["a.ts"] } }),
    );
    expect(ok.status).toBe("pass");
  });

  test("timeouts, OOM, too-many-matches and any error on a changed file fail with the file", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.js", "export const a = 1;\n");
    const paths = { scanned: ["a.js"] };
    for (const type of ["Timeout", "OutOfMemory", "TooManyMatches", "Other weird thing"]) {
      const out = { results: [], paths, errors: [{ level: "warn", type, path: "a.js" }] };
      const r = await semgrepGate.run(stubSemgrep(ctx, out));
      expect(r.status, type).toBe("fail");
      expect(JSON.stringify(r.details)).toContain("a.js");
    }
  });

  test("an unknown pathless warning is an error; only allowlisted warnings pass", async () => {
    const { root, ctx } = makeRepo();
    write(root, "a.js", "export const a = 1;\n");
    const paths = { scanned: ["a.js"] };
    const unknown = { results: [], paths, errors: [{ level: "warn", type: "Mystery" }] };
    expect((await semgrepGate.run(stubSemgrep(ctx, unknown))).status).toBe("error");
    const benign = {
      results: [],
      paths,
      errors: [{ level: "warn", type: "DeprecationWarning", message: "deprecated flag" }],
    };
    expect((await semgrepGate.run(stubSemgrep(ctx, benign))).status).toBe("pass");
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

  test("a .gitleaksignore in the scan root suppresses even with -i, so staging must never copy it", () => {
    // gitleaks 8.30 reads <scan root>/.gitleaksignore regardless of --gitleaks-ignore-path. The
    // gate is safe because it never stages ignore/config files; this pins the reason.
    const dir = tmp();
    write(dir, "files/src/cfg.js", `export const key = "${AWS_KEY}";\n`);
    const noIgnore = join(dir, "no-ignore");
    mkdirSync(noIgnore);
    const cfg = join(dir, "c.toml");
    writeFileSync(cfg, "[extend]\nuseDefault = true\n");
    const argv = gitleaksArgs({
      gitleaks: "gitleaks",
      config: cfg,
      noIgnore,
      report: join(dir, "r.json"),
    }).slice(1);
    const run = (): number => {
      try {
        execFileSync("gitleaks", argv, { cwd: join(dir, "files"), stdio: "ignore" });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(run()).toBe(1);
    write(dir, "files/.gitleaksignore", "src/cfg.js:aws-access-token:1\n");
    expect(run()).toBe(0);
  });

  test("a repo ignore file with the exact relative fingerprint does not hide the finding", async () => {
    const { root, ctx } = makeRepo();
    write(root, "src/cfg.js", `export const key = "${AWS_KEY}";\n`);
    write(root, ".gitleaksignore", "src/cfg.js:aws-access-token:1\n");
    const r = await gitleaksGate.run(ctx);
    expect(r.status).toBe("fail");
    const f = (r.details as { findings: { file: string; line: number }[] }).findings;
    expect(f[0]?.file).toBe("src/cfg.js");
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

const NPM_BASE = {
  "package.json": NPM_PKG(),
  "package-lock.json": NPM_LOCK({ left: "1.0.0" }),
};
const PNPM_LOCK_WITH = (name: string) =>
  `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ${name}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`;

function withPath<T>(dirs: string[], f: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = [...dirs, saved].join(delimiter);
  return f().finally(() => {
    process.env.PATH = saved;
  });
}
function shimDir(name: string, body: string): string {
  const d = tmp();
  writeFileSync(join(d, name), body);
  chmodSync(join(d, name), 0o755);
  return d;
}

describe("audit gate", () => {
  test("is skipped when no manifest changed", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "src/a.ts", "export {};\n");
    const { client, calls } = registryStub(NPM_CLEAN);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("no dependency changes");
    expect(calls).toEqual([]);
    expect((r.details as { network: string }).network).toBe("registry");
  });

  test("a new dependency missing from the baseRef lockfile fails (hallucinated package)", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ "totally-made-up-pkg": "^1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("totally-made-up-pkg");
  });

  test("a dependency present in the baseRef lockfile passes, audited in an isolated copy", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, ".npmrc", "registry=https://evil.example/\n");
    write(root, ".pnpmfile.cjs", "module.exports = {};\n");
    const seen: { argv: string[]; files: string[] }[] = [];
    const client = {
      exec: async (argv: string[]): Promise<ExecResult> => {
        const i = argv.indexOf("--prefix");
        seen.push({ argv, files: i >= 0 ? readdirSync(argv[i + 1] as string).sort() : [] });
        return { exitCode: 0, stdout: NPM_CLEAN, stderr: "", timedOut: false };
      },
    } as unknown as SandboxClient;
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("pass");
    expect(seen).toHaveLength(1);
    const argv = seen[0]?.argv ?? [];
    expect(argv[0]).toBe("/usr/bin/env");
    const prefix = argv[argv.indexOf("--prefix") + 1] as string;
    expect(prefix.startsWith(root)).toBe(false);
    expect(prefix.startsWith(ctx.scratch)).toBe(true);
    expect(seen[0]?.files).toEqual(["package-lock.json", "package.json"]);
    expect(argv.slice(-2)).toEqual(["audit", "--json"]);
    for (const e of [
      "npm_config_ignore_scripts=true",
      "COREPACK_ENABLE_NETWORK=0",
      "COREPACK_ENABLE_STRICT=0",
      "npm_config_registry=https://registry.npmjs.org/",
    ]) {
      expect(argv).toContain(e);
    }
    for (const k of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "npm_config_cache",
      "npm_config_userconfig",
    ]) {
      const kv = argv.find((a) => a.startsWith(`${k}=`));
      expect(kv?.slice(k.length + 1).startsWith(ctx.scratch), k).toBe(true);
    }
    expect((r.details as { network: string }).network).toBe("registry");
    expect(readdirSync(ctx.scratch)).toEqual([]);
  });

  test("a nested package.json with a missing dependency fails", async () => {
    const { root, ctx } = makeRepo({ ...NPM_BASE, "packages/a/package.json": NPM_PKG() });
    write(root, "packages/a/package.json", NPM_PKG({ ghost: "1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("ghost");
  });

  test("any lockfile change versus baseRef fails as protected", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, "package-lock.json", NPM_LOCK({ left: "1.0.0", extra: "1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lockfile changed (protected)");
  });

  test("a root npm-shrinkwrap.json cannot launder a hallucinated dependency", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ ghost: "^1.0.0" }));
    write(root, "npm-shrinkwrap.json", NPM_LOCK({ ghost: "1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("npm-shrinkwrap.json");
    expect(JSON.stringify(r.details)).toContain("ghost");
  });

  test("a nested npm-shrinkwrap.json cannot launder a hallucinated dependency", async () => {
    const { root, ctx } = makeRepo({ ...NPM_BASE, "packages/a/package.json": NPM_PKG() });
    write(root, "packages/a/package.json", NPM_PKG({ ghost: "1.0.0" }));
    write(root, "packages/a/npm-shrinkwrap.json", NPM_LOCK({ ghost: "1.0.0" }));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("packages/a/npm-shrinkwrap.json");
    expect(JSON.stringify(r.details)).toContain("ghost");
  });

  test("a high npm finding fails", async () => {
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "package-lock.json": NPM_LOCK({ lodash: "4.0.0" }),
    });
    write(root, "package.json", NPM_PKG({ lodash: "^4.0.0" }));
    const { client } = registryStub(NPM_HIGH, 1);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lodash");
  });

  test("a critical pnpm finding fails, with pnpmfile loading disabled", async () => {
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "pnpm-lock.yaml": PNPM_LOCK_WITH("minimist"),
    });
    write(root, "package.json", NPM_PKG({ minimist: "^1.0.0" }));
    const { client, calls } = registryStub(PNPM_CRIT, 1);
    const r = await auditGate.run({ ...ctx, pack: pack("pnpm"), registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("minimist");
    expect(calls[0]).toContain("--ignore-pnpmfile");
    expect(calls[0]).toContain("-C");
    expect(calls[0]).toContain("audit");
  });

  test("an unparseable registry response is an error", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
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
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    const r = await auditGate.run({ ...ctx, registryClient: undefined });
    expect(r.status).toBe("error");
    expect(r.summary).toContain("registry client required for dependency audit");
    expect((r.details as { network: string }).network).toBe("registry");
  });

  test("yarn classic NDJSON with a high advisory fails", async () => {
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "yarn.lock": '# yarn lockfile v1\n\nleft@^1.0.0:\n  version "1.0.0"\n',
    });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
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
    const { client, calls } = registryStub(nd, 8);
    const bin = shimDir("yarn", "#!/bin/sh\nexit 0\n");
    const r = await withPath([bin], () =>
      auditGate.run({ ...ctx, pack: pack("yarn"), registryClient: client }),
    );
    expect(r.status).toBe("fail");
    expect(calls[0]).toContain("--cwd");
    expect(calls[0]).toContain("YARN_IGNORE_SCRIPTS=true");
  });

  test("every distinct covering lockfile directory with a changed manifest is audited", async () => {
    const { root, ctx } = makeRepo({
      ...NPM_BASE,
      "tools/b/package.json": NPM_PKG(),
      "tools/b/package-lock.json": NPM_LOCK({ lodash: "4.0.0" }),
    });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    write(root, "tools/b/package.json", NPM_PKG({ lodash: "^4.0.0" }));
    const prefixes: string[] = [];
    const client = {
      exec: async (argv: string[]): Promise<ExecResult> => {
        const prefix = argv[argv.indexOf("--prefix") + 1] as string;
        prefixes.push(prefix);
        const bad = readFileSync(join(prefix, "package.json"), "utf8").includes("lodash");
        return { exitCode: 1, stdout: bad ? NPM_HIGH : NPM_CLEAN, stderr: "", timedOut: false };
      },
    } as unknown as SandboxClient;
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(prefixes).toHaveLength(2);
    expect(new Set(prefixes).size).toBe(2);
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lodash");
    expect(JSON.stringify(r.details)).toContain("tools/b");
  });

  test("a deleted lockfile fails as protected", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    rmSync(join(root, "package-lock.json"));
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("lockfile changed (protected)");
  });

  test("a problem found by the gate wins over an audit error", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ ghost: "^1.0.0" }));
    const { client } = registryStub("<html>502</html>", 1);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("fail");
    expect(JSON.stringify(r.details)).toContain("ghost");
    expect(JSON.stringify(r.details)).toContain("audit output unusable");
  });

  test("the copied package.json drops packageManager/devEngines and corepack downloads are off", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    const j = JSON.parse(NPM_PKG({ left: "^1.0.0" })) as Record<string, unknown>;
    j.packageManager = "npm@99.0.0";
    j.devEngines = { packageManager: { name: "npm", version: "99.0.0" } };
    write(root, "package.json", JSON.stringify(j));
    let copied = "";
    let argv: string[] = [];
    const client = {
      exec: async (a: string[]): Promise<ExecResult> => {
        argv = a;
        copied = readFileSync(join(a[a.indexOf("--prefix") + 1] as string, "package.json"), "utf8");
        return { exitCode: 0, stdout: NPM_CLEAN, stderr: "", timedOut: false };
      },
    } as unknown as SandboxClient;
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).toBe("pass");
    expect(copied).not.toContain("packageManager");
    expect(copied).not.toContain("devEngines");
    expect(copied).toContain("left");
    expect(argv).toContain("npm_config_manage_package_manager_versions=false");
  });

  test("an unparseable package.json fails closed instead of being copied verbatim", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", '{"dependencies": {"left": "^1.0.0"}, "packageManager": "npm@99"');
    const { client } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status).not.toBe("pass");
  });

  test("an unparseable worktree manifest is an error and never falls back to the baseRef copy", async () => {
    const { root, ctx } = makeRepo({
      "package.json": NPM_PKG(),
      "package-lock.json": NPM_LOCK({ left: "1.0.0" }),
      "pkgs/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
    });
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    // a sibling manifest git does not report as changed, so only the copy step reads it
    write(root, "pkgs/a/package.json", '{"name": "a", "packageManager": "npm@99"');
    git(root, "update-index", "--skip-worktree", "pkgs/a/package.json");
    const { client, calls } = registryStub(NPM_CLEAN, 0);
    const r = await auditGate.run({ ...ctx, registryClient: client });
    expect(r.status, JSON.stringify(r)).toBe("error");
    expect(calls).toEqual([]);
  });

  test("a corepack shim for the package manager is refused", async () => {
    const { root, ctx } = makeRepo(NPM_BASE);
    write(root, "package.json", NPM_PKG({ left: "^1.0.0" }));
    const { client, calls } = registryStub(NPM_CLEAN, 0);
    const bin = shimDir("npm", '#!/usr/bin/env node\nrequire("corepack").runMain(["npm"]);\n');
    const r = await withPath([bin], () => auditGate.run({ ...ctx, registryClient: client }));
    expect(r.status).toBe("error");
    expect(r.summary).toContain("corepack shims are refused");
    expect(calls).toEqual([]);
    const dir = join(tmp(), "corepack", "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pnpm"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "pnpm"), 0o755);
    const r2 = await withPath([dir], () =>
      auditGate.run({ ...ctx, pack: pack("pnpm"), registryClient: client }),
    );
    expect(r2.status).toBe("error");
    expect(r2.summary).toContain("corepack shims are refused");
  });

  test.skipIf(!process.env.REWIRE_LIVE_AUDIT)(
    "live npm audit through the registry profile passes for a clean minimal lockfile",
    async () => {
      const lock = JSON.stringify({
        name: "x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "x", version: "1.0.0" } },
      });
      const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), "package-lock.json": lock });
      write(root, "package.json", JSON.stringify({ name: "x", version: "1.0.1" }));
      const registry = new SandboxClient(
        profileFor("verify-registry", root, DEFAULT_POLICY, ctx.scratch),
      );
      const r = await auditGate.run({ ...ctx, registryClient: registry });
      expect(r.status, JSON.stringify(r)).toBe("pass");
    },
  );
});

describe("policy protects scanner config", () => {
  test("scanner, lockfile and package-manager config files are protected globs", () => {
    for (const g of [
      "**/.gitleaks.toml",
      "**/.gitleaksignore",
      "**/.semgrepignore",
      "**/npm-shrinkwrap.json",
      "**/.pnpmfile.cjs",
      "**/.pnpmfile.mjs",
      "**/.pnpmfile.js",
      "**/.yarn/**",
      "**/.tool-versions",
      "**/mise.toml",
      "**/.mise.toml",
      "**/mise.local.toml",
      "**/.mise.local.toml",
      "**/.config/mise.toml",
      "**/.config/mise/**",
      "**/.mise/**",
      "**/.nvmrc",
      "**/.node-version",
    ]) {
      expect(DEFAULT_POLICY.protectedGlobs).toContain(g);
    }
    expect(DEFAULT_POLICY.credentialDenyGlobs).toContain("~/.npmrc");
  });
  test("version-manager files (.nvmrc, .tool-versions, mise.toml) are config drift", async () => {
    const { configDrift } = await import("../src/gates/drift.js");
    const { GateExec } = await import("../src/gates/shared.js");
    for (const f of [
      ".nvmrc",
      ".node-version",
      ".tool-versions",
      "mise.toml",
      ".mise.toml",
      "sub/.mise/config.toml",
    ]) {
      const { root, ctx } = makeRepo({ "package.json": NPM_PKG(), [f]: "1\n" });
      write(root, f, "2\n");
      const d = await configDrift(ctx, new GateExec(ctx));
      expect(
        d.map((x) => x.path),
        f,
      ).toContain(f);
    }
  });
  test("volta changes are config drift", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG() });
    const j = JSON.parse(NPM_PKG()) as Record<string, unknown>;
    j.volta = { node: "99.0.0" };
    write(root, "package.json", JSON.stringify(j));
    const { configDrift } = await import("../src/gates/drift.js");
    const { GateExec } = await import("../src/gates/shared.js");
    const d = await configDrift(ctx, new GateExec(ctx));
    expect(d.map((x) => x.path)).toContain("package.json");
  });
  test("packageManager and devEngines changes are config drift", async () => {
    const { root, ctx } = makeRepo({ "package.json": NPM_PKG() });
    const j = JSON.parse(NPM_PKG()) as Record<string, unknown>;
    j.packageManager = "pnpm@9.0.0";
    write(root, "package.json", JSON.stringify(j));
    const { configDrift } = await import("../src/gates/drift.js");
    const { GateExec } = await import("../src/gates/shared.js");
    const d = await configDrift(ctx, new GateExec(ctx));
    expect(d.map((x) => x.path)).toContain("package.json");
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
