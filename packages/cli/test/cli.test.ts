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
import { findSandboxBinary } from "@rewire/sandbox";
import { afterAll, describe, expect, test } from "vitest";
import { exitCodeFor } from "../src/exit.js";
import { loadFauxScript } from "../src/faux.js";
import { discoverModels } from "../src/models.js";
import { escalationHint, finalLine, renderEvent } from "../src/render-interactive.js";
import { sanitize } from "../src/sanitize.js";
import { installSigint } from "../src/sigint.js";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(here, "../dist/main.js");
const SECRET = `sk-${"A".repeat(30)}`;

let sandboxAvailable = true;
try {
  findSandboxBinary();
} catch {
  sandboxAvailable = false;
}

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
  return { ...env, ...extra };
}

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
  test("node_modules hint", () => {
    const esc = {
      reason: "stage_error" as const,
      tried: [],
      unresolved: [],
      hypothesis: "",
      question: "",
      details: ["index guard: tracked node_modules/foo/index.js changed"],
    };
    const hint = escalationHint({
      runId: "r",
      status: "escalated",
      branch: "",
      worktree: "",
      reportPath: "",
      escalation: esc,
    });
    expect(hint).toMatch(/node_modules/);
    expect(hint).toMatch(/unsupported in v0\.1/);
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
      const p = execFileSync("which", [b], { encoding: "utf8" }).trim();
      symlinkSync(p, join(bin, b));
    }
    const r = await exec(["doctor"], cleanEnv({ PATH: bin }));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ semgrep.*brew install semgrep/);
    expect(r.stdout).toMatch(/✓ git/);
    expect(r.stdout).toMatch(/✓ rg/);
  });

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
      mkdirSync(runs, { recursive: true });
    },
    60_000,
  );
});
