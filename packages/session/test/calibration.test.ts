import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@rewire/providers";
import { TokenEstimator } from "@rewire/providers";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildProbe,
  decide,
  MIN_PROBE_LENGTH,
  PASS_SCORE,
  planLengths,
  score,
} from "../src/calibration.js";
import {
  calibratedLimit,
  calibrationKey,
  calibrationPath,
  calibrationState,
  loadCalibration,
  saveCalibration,
} from "../src/calibration-cache.js";
import { COMPACTION_FLOOR } from "../src/trigger.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "rewire-calib-"));
  dirs.push(d);
  return d;
};

const answerJson = (a: { codes: Record<string, string>; room: number }) => JSON.stringify(a);

describe("buildProbe", () => {
  test("the same seed gives the same text; another seed differs", () => {
    const a = buildProbe(8192, 1);
    const b = buildProbe(8192, 1);
    const c = buildProbe(8192, 2);
    expect(a.user).toBe(b.user);
    expect(a.system).toBe(b.system);
    expect(a.answers).toEqual(b.answers);
    expect(c.user).not.toBe(a.user);
  });

  test("the prompt is sized to about targetTokens with the estimator", () => {
    const est = new TokenEstimator();
    for (const target of [8192, 32768]) {
      const p = buildProbe(target, target);
      const got = est.estimate(p.system, [{ role: "user", content: p.user }]);
      expect(got).toBeGreaterThan(target * 0.97);
      expect(got).toBeLessThanOrEqual(target * 1.01);
    }
    // A corrected estimator (more tokens per char) gives a shorter text for the same target.
    const dense = new TokenEstimator({ ratio: 2 });
    const p = buildProbe(16384, 3, dense);
    const got = dense.estimate(p.system, [{ role: "user", content: p.user }]);
    expect(got).toBeGreaterThan(16384 * 0.97);
    expect(got).toBeLessThanOrEqual(16384 * 1.01);
  });

  test("plants 6 codes at 10/30/50/50/70/90% and the 2-hop pair at 20%/80%", () => {
    const p = buildProbe(32768, 7);
    const doc = p.user.slice(p.user.indexOf("<document>"), p.user.indexOf("</document>"));
    const codes = p.planted.filter((f) => f.kind === "code");
    expect(codes.map((f) => f.depth)).toEqual([0.1, 0.3, 0.5, 0.5, 0.7, 0.9]);
    const hops = p.planted.filter((f) => f.kind !== "code");
    expect(hops.map((f) => [f.kind, f.depth])).toEqual([
      ["reports_to", 0.2],
      ["office", 0.8],
    ]);
    for (const f of p.planted) {
      const at = doc.indexOf(f.sentence);
      expect(at).toBeGreaterThan(0);
      expect(doc.indexOf(f.sentence, at + 1)).toBe(-1);
      expect(Math.abs(at / doc.length - f.depth)).toBeLessThan(0.02);
    }
    for (const f of codes) {
      expect(f.sentence).toMatch(/^The access code for [A-Z][a-z]+ [A-Z][a-z]+ is [a-z]+-\d{4}\.$/);
    }
    // The question asks for 4 of the 6 codes and the manager's room.
    expect(Object.keys(p.answers.codes)).toHaveLength(4);
    for (const [name, code] of Object.entries(p.answers.codes)) {
      expect(p.user).toContain(`The access code for ${name} is ${code}.`);
      expect(p.user.slice(p.user.indexOf("</document>"))).toContain(name);
    }
    const [a, b] = [hops[0]?.sentence ?? "", hops[1]?.sentence ?? ""];
    const m = /^(.+) reports to (.+)\.$/.exec(a);
    expect(m).not.toBeNull();
    expect(b).toBe(`${m?.[2]}'s office is room ${p.answers.room}.`);
    expect(p.user.slice(p.user.indexOf("</document>"))).toContain(
      `which room is ${m?.[1]}'s manager in`,
    );
  });

  test("the filler is varied: prose, log and code lines, no long verbatim repeats", () => {
    const p = buildProbe(32768, 11);
    const doc = p.user.slice(p.user.indexOf("<document>") + 10, p.user.indexOf("</document>"));
    const lines = doc.split("\n").filter((l) => l.trim() !== "");
    const unique = new Set(lines);
    expect(unique.size / lines.length).toBeGreaterThan(0.99);
    expect(
      lines.some((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ (INFO|WARN|DEBUG|ERROR) /.test(l)),
    ).toBe(true);
    expect(lines.some((l) => /[;{]$/.test(l.trim()))).toBe(true);
    expect(
      lines.some((l) => /^[A-Z][a-z].* [a-z]+.*\.$/.test(l) && !l.includes("access code")),
    ).toBe(true);
    // No 200-character run appears twice.
    const seen = new Set<string>();
    for (let i = 0; i + 200 < doc.length; i += 97) {
      const run = doc.slice(i, i + 200);
      expect(seen.has(run)).toBe(false);
      seen.add(run);
    }
    // The filler never imitates a planted fact.
    expect(doc.match(/access code/g)).toHaveLength(6);
    expect(doc.match(/ reports to /g)).toHaveLength(1);
    expect(doc.match(/office is room/g)).toHaveLength(1);
  });

  test("refuses a target below the smallest probe", () => {
    expect(() => buildProbe(100, 1)).toThrow();
  });
});

describe("score", () => {
  const p = buildProbe(8192, 5);
  const right = { codes: { ...p.answers.codes }, room: p.answers.room };

  test("a correct reply scores 5; bare, fenced, or embedded in prose", () => {
    expect(score(answerJson(right), p.answers)).toBe(5);
    expect(score(`\`\`\`json\n${answerJson(right)}\n\`\`\``, p.answers)).toBe(5);
    expect(score(`Sure! Here it is: ${answerJson(right)} hope that helps {x}`, p.answers)).toBe(5);
  });

  test("each wrong code or a wrong room costs one point", () => {
    const names = Object.keys(right.codes);
    const oneWrong = { ...right, codes: { ...right.codes, [names[0] as string]: "nope-0000" } };
    expect(score(answerJson(oneWrong), p.answers)).toBe(4);
    expect(score(answerJson({ ...right, room: right.room + 1 }), p.answers)).toBe(4);
    const { [names[1] as string]: _drop, ...rest } = right.codes;
    expect(score(answerJson({ codes: rest, room: 0 }), p.answers)).toBe(3);
  });

  test("lenient on case, whitespace and a numeric-string room", () => {
    const codes = Object.fromEntries(
      Object.entries(right.codes).map(([k, v]) => [` ${k.toUpperCase()} `, ` ${v.toUpperCase()}`]),
    );
    expect(score(JSON.stringify({ codes, room: String(right.room) }), p.answers)).toBe(5);
  });

  test("a stray object in reasoning prose before the answer does not hide it", () => {
    expect(score(`Let me think {} about it... ${answerJson(right)}`, p.answers)).toBe(5);
    expect(score(`thinking {"x": 1}\n\`\`\`json\n${answerJson(right)}\n\`\`\``, p.answers)).toBe(5);
  });

  test("anything that is not a JSON object scores 0", () => {
    expect(score("I could not find them.", p.answers)).toBe(0);
    expect(score("", p.answers)).toBe(0);
    expect(score("{not json", p.answers)).toBe(0);
    expect(score("[1,2,3]", p.answers)).toBe(0);
    expect(score(JSON.stringify({ codes: "x", room: "abc" }), p.answers)).toBe(0);
  });
});

describe("planLengths and decide", () => {
  test("doubles from 8K up to min(floor(0.95·window), max)", () => {
    expect(planLengths(131072)).toEqual([8192, 16384, 32768, 65536]);
    expect(planLengths(200000)).toEqual([8192, 16384, 32768, 65536, 131072]);
    expect(planLengths(200000, 40000)).toEqual([8192, 16384, 32768]);
    expect(planLengths(200000, 32768)).toEqual([8192, 16384, 32768]);
    expect(planLengths(8192)).toEqual([]);
    expect(planLengths(8624)).toEqual([8192]);
    expect(MIN_PROBE_LENGTH).toBe(8192);
    expect(PASS_SCORE).toBe(4);
  });

  test("effective: the largest length passing with every shorter one passing", () => {
    expect(decide({})).toEqual({ stop: false });
    expect(decide({ 8192: { score: 5 }, 16384: { score: 4 }, 32768: { score: 5 } })).toEqual({
      effective: 32768,
      stop: false,
    });
    // A later pass after a failure does not count.
    expect(decide({ 8192: { score: 5 }, 16384: { score: 3 }, 32768: { score: 5 } })).toEqual({
      effective: 8192,
      stop: false,
    });
    expect(decide({ 8192: { score: 2 } })).toEqual({ stop: false });
  });

  test("an errored length is not a score: it breaks effective but never counts toward the stop", () => {
    const e = { error: "timeout: x" };
    expect(decide({ 8192: { score: 5 }, 16384: e, 32768: { score: 5 } })).toEqual({
      effective: 8192,
      stop: false,
    });
    expect(decide({ 8192: e, 16384: e })).toEqual({ stop: false });
    expect(decide({ 8192: { score: 1 }, 16384: e, 32768: { score: 1 } }).stop).toBe(true);
  });

  test("stops after two consecutive lengths under 4/5", () => {
    expect(decide({ 8192: { score: 5 }, 16384: { score: 3 }, 32768: { score: 2 } }).stop).toBe(
      true,
    );
    expect(decide({ 8192: { score: 3 }, 16384: { score: 5 }, 32768: { score: 2 } }).stop).toBe(
      false,
    );
    expect(decide({ 8192: { score: 0 }, 16384: { score: 0 } })).toEqual({ stop: true });
  });
});

describe("calibration cache", () => {
  const ref: ModelRef = { provider: "ollama", model: "qwen3:8b" };
  const result = (s: number) => ({ score: s, ms: 1000, at: "2026-11-27T00:00:00.000Z" });

  test("keys by provider:model@digest, or @nodigest", () => {
    expect(calibrationKey(ref, "sha256:abc")).toBe("ollama:qwen3:8b@sha256:abc");
    expect(calibrationKey({ provider: "faux", model: "m" }, undefined)).toBe("faux:m@nodigest");
    expect(calibrationPath("/c")).toBe(join("/c", "rewire", "calibration.json"));
  });

  test("writes atomically, 0600 in a 0700 dir; resumes per length; keeps other keys", async () => {
    const cacheDir = await tmp();
    expect(await loadCalibration(ref, "d1", { cacheDir })).toBeUndefined();
    await saveCalibration(ref, "d1", { results: { 8192: result(5) }, window: 65536 }, { cacheDir });
    await saveCalibration(
      { provider: "faux", model: "m" },
      undefined,
      { results: { 8192: result(1) }, window: 9000 },
      { cacheDir },
    );
    await saveCalibration(
      ref,
      "d1",
      { results: { 8192: result(5), 16384: result(4) }, window: 65536 },
      { cacheDir },
    );
    const file = calibrationPath(cacheDir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(cacheDir, "rewire"))).mode & 0o777).toBe(0o700);
    // No temp files left behind.
    expect(await readdir(join(cacheDir, "rewire"))).toEqual(["calibration.json"]);
    const got = await loadCalibration(ref, "d1", { cacheDir });
    expect(Object.keys(got?.results ?? {})).toEqual(["8192", "16384"]);
    expect(got?.completedAt).toBeUndefined();
    expect(calibratedLimit(got)).toBeUndefined(); // an incomplete run is never used
    expect(
      (await loadCalibration({ provider: "faux", model: "m" }, undefined, { cacheDir }))?.window,
    ).toBe(9000);
  });

  test("a changed digest is a new key: the model is re-measured", async () => {
    const cacheDir = await tmp();
    await saveCalibration(
      ref,
      "old",
      { results: { 8192: result(5) }, window: 65536, completedAt: "x", effective: 8192 },
      { cacheDir },
    );
    expect(await loadCalibration(ref, "new", { cacheDir })).toBeUndefined();
    expect(await loadCalibration(ref, undefined, { cacheDir })).toBeUndefined();
    expect((await loadCalibration(ref, "old", { cacheDir }))?.effective).toBe(8192);
  });

  test("effective is recomputed from the results, never trusted from the file", async () => {
    const cacheDir = await tmp();
    const warnings: string[] = [];
    await mkdir(join(cacheDir, "rewire"), { recursive: true });
    await writeFile(
      calibrationPath(cacheDir),
      JSON.stringify({
        [calibrationKey(ref, "d")]: {
          effective: 1_000_000,
          results: { 8192: result(5), 16384: result(1) },
          window: 65536,
          completedAt: "2026-11-27T00:00:00.000Z",
        },
      }),
    );
    const got = await loadCalibration(ref, "d", { cacheDir, warn: (m) => warnings.push(m) });
    expect(got?.effective).toBe(8192);
    expect(calibratedLimit(got)).toBe(8192);
    expect(warnings.join("\n")).toMatch(/effective/);
  });

  test("errored or truncated entries are never used; a score and an error together are malformed", async () => {
    const err = { error: "x", ms: 1, at: "x" };
    expect(
      calibratedLimit({
        results: { 8192: result(5), 16384: err },
        window: 65536,
        completedAt: "x",
      }),
    ).toBeUndefined();
    expect(
      calibratedLimit({
        results: { 8192: result(5) },
        window: 65536,
        completedAt: "x",
        truncated: { length: 16384, inputTokens: 4096, estimated: 16384 },
      }),
    ).toBeUndefined();
    const cacheDir = await tmp();
    await mkdir(join(cacheDir, "rewire"), { recursive: true });
    await writeFile(
      calibrationPath(cacheDir),
      JSON.stringify({
        [calibrationKey(ref, "d")]: {
          results: { 8192: { score: 5, error: "x", ms: 1, at: "x" } },
          window: 65536,
        },
      }),
    );
    expect(await loadCalibration(ref, "d", { cacheDir })).toBeUndefined();
  });

  test("a calibration measured at another window (over 10% either way) is stale", () => {
    const e = { results: { 8192: result(5) }, window: 65536, completedAt: "x", effective: 8192 };
    const at = (window: number, provisional = false) =>
      calibrationState(e, { window, provisional });
    expect(at(65536)).toEqual({ calibrated: 8192 });
    expect(at(70000)).toEqual({ calibrated: 8192 });
    expect(at(60000)).toEqual({ calibrated: 8192 });
    expect(at(131072)).toEqual({ stale: { measured: 65536, current: 131072 } });
    expect(at(4096)).toEqual({ stale: { measured: 65536, current: 4096 } });
    // A provisional window is not compared (re-checked once the loaded window is known).
    expect(at(131072, true)).toEqual({ calibrated: 8192 });
    expect(calibrationState(undefined, { window: 1, provisional: false })).toEqual({});
  });

  test("a completed run where nothing passed calibrates to the floor", () => {
    expect(calibratedLimit({ results: { 8192: result(1) }, window: 65536, completedAt: "x" })).toBe(
      COMPACTION_FLOOR,
    );
  });

  test("corrupt JSON or wrong shapes are ignored with a warning, never a crash", async () => {
    const cacheDir = await tmp();
    await mkdir(join(cacheDir, "rewire"), { recursive: true });
    const file = calibrationPath(cacheDir);
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);

    await writeFile(file, "{not json");
    expect(await loadCalibration(ref, "d", { cacheDir, warn })).toBeUndefined();
    expect(warnings).toHaveLength(1);

    await writeFile(file, JSON.stringify([1, 2]));
    expect(await loadCalibration(ref, "d", { cacheDir, warn })).toBeUndefined();
    expect(warnings).toHaveLength(2);

    const k = calibrationKey(ref, "d");
    for (const bad of [
      { results: { 8192: { score: 9, ms: 1, at: "x" } }, window: 65536 },
      { results: { abc: result(5) }, window: 65536 },
      { results: { 8192: result(5) }, window: -1 },
      { results: "x", window: 65536 },
      "entry",
    ]) {
      await writeFile(file, JSON.stringify({ [k]: bad }));
      expect(await loadCalibration(ref, "d", { cacheDir, warn })).toBeUndefined();
    }
    expect(warnings.length).toBeGreaterThanOrEqual(7);

    // A save over a corrupt file starts afresh (warned) instead of failing.
    await writeFile(file, "garbage");
    await saveCalibration(
      ref,
      "d",
      { results: { 8192: result(5) }, window: 65536 },
      { cacheDir, warn },
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty([k]);
  });

  test("refuses a symlinked cache dir and does not follow a symlinked file", async () => {
    const cacheDir = await tmp();
    const elsewhere = await tmp();
    await symlink(elsewhere, join(cacheDir, "rewire"));
    await expect(
      saveCalibration(ref, "d", { results: {}, window: 65536 }, { cacheDir }),
    ).rejects.toMatchObject({ code: "calibration_failed" });
    expect(await loadCalibration(ref, "d", { cacheDir })).toBeUndefined();

    const other = await tmp();
    await mkdir(join(other, "rewire"));
    const target = join(elsewhere, "target.json");
    await writeFile(
      target,
      JSON.stringify({ [calibrationKey(ref, "d")]: { results: {}, window: 1 } }),
    );
    await symlink(target, calibrationPath(other));
    expect(await loadCalibration(ref, "d", { cacheDir: other })).toBeUndefined();
  });
});

