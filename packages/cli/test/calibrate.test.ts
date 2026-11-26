import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { defaultCompactionConfig, resolveRouting } from "@rewire/pipeline";
import { DEFAULT_POLICY } from "@rewire/policy";
import {
  type ChatRequest,
  type ChatResponse,
  type ContextWindow,
  estimateTokens,
  FauxProvider,
  type ModelRef,
  type Provider,
} from "@rewire/providers";
import {
  buildProbe,
  type CompactionDeps,
  calibrationPath,
  compactionDeps,
  compactionLimit,
  loadCalibration,
  SessionStore,
  saveCalibration,
} from "@rewire/session";
import type { SkillSet } from "@rewire/skills";
import { afterAll, describe, expect, test } from "vitest";
import { type CalibrateOptions, calibrateCommand, formatDuration } from "../src/calibrate.js";
import { chatSessions } from "../src/tui.js";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(here, "../dist/main.js");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rewire-calib-cli-")));
  dirs.push(d);
  return d;
};

const sink = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, text: () => text };
};

/** A model that reads the prompt: right answers up to `goodUpTo` tokens, wrong ones beyond. */
function oracle(goodUpTo: number) {
  const lengths: number[] = [];
  const provider: Provider & { lengths: number[] } = {
    lengths,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const user = req.messages[0]?.content ?? "";
      const tokens = estimateTokens(req.messages, req.system);
      lengths.push(tokens);
      const facts = new Map<string, string>();
      for (const m of user.matchAll(/The access code for (.+?) is ([a-z]+-\d{4})\./g)) {
        facts.set(m[1] as string, m[2] as string);
      }
      const boss = /\n(.+?) reports to (.+?)\.\n/.exec(user)?.[2] ?? "";
      const room = Number(new RegExp(`${boss}'s office is room (\\d+)\\.`).exec(user)?.[1] ?? 0);
      const asked = [...user.matchAll(/What is the access code for (.+?)\?/g)].map(
        (m) => m[1] as string,
      );
      const good = tokens <= goodUpTo * 1.05;
      const codes = Object.fromEntries(asked.map((n) => [n, good ? facts.get(n) : "wrong-0000"]));
      return {
        message: {
          text: `\`\`\`json\n${JSON.stringify({ codes, room: good ? room : 1 })}\n\`\`\``,
          toolCalls: [],
        },
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  return provider;
}

/** The nearest planned length of each request (estimates land just under the target). */
const asLengths = (tokens: number[]) => tokens.map((t) => 2 ** Math.round(Math.log2(t)));

function setup(over: { models?: string[]; window?: ContextWindow } = {}) {
  const home = tmp();
  const script = join(home, "faux.json");
  writeFileSync(script, JSON.stringify({ scripts: { probe: [] } }));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    REWIRE_FAUX_SCRIPT: script,
  };
  let window: ContextWindow = over.window ?? {
    window: 600_000,
    source: "model",
    provisional: true,
  };
  const run = async (
    opts: Partial<CalibrateOptions>,
    provider: Provider,
    signal: AbortSignal = new AbortController().signal,
    extraEnv: NodeJS.ProcessEnv = {},
  ) => {
    const out = sink();
    const err = sink();
    let made = 0;
    const code = await calibrateCommand(
      { model: "faux:probe", yes: false, fresh: false, ...opts },
      {
        stdout: out.stream,
        stderr: err.stream,
        env: { ...env, ...extraEnv },
        cwd: home,
        providers: () => {
          made++;
          return provider;
        },
        window: async () => window,
      },
      signal,
    );
    return { code, stdout: out.text(), stderr: err.text(), made };
  };
  return {
    home,
    env,
    run,
    cacheDir: join(home, "cache"),
    setWindow: (w: ContextWindow) => {
      window = w;
    },
  };
}

describe("rewire calibrate (faux)", () => {
  test("correct up to 32K, wrong beyond: effective 32768; stops after two failing lengths", async () => {
    const s = setup();
    const model = oracle(32768);
    const r = await s.run({}, model);
    expect(r.code).toBe(0);
    // 600K window: plan 8K..512K, but 64K and 128K fail, so 256K and 512K are never sent.
    expect(asLengths(model.lengths)).toEqual([8192, 16384, 32768, 65536, 131072]);
    expect(r.stdout).toMatch(/^8K {3}✓ 5\/5 {2}· \d+s$/m);
    expect(r.stdout).toMatch(/^32K {2}✓ 5\/5 {2}· /m);
    expect(r.stdout).toMatch(/^64K {2}✗ 0\/5 {2}· /m);
    expect(r.stdout).toMatch(/^128K ✗ 0\/5 {2}· /m);
    expect(r.stdout).not.toMatch(/^256K/m);
    expect(r.stdout).toContain("effective context: 32K (32,768 tokens)");
    expect(r.stdout).toContain("compaction will trigger at ~32k for this model (calibrated)");
    const entry = await loadCalibration({ provider: "faux", model: "probe" }, undefined, {
      cacheDir: s.cacheDir,
    });
    expect(entry?.effective).toBe(32768);
    expect(entry?.completedAt).toBeDefined();
    expect(entry?.window).toBe(600_000);
    // One provider for the whole run.
    expect(r.made).toBe(1);
  });

  test("each probe call is non-streaming, maxTokens ~200, with a signal and a timeout", async () => {
    const s = setup({ window: { window: 9000, source: "model", provisional: true } });
    const faux = new FauxProvider([
      (req) => ({ text: JSON.stringify({ codes: {}, room: req.maxTokens }) }),
    ]);
    const seen: ChatRequest[] = [];
    const spy: Provider = {
      chat: (req) => {
        seen.push(req);
        return faux.chat(req);
      },
    };
    expect((await s.run({}, spy)).code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.onDelta).toBeUndefined();
    expect(seen[0]?.maxTokens).toBe(200);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0);
  });

  test("Ctrl-C mid-way keeps completed lengths; a re-run continues from them (Review focus #5)", async () => {
    const s = setup();
    const ac = new AbortController();
    const good = oracle(32768);
    let calls = 0;
    const interrupting: Provider = {
      chat: async (req) => {
        calls++;
        if (calls === 3) {
          ac.abort(); // Ctrl-C while the 32K probe is in flight
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return good.chat(req);
      },
    };
    const first = await s.run({}, interrupting, ac.signal);
    expect(first.code).toBe(130);
    expect(first.stderr).toMatch(/interrupted: 2 lengths recorded/);
    const ref: ModelRef = { provider: "faux", model: "probe" };
    const partial = await loadCalibration(ref, undefined, { cacheDir: s.cacheDir });
    expect(Object.keys(partial?.results ?? {})).toEqual(["8192", "16384"]);
    expect(partial?.completedAt).toBeUndefined();

    const resumed = oracle(32768);
    const second = await s.run({}, resumed);
    expect(second.code).toBe(0);
    // Only the lengths not yet recorded are sent.
    expect(asLengths(resumed.lengths)).toEqual([32768, 65536, 131072]);
    expect(second.stdout).toMatch(/^8K {3}✓ 5\/5 {2}· \d+s {2}\(cached\)$/m);
    expect(second.stdout).toContain("effective context: 32K");

    // A completed calibration re-run sends nothing; --fresh measures again.
    const again = oracle(32768);
    expect((await s.run({}, again)).code).toBe(0);
    expect(again.lengths).toEqual([]);
    const fresh = oracle(16384);
    const f = await s.run({ fresh: true }, fresh);
    expect(asLengths(fresh.lengths)).toEqual([8192, 16384, 32768, 65536]);
    expect(f.stdout).toContain("effective context: 16K");
  });

  test("an interrupt before a probe is sent records nothing new and exits 130", async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    const model = oracle(32768);
    const r = await s.run({}, model, ac.signal);
    expect(r.code).toBe(130);
    expect(model.lengths).toEqual([]);
  });

  test("a changed digest re-measures the model", async () => {
    const s = setup({
      window: { window: 60_000, source: "loaded", provisional: false, digest: "d1" },
    });
    const first = oracle(32768);
    expect((await s.run({}, first)).code).toBe(0);
    expect(asLengths(first.lengths)).toEqual([8192, 16384, 32768]);
    const same = oracle(32768);
    await s.run({}, same);
    expect(same.lengths).toEqual([]);
    s.setWindow({ window: 60_000, source: "loaded", provisional: false, digest: "d2" });
    const changed = oracle(8192);
    const r = await s.run({}, changed);
    expect(asLengths(changed.lengths)).toEqual([8192, 16384, 32768]);
    expect(r.stdout).toContain("effective context: 8K");
    const ref: ModelRef = { provider: "faux", model: "probe" };
    expect((await loadCalibration(ref, "d1", { cacheDir: s.cacheDir }))?.effective).toBe(32768);
    expect((await loadCalibration(ref, "d2", { cacheDir: s.cacheDir }))?.effective).toBe(8192);
  });

  test("a provider error on one length records score 0 with a note and continues", async () => {
    const s = setup({ window: { window: 60_000, source: "model", provisional: true } });
    const good = oracle(1e9);
    let calls = 0;
    const flaky: Provider = {
      chat: async (req) => {
        if (++calls === 2) throw new Error("connection reset by peer");
        return good.chat(req);
      },
    };
    const r = await s.run({}, flaky);
    expect(r.code).toBe(0);
    expect(calls).toBe(3);
    expect(r.stdout).toMatch(/^16K {2}✗ 0\/5 {2}· \d+s {2}\(connection reset by peer\)$/m);
    expect(r.stdout).toContain("effective context: 8K");
    const entry = await loadCalibration({ provider: "faux", model: "probe" }, undefined, {
      cacheDir: s.cacheDir,
    });
    expect(entry?.results["16384"]).toMatchObject({ score: 0, error: "connection reset by peer" });
  });

  test("--max caps the plan", async () => {
    const s = setup();
    const model = oracle(1e9);
    const r = await s.run({ max: "20000" }, model);
    expect(r.code).toBe(0);
    expect(asLengths(model.lengths)).toEqual([8192, 16384]);
    await expect(s.run({ max: "lots" }, model)).rejects.toMatchObject({ code: "usage" });
  });

  test("a model outside the available set is refused", async () => {
    const s = setup();
    await expect(s.run({ model: "faux:other" }, oracle(1))).rejects.toMatchObject({
      code: "calibration_failed",
    });
    await expect(s.run({ model: "" }, oracle(1))).rejects.toMatchObject({ code: "usage" });
  });
});

