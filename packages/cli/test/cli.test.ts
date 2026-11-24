import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  cpSync,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunEvent } from "@rewire/core";
import { platformPackageName, sandboxAvailable as sandboxIsAvailable } from "@rewire/sandbox";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { exitCodeFor } from "../src/exit.js";
import { loadFauxScript } from "../src/faux.js";
import { discoverModels } from "../src/models.js";
import {
  escalationDetail,
  escalationHint,
  finalLine,
  renderEvent,
} from "../src/render-interactive.js";
import { markFauxReport, providerFactory, runCommand } from "../src/run.js";
import { sanitize } from "../src/sanitize.js";
import { installSigint } from "../src/sigint.js";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(here, "../dist/main.js");
const SECRET = `sk-${"A".repeat(30)}`;

// Throws (failing the file) instead of skipping when REWIRE_REQUIRE_SANDBOX=1 (CI, R40).
const sandboxAvailable = sandboxIsAvailable();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-cli-")));
  dirs.push(d);
  return d;
};

const FIXTURE = resolve(here, "../../pipeline/test/fixtures/sum-lib");
const WORKSPACE_MODULES = resolve(here, "../../../node_modules");

function makeRepo(): string {
  const root = tmp();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".rewire/\nnode_modules\n*.log\n");
  symlinkSync(WORKSPACE_MODULES, join(root, "node_modules"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

/** Child env without the test-runner markers, so test-only overrides are off unless set. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.NODE_ENV;
  delete env.REWIRE_PLATFORM_OVERRIDE;
  delete env.REWIRE_FAUX_SCRIPT;
  delete env.REWIRE_ANTHROPIC_MODEL;
  delete env.REWIRE_OPENAI_MODEL;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  const home = tmp();
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

type Done = { code: number | null; stdout: string; stderr: string };
function start(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): [ChildProcess, Promise<Done>] {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
  });
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  children.push(child);
  const done = new Promise<Done>((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
  return [child, done];
}
async function exec(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Done> {
  const [child, done] = start(args, env, cwd);
  child.stdin?.end();
  return done;
}

const contract = (openQuestions: string[] = []) =>
  JSON.stringify({
    id: "c1",
    title: "t",
    criteria: [{ id: "x", statement: "does a thing" }],
    nonGoals: [],
    affectedAreas: [],
    openQuestions,
  });

function writeScript(scripts: Record<string, unknown[]>): string {
  const f = join(tmp(), "faux.json");
  writeFileSync(f, JSON.stringify({ scripts }));
  return f;
}

describe("sanitize (#23)", () => {
  test("strips ANSI, C0 and C1 controls except newline, and redacts secrets", () => {
    const out = sanitize(`a\x1b[2Jb\x07c\x9bd\x1b]0;evil\x07e\nf ${SECRET}`);
    expect(out).toBe("abcde\nf [redacted]");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain(SECRET);
    expect(out).toContain("\n");
  });
});

describe("sanitize bidi", () => {
  test("strips bidi and zero-width characters", () => {
    expect(sanitize("a\u202eb\u200bc\u2066d\ufeffe\u200f")).toBe("abcde");
  });
});

describe("escalation hints use the orchestrator's real strings", () => {
  const out = (details: string[], unresolved: unknown[] = []) =>
    ({
      runId: "r",
      status: "escalated",
      branch: "",
      worktree: "",
      reportPath: "",
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved,
        hypothesis: "",
        question: "",
        details,
      },
    }) as never;
  // orchestrator.ts: `node_modules is in the index before the final commit: <paths>`
  test("tracked node_modules", () => {
    const h = escalationHint(
      out(["node_modules is in the index before the final commit: node_modules/a.js"]),
    );
    expect(h).toMatch(/repos that commit node_modules are unsupported in v0\.1/);
  });
  // orchestrator.ts: TAMPERED = "node_modules link tampered" (also `${TAMPERED} before the final commit`)
  test("tampered node_modules", () => {
    const h = escalationHint(out(["node_modules link tampered before the final commit"]));
    expect(h).toMatch(/the agent modified node_modules; the run was rejected/);
    const g = escalationHint(
      out(
        [],
        [{ gate: "tsc", status: "error", category: "x", summary: "node_modules link tampered" }],
      ),
    );
    expect(g).toMatch(/agent modified node_modules/);
  });
  test("unrelated text gets no hint", () => {
    expect(escalationHint(out(["tracked file changed"]))).toBeUndefined();
  });
  test("details are capped at 10 with a remainder line", () => {
    const lines = escalationDetail(out(Array.from({ length: 13 }, (_, i) => `d${i}`)));
    expect(lines.filter((l) => l.startsWith("  d"))).toHaveLength(10);
    expect(lines.join("\n")).toContain("… 3 more");
  });
});

describe("faux mode is exclusive", () => {
  test("provider factory never reaches a real provider", () => {
    const f = providerFactory({ ANTHROPIC_API_KEY: "x" }, { scripts: { m: [] } });
    expect(() => f({ provider: "anthropic", model: "m" })).toThrow(/faux/);
    expect(f({ provider: "faux", model: "m" })).toBeDefined();
  });
  test("markFauxReport surfaces append failures", async () => {
    await expect(
      markFauxReport("/x/report.md", async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow(/disk full/);
  });
});

describe("interactive rendering", () => {
  const base = { runId: "r1", ts: "2026-01-01T00:00:00.000Z" };
  test("a finding with escape codes and a secret prints neither", () => {
    const line = renderEvent({
      ...base,
      type: "finding",
      stage: "review",
      finding: {
        id: "f1",
        reviewer: "x",
        category: "unnecessary-abstraction" as never,
        severity: 2,
        file: "a.ts",
        lineStart: 1,
        lineEnd: 1,
        evidence: `bad \x1b[2J title ${SECRET}\nsecond line`,
        failureScenario: "s",
        confidence: 0.9,
        suggestedFix: "",
      },
    });
    expect(line).toBeDefined();
    expect(line).not.toContain("\x1b");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("\n");
    expect(line?.startsWith("● ")).toBe(true);
  });
  test("stage and gate lines", () => {
    expect(renderEvent({ ...base, type: "stage_start", stage: "spec" })).toBe("▶ spec");
    const gate = (status: "pass" | "fail") =>
      renderEvent({
        ...base,
        type: "gate_result",
        stage: "gates",
        result: { gate: "tsc", status, category: "build" as never, summary: "ok" } as never,
      });
    expect(gate("pass")).toMatch(/^✓ tsc/);
    expect(gate("fail")).toMatch(/^✗ tsc/);
  });
  test("escalation text is sanitized and one line", () => {
    const out = finalLine({
      runId: "r",
      status: "escalated",
      branch: "",
      worktree: "",
      reportPath: "/x/report.md",
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved: [],
        hypothesis: "h",
        question: "q",
        details: [`\x1b[31mboom ${SECRET}\nmore`],
      },
    });
    expect(out).toContain("escalated (stage_error)");
    expect(out).toContain("/x/report.md");
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain(SECRET);
  });
  test("preflight escalation has no path", () => {
    const out = finalLine({
      runId: "r",
      status: "escalated",
      branch: "",
      worktree: "",
      reportPath: "",
      escalation: {
        reason: "stage_error",
        tried: [],
        unresolved: [],
        hypothesis: "",
        question: "",
        details: ["x"],
      },
    });
    expect(out).toBe("escalated (stage_error)");
  });
  test("verified line", () => {
    expect(
      finalLine({
        runId: "r",
        status: "verified",
        branch: "rewire/x",
        worktree: "",
        reportPath: "/r.md",
      }),
    ).toBe("verified → branch rewire/x, report /r.md");
  });
});

describe("exit codes", () => {
  const o = (status: string) => ({ status }) as never;
  test("0 only for verified; 2 for escalated; never 0 for unknown", () => {
    expect(exitCodeFor(o("verified"))).toBe(0);
    expect(exitCodeFor(o("escalated"))).toBe(2);
    expect(exitCodeFor(o("weird"))).toBe(1);
  });
});

describe("SIGINT handler", () => {
  test("first aborts, second exits 130", () => {
    const handlers: Array<() => void> = [];
    const aborts: number[] = [];
    const exits: number[] = [];
    installSigint({
      on: (h) => handlers.push(h),
      abort: () => aborts.push(1),
      exit: (c) => exits.push(c),
    });
    expect(handlers).toHaveLength(1);
    handlers[0]?.();
    expect(aborts).toEqual([1]);
    expect(exits).toEqual([]);
    handlers[0]?.();
    expect(exits).toEqual([130]);
  });
});

describe("faux script file", () => {
  test("rejects oversize and invalid files", () => {
    const big = join(tmp(), "big.json");
    writeFileSync(big, `{"scripts":{"a":[]},"pad":"${"x".repeat(1024 * 1024)}"}`);
    expect(() => loadFauxScript(big)).toThrow(/larger than/);
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, '{"scripts":{"a":[{"text":5}]}}');
    expect(() => loadFauxScript(bad)).toThrow(/invalid faux script/);
  });
  test("parses a valid script", () => {
    const f = writeScript({ m: [{ text: "hi" }] });
    expect(loadFauxScript(f).scripts.m).toHaveLength(1);
  });
});

describe("model discovery", () => {
  test("uses API key presence, never printing values, then ollama", async () => {
    const r = await discoverModels(
      { ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: "k2" },
      async () => {
        throw new Error("no net");
      },
    );
    expect(r.map((m) => m.provider)).toEqual(["anthropic", "openai"]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  test("defaults and env overrides", async () => {
    const down = async () => {
      throw new Error("down");
    };
    const d = await discoverModels({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }, down);
    expect(d).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "openai", model: "gpt-5" },
    ]);
    const o = await discoverModels(
      { ANTHROPIC_API_KEY: "k", REWIRE_ANTHROPIC_MODEL: "claude-x-1" },
      down,
    );
    expect(o[0]?.model).toBe("claude-x-1");
    await expect(
      discoverModels({ ANTHROPIC_API_KEY: "k", REWIRE_ANTHROPIC_MODEL: "bad\x1b[2J model" }, down),
    ).rejects.toMatchObject({ code: "model_override_invalid" });
  });
  test("falls back to the first tagged ollama model", async () => {
    const urls: string[] = [];
    const r = await discoverModels({}, async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }, { name: "b" }] }),
      );
    });
    expect(r).toEqual([{ provider: "ollama", model: "qwen2.5-coder:7b" }]);
    expect(urls[0]).toBe("http://127.0.0.1:11434/api/tags");
  });
  test("no models throws a RewireError with a hint", async () => {
    await expect(
      discoverModels({}, async () => {
        throw new Error("down");
      }),
    ).rejects.toMatchObject({ code: "no_models_available", hint: expect.any(String) });
  });
});

describe("process", () => {
  test("windows platform refuses (both commands)", async () => {
    for (const cmd of [["run", "x"], ["doctor"]]) {
      const r = await exec(cmd, cleanEnv({ NODE_ENV: "test", REWIRE_PLATFORM_OVERRIDE: "win32" }));
      expect(r.code).toBe(1);
      expect(r.stderr.trim()).toBe("rewire v0.1 requires macOS or Linux");
    }
  });

  test("platform override is ignored outside tests", async () => {
    const r = await exec(["doctor"], cleanEnv({ REWIRE_PLATFORM_OVERRIDE: "win32" }));
    expect(r.stderr).not.toContain("requires macOS or Linux");
  });

  test("doctor reports missing semgrep with hint", async () => {
    const bin = tmp();
    for (const b of ["git", "rg", "gitleaks"]) {
      writeFileSync(join(bin, b), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const r = await exec(["doctor"], cleanEnv({ PATH: bin }));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ semgrep.*brew install semgrep/);
    expect(r.stdout).toMatch(/✓ git/);
    expect(r.stdout).toMatch(/✓ rg/);
  });

  // I1: doctor reports the run's own lookup, including where the binary came from.
  test("doctor names the source of the sandbox binary (REWIRE_SANDBOX_BIN)", async () => {
    const d = tmp();
    const bin = join(d, "rewire-sandbox");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = await exec(["doctor"], cleanEnv({ PATH: d, REWIRE_SANDBOX_BIN: bin }));
    expect(r.stdout).toContain(`✓ rewire-sandbox ${bin} (REWIRE_SANDBOX_BIN)`);
  });

  test("doctor reports a binary from the installed platform package", async () => {
    const root = join(tmp(), "node_modules", "sheperd");
    const name = platformPackageName(process.platform, process.arch) ?? "sheperd-linux-x64";
    const pkg = join(root, "node_modules", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "0.1.0-beta.1" }));
    writeFileSync(join(pkg, "rewire-sandbox"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const out: string[] = [];
    await runDoctor(undefined, "darwin", {
      stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
      env: { PATH: "" },
      cwd: root,
      sandboxLookup: {
        sourceRoot: null,
        packageRoot: root,
        platform: process.platform === "linux" ? "linux" : "darwin",
        arch: name.endsWith("arm64") ? "arm64" : "x64",
      },
    } as Parameters<typeof runDoctor>[2]);
    expect(out.join("")).toContain(
      `✓ rewire-sandbox ${join(pkg, "rewire-sandbox")} (platform package ${name})`,
    );
  });

  test("unknown flag prints usage and message without a stack", async () => {
    const r = await exec(["run", "--bogus", "x"], cleanEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage:/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test("task-file must be a regular file and is size-capped", async () => {
    const d = tmp();
    const dirRun = await exec(["run", "--task-file", d], cleanEnv());
    expect(dirRun.code).toBe(1);
    expect(dirRun.stderr).toMatch(/task_file_unreadable/);
    const big = join(d, "big.txt");
    writeFileSync(big, "x".repeat(1024 * 1024 + 1));
    const bigRun = await exec(["run", "--task-file", big], cleanEnv());
    expect(bigRun.code).toBe(1);
    expect(bigRun.stderr).toMatch(/task_file_too_large/);
  });

  test("doctor sanitizes model names (row 109: the name is printed, minus the escape)", async () => {
    const d = tmp();
    const f = join(d, "models.toml");
    writeFileSync(f, 'available = ["ollama:a\\u001b[2Jb"]\n');
    const r = await exec(["doctor", "--models", f], cleanEnv({ PATH: d }));
    // The model line really carries the name, so the absence of ESC proves sanitizing.
    expect(r.stdout).toMatch(/models.*ollama:ab/);
    expect(r.stdout).not.toContain("\x1b");
  });

  test("doctor refuses an invalid REWIRE_OLLAMA_TIMEOUT_S on the ollama line", async () => {
    const d = tmp();
    const f = join(d, "models.toml");
    writeFileSync(f, 'available = ["ollama:m"]\n');
    const r = await exec(
      ["doctor", "--models", f],
      cleanEnv({ PATH: d, REWIRE_OLLAMA_TIMEOUT_S: "15m" }),
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(/ollama.*REWIRE_OLLAMA_TIMEOUT_S="15m" is not a whole number/);
  });

  test("a FIFO --task-file is refused without blocking (row 108)", async () => {
    const d = tmp();
    const fifo = join(d, "task.fifo");
    execFileSync("mkfifo", [fifo]);
    const t0 = Date.now();
    const r = await exec(["run", "--task-file", fifo], cleanEnv());
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/task_file_unreadable/);
  }, 15_000);

  test("faux with --models is refused", async () => {
    const r = await exec(
      ["run", "--headless", "--models", "/nonexistent.toml", "x"],
      cleanEnv({ REWIRE_FAUX_SCRIPT: writeScript({ m: [] }) }),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--models cannot be combined with REWIRE_FAUX_SCRIPT/);
  });

  test.skipIf(!sandboxAvailable)(
    "faux ignores a decoy default models.toml and the report is marked",
    async () => {
      const repo = makeRepo();
      const env = cleanEnv({ REWIRE_FAUX_SCRIPT: writeScript({ m: [] }) });
      const cfg = join(env.XDG_CONFIG_HOME as string, "rewire");
      mkdirSync(cfg, { recursive: true });
      writeFileSync(join(cfg, "models.toml"), 'available = ["ollama:decoy"]\n');
      const r = await exec(["run", "--headless", "--repo", repo, "x"], env);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("faux_script_exhausted");
      expect(r.stdout).not.toContain("decoy");
      const end = r.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunEvent)
        .find((e) => e.type === "run_end");
      const path = end?.type === "run_end" ? end.reportPath : "";
      expect(readFileSync(path, "utf8")).toMatch(/faux provider/i);
    },
    60_000,
  );

  test.skipIf(!sandboxAvailable)(
    "a faux report that cannot be marked exits 1, never a normal result (row 109)",
    async () => {
      const repo = makeRepo();
      const faux = writeScript({ m: [] });
      const out: string[] = [];
      const err: string[] = [];
      const sink = (to: string[]) =>
        ({
          write: (s: string) => {
            to.push(String(s));
            return true;
          },
        }) as unknown as NodeJS.WritableStream;
      const code = await runCommand(
        { task: "do thing", repo, headless: true },
        {
          stdout: sink(out),
          stderr: sink(err),
          stdin: process.stdin,
          env: cleanEnv({ REWIRE_FAUX_SCRIPT: faux }),
          cwd: repo,
          markReport: async () => {
            throw new Error("disk full");
          },
        } as Parameters<typeof runCommand>[1],
        new AbortController().signal,
      );
      expect(code).toBe(1);
      expect(err.join("")).toContain("could not mark report as faux-provider run: disk full");
    },
    60_000,
  );

  test("run without a task is a usage error", async () => {
    const r = await exec(["run"], cleanEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/task/);
  });

  test.skipIf(!sandboxAvailable)(
    "headless stdout is only valid JSONL RunEvents; escalation exits 2; faux warned on stderr",
    async () => {
      const repo = makeRepo();
      const faux = writeScript({ m: [] }); // exhausted at the first turn => stage_error escalation
      const r = await exec(
        ["run", "--headless", "--repo", repo, "do thing"],
        cleanEnv({ REWIRE_FAUX_SCRIPT: faux }),
      );
      expect(r.code).toBe(2);
      const lines = r.stdout.split("\n").filter((l) => l !== "");
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) expect(RunEvent.safeParse(JSON.parse(l)).success).toBe(true);
      expect(r.stderr).toContain("warning: faux provider in use (REWIRE_FAUX_SCRIPT)");
      expect(r.stderr).toMatch(/escalated/);
      const types = lines.map((l) => (JSON.parse(l) as RunEvent).type);
      expect(types).toContain("escalation");
      expect(types.at(-1)).toBe("run_end");
    },
    60_000,
  );

  test.skipIf(!sandboxAvailable)(
    "headless with clarifying questions: ask returns null, no non-JSON on stdout",
    async () => {
      const repo = makeRepo();
      const faux = writeScript({ m: [{ text: "explored" }, { text: contract(["which one?"]) }] });
      const r = await exec(
        ["run", "--headless", "--repo", repo, "do thing"],
        cleanEnv({ REWIRE_FAUX_SCRIPT: faux }),
      );
      expect(r.code).toBe(2);
      for (const l of r.stdout.split("\n").filter((x) => x !== "")) {
        expect(RunEvent.safeParse(JSON.parse(l)).success).toBe(true);
      }
    },
    60_000,
  );

  test.skipIf(!sandboxAvailable)(
    "SIGINT while waiting for an answer aborts the run: interrupted report, exit 2",
    async () => {
      const repo = makeRepo();
      const faux = writeScript({ m: [{ text: "explored" }, { text: contract(["which one?"]) }] });
      const [child, done] = start(
        ["run", "--repo", repo, "do thing"],
        cleanEnv({ REWIRE_FAUX_SCRIPT: faux }),
      );
      let out = "";
      child.stdout?.on("data", (d) => {
        out += d;
        if (out.includes("which one?") && !child.killed) child.kill("SIGINT");
      });
      const r = await done;
      expect(r.code).toBe(2);
      expect(r.stdout).toMatch(/escalated \(interrupted\)/);
      const runs = join(repo, ".rewire", "runs");
      const id = readdirSync(runs)[0] as string;
      expect(readFileSync(join(runs, id, "report.md"), "utf8")).toMatch(/interrupted/);
    },
    60_000,
  );
});