describe("compactionDeps reads the calibration cache", () => {
  test("a completed calibration of the chat model gives `calibrated`; incomplete or other digests do not", async () => {
    const { defaultCompactionConfig, resolveRouting } = await import("@rewire/pipeline");
    const { FauxProvider } = await import("@rewire/providers");
    const { compactionDeps } = await import("../src/chat.js");
    const cacheDir = await tmp();
    const chat: ModelRef = { provider: "faux", model: "chat" };
    const build = () =>
      compactionDeps({
        routing: resolveRouting([chat]),
        providers: () => new FauxProvider([]),
        config: defaultCompactionConfig(),
        estimator: new TokenEstimator(),
        windowOptions: { fauxWindow: 200_000 },
        calibrationCacheDir: cacheDir,
      });
    expect((await build()).calibrated).toBeUndefined();
    const r = { score: 5, ms: 1, at: "x" };
    await saveCalibration(
      chat,
      undefined,
      { results: { 8192: r, 16384: r }, window: 200_000 },
      {
        cacheDir,
      },
    );
    expect((await build()).calibrated).toBeUndefined(); // not completed
    await saveCalibration(
      chat,
      undefined,
      { results: { 8192: r, 16384: r }, window: 200_000, completedAt: "x", effective: 16384 },
      { cacheDir },
    );
    expect((await build()).calibrated).toBe(16384);
    // Another model's calibration is not used.
    await rm(calibrationPath(cacheDir));
    await saveCalibration(
      { provider: "faux", model: "other" },
      undefined,
      {
        results: { 8192: r },
        window: 200_000,
        completedAt: "x",
      },
      { cacheDir },
    );
    expect((await build()).calibrated).toBeUndefined();
  });
});