describe("rewire calibrate: the paid gate", () => {
  function paid() {
    const s = setup();
    const models = join(s.home, "models.toml");
    writeFileSync(models, 'available = ["anthropic:claude-sonnet-4-5", "ollama:qwen3:8b"]\n');
    const env = { REWIRE_FAUX_SCRIPT: "" };
    const never: Provider = {
      chat: () => {
        throw new Error("the paid gate let a call through");
      },
    };
    return { s, models, env, never };
  }

  test("without --yes: prints the token estimate and exits calibration_failed, with no provider call", async () => {
    const { s, models, env, never } = paid();
    let made = 0;
    const out = sink();
    const err = sink();
    const p = calibrateCommand(
      { model: "anthropic:claude-sonnet-4-5", models, yes: false, fresh: false },
      {
        stdout: out.stream,
        stderr: err.stream,
        env: { ...s.env, ...env },
        cwd: s.home,
        providers: () => {
          made++;
          return never;
        },
        window: async () => ({ window: 200_000, source: "model", provisional: false }),
      },
      new AbortController().signal,
    );
    await expect(p).rejects.toMatchObject({
      code: "calibration_failed",
      hint: "re-run with --yes to spend",
    });
    expect(made).toBe(0);
    // 8K + 16K + 32K + 64K + 128K
    expect(err.text()).toContain("about 253,952 input tokens");
    expect(out.text()).toBe("");
  });

  test("with --yes it measures", async () => {
    const { s, models, env } = paid();
    s.setWindow({ window: 20_000, source: "model", provisional: false });
    const model = oracle(1e9);
    const r = await s.run(
      { model: "anthropic:claude-sonnet-4-5", models, yes: true },
      model,
      undefined,
      env,
    );
    expect(r.code).toBe(0);
    expect(model.lengths.length).toBeGreaterThan(0);
  });

  test("ollama needs no --yes", async () => {
    const { s, models, env } = paid();
    s.setWindow({ window: 20_000, source: "loaded", provisional: false, digest: "sha256:x" });
    const model = oracle(1e9);
    const r = await s.run({ model: "ollama:qwen3:8b", models }, model, undefined, env);
    expect(r.code).toBe(0);
    expect(asLengths(model.lengths)).toEqual([8192, 16384]);
  });
});

describe("the chat trigger reads the cached calibration (chatSessions → compactionDeps)", () => {
  test("a completed calibration of the chat model becomes the compaction limit", async () => {
    const repo = tmp();
    const cacheDir = tmp();
    const chat: ModelRef = { provider: "faux", model: "chat" };
    const r = { score: 5, ms: 1, at: "x" };
    await saveCalibration(
      chat,
      undefined,
      { results: { 8192: r, 16384: r }, window: 200_000, completedAt: "x", effective: 16384 },
      { cacheDir },
    );
    const captured: CompactionDeps[] = [];
    const newSession = chatSessions({
      repo,
      routing: resolveRouting([chat]),
      providers: () => new FauxProvider([]),
      policy: DEFAULT_POLICY,
      store: new SessionStore(),
      compaction: defaultCompactionConfig(),
      windowOptions: { env: { REWIRE_FAUX_WINDOW: "200000" } },
      cacheDir,
      buildCompaction: async (a) => {
        const d = await compactionDeps(a);
        captured.push(d);
        return d;
      },
    });
    const session = await newSession({
      skills: { skills: [], root: "/x" } as unknown as SkillSet,
      emit: () => {},
    });
    expect(captured[0]?.calibrated).toBe(16384);
    const limit = compactionLimit({
      window: captured[0]?.window as ContextWindow,
      calibrated: captured[0]?.calibrated as number,
      latencyBudgetS: 60,
    });
    expect(limit).toMatchObject({ limit: 16384, reason: "calibrated" });
    await session.dispose?.();

    // Without the cache dir (or with an empty one) the formula stays.
    rmSync(calibrationPath(cacheDir));
    captured.length = 0;
    await newSession({ skills: { skills: [], root: "/x" } as unknown as SkillSet, emit: () => {} });
    expect(captured[0]?.calibrated).toBeUndefined();
  });
});

describe("rewire calibrate (binary)", () => {
  type Done = { code: number | null; stdout: string; stderr: string };
  const exec = (args: string[], env: NodeJS.ProcessEnv): Promise<Done> =>
    new Promise((res) => {
      const child = spawn(process.execPath, [MAIN, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("close", (code) => res({ code, stdout, stderr }));
    });
  const baseEnv = (home: string): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const k of [
      "VITEST",
      "NODE_ENV",
      "REWIRE_FAUX_SCRIPT",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      delete env[k];
    }
    return {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
    };
  };

  test("--help and the usage list calibrate", async () => {
    const home = tmp();
    const h = await exec(["calibrate", "--help"], baseEnv(home));
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/^usage: rewire calibrate <provider:model>/);
    expect(h.stdout).toContain("--yes");
    const top = await exec(["--help"], baseEnv(home));
    expect(top.stdout).toContain("rewire calibrate <provider:model>");
    const none = await exec(["calibrate"], baseEnv(home));
    expect(none.code).toBe(1);
  });

  test("a scripted faux model: right up to 32K, wrong beyond, gives effective 32768", async () => {
    const home = tmp();
    const right = (len: number) => {
      const p = buildProbe(len, len);
      return { text: JSON.stringify(p.answers) };
    };
    const script = join(home, "faux.json");
    writeFileSync(
      script,
      JSON.stringify({
        scripts: {
          probe: [right(8192), right(16384), right(32768), { text: "no idea" }, { text: "{}" }],
        },
      }),
    );
    const env = { ...baseEnv(home), REWIRE_FAUX_SCRIPT: script, REWIRE_FAUX_WINDOW: "600000" };
    const r = await exec(["calibrate", "faux:probe"], env);
    expect(r.stderr).toContain("faux provider in use");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("effective context: 32K (32,768 tokens)");
    expect(r.stdout).toContain("compaction will trigger at ~32k for this model (calibrated)");
    const cache = JSON.parse(
      readFileSync(join(home, "cache", "rewire", "calibration.json"), "utf8"),
    );
    expect(cache["faux:probe@nodigest"].effective).toBe(32768);
  });
});

test("formatDuration", () => {
  expect(formatDuration(400)).toBe("0s");
  expect(formatDuration(14_000)).toBe("14s");
  expect(formatDuration(134_000)).toBe("2m14s");
});
