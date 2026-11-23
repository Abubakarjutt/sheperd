import { type Finding, type GateResult, RewireError } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";
import { expect, test } from "vitest";
import { FixLoopController, type RoundState, score } from "../src/fix-loop.js";

const gate = (name: string, summary = "failed"): GateResult => ({
  gate: name,
  status: "fail",
  category: "tests",
  summary,
  details: null,
  durationMs: 1,
});
const finding = (
  id: string,
  severity: 0 | 1 | 2 | 3 = 2,
  over: Partial<Finding> = {},
): Finding => ({
  id,
  reviewer: "r",
  category: "dead_code",
  severity,
  file: `src/${id}.ts`,
  lineStart: 1,
  lineEnd: 2,
  evidence: "x",
  failureScenario: `scenario-${id}`,
  confidence: 0.9,
  suggestedFix: `fix-${id}`,
  ...over,
});
const st = (
  round: number,
  gateFailures: GateResult[] = [],
  blocking: Finding[] = [],
  reviewEscalation?: string[],
): RoundState => ({ round, gateFailures, blocking, reviewEscalation });
const wide = { ...DEFAULT_POLICY, maxFixRounds: 50 };

test("zero score is done", () =>
  expect(new FixLoopController(DEFAULT_POLICY).record(st(1)).kind).toBe("done"));

test("decreasing score keeps fixing", () => {
  const c = new FixLoopController(DEFAULT_POLICY);
  expect(c.record(st(1, [gate("a"), gate("b"), gate("c")])).kind).toBe("fix");
  expect(c.record(st(2, [gate("a"), gate("b")])).kind).toBe("fix");
});

test("flat rounds trigger replan once then escalate no_progress", () => {
  const c = new FixLoopController(wide);
  const flat = (r: number) => c.record(st(r, [gate("a"), gate("b")]));
  expect([flat(1).kind, flat(2).kind, flat(3).kind]).toEqual(["fix", "fix", "replan"]);
  expect(c.replanned).toBe(true);
  expect([flat(4).kind, flat(5).kind]).toEqual(["fix", "fix"]);
  const d = flat(6);
  expect(d).toMatchObject({ kind: "escalate", reason: "no_progress" });
});

test("reappearing fingerprint is oscillation (no_progress disabled)", () => {
  const c = new FixLoopController({ ...wide, noProgressRounds: 99 });
  const A = finding("A");
  expect(c.record(st(1, [], [A])).kind).toBe("fix");
  expect(c.record(st(2, [gate("g1")], [])).kind).toBe("fix");
  expect(c.record(st(3, [], [A])).kind).toBe("replan");
});

test("oscillation fires even when every round strictly improves", () => {
  const c = new FixLoopController(wide);
  expect(c.record(st(1, [gate("g")], [finding("A", 3)])).kind).toBe("fix"); // 18
  expect(c.record(st(2, [], [finding("B", 2)])).kind).toBe("fix"); // 5
  expect(c.record(st(3, [], [finding("A", 0)])).kind).toBe("replan"); // 1
});

test("errored gate is never clean; pass-only gate is done", () => {
  const err = { ...gate("e"), status: "error" as const };
  const d = new FixLoopController(DEFAULT_POLICY).record(st(1, [err]));
  expect(d.kind).toBe("fix");
  expect(score(st(1, [err]))).toBe(10);
  const ok = { ...gate("p"), status: "pass" as const };
  expect(new FixLoopController(DEFAULT_POLICY).record(st(1, [ok])).kind).toBe("done");
});

test("invalid severity throws RewireError naming the finding", () => {
  const bad = finding("badone", 2, {}) as Finding;
  (bad as { severity: number }).severity = 7;
  expect(() => score(st(1, [], [bad]))).toThrow(RewireError);
  expect(() => new FixLoopController(DEFAULT_POLICY).record(st(1, [], [bad]))).toThrow(/badone/);
});

test("feedback cap shrinks gate summaries, keeps all gates, no U+FFFD", () => {
  const gates = Array.from({ length: 40 }, (_, i) => gate(`gate${i}`, "日本語🙂".repeat(250)));
  const d = new FixLoopController(DEFAULT_POLICY).record(st(1, gates, [finding("A", 3)]));
  if (d.kind !== "fix") throw new Error("expected fix");
  expect(Buffer.byteLength(d.feedback)).toBeLessThanOrEqual(16 * 1024);
  expect(d.feedback).not.toContain("\uFFFD");
  for (let i = 0; i < 40; i++) expect(d.feedback).toContain(`Gate gate${i}:`);
});

test("reappearing gate failure is oscillation, and escalates after replan", () => {
  const c = new FixLoopController(wide);
  c.record(st(1, [gate("g")], [finding("X")]));
  c.record(st(2, [], [finding("Y"), finding("Z"), finding("W")]));
  expect(c.record(st(3, [gate("g")], [])).kind).toBe("replan");
  // history reset: pattern must be rebuilt after the replan
  c.record(st(4, [gate("g")], []));
  c.record(st(5, [], [finding("Q"), finding("R"), finding("S")]));
  expect(c.record(st(6, [gate("g")], []))).toMatchObject({
    kind: "escalate",
    reason: "oscillation",
  });
});

test("history resets on replan: old absence does not create oscillation", () => {
  const c = new FixLoopController(wide);
  const A = finding("A");
  c.record(st(1, [gate("a"), gate("b")], [A])); // 25, A present
  c.record(st(2, [gate("a"), gate("b")], [])); // 20, A absent
  expect(c.record(st(3, [gate("a"), gate("b")], [])).kind).toBe("fix");
  expect(c.record(st(4, [gate("a"), gate("b")], [])).kind).toBe("replan");
  // A returns, but pre-replan history is gone
  expect(c.record(st(5, [], [A])).kind).toBe("fix");
});

test("exceeding maxFixRounds replans, then escalates budget", () => {
  const p = { ...DEFAULT_POLICY, maxFixRounds: 2, noProgressRounds: 99 };
  const c = new FixLoopController(p);
  expect(c.record(st(1, [gate("a"), gate("b"), gate("c")])).kind).toBe("fix");
  expect(c.record(st(2, [gate("a"), gate("b")])).kind).toBe("fix");
  expect(c.record(st(3, [gate("a")])).kind).toBe("replan");
  // budget is NOT reset by replan
  expect(c.record(st(4, [gate("a")]))).toMatchObject({
    kind: "escalate",
    reason: "budget",
  });
});

test("trigger order: oscillation, then no_progress, then budget", () => {
  const p = { ...DEFAULT_POLICY, maxFixRounds: 5, noProgressRounds: 2 };
  const replanned = (): FixLoopController => {
    const c = new FixLoopController(p);
    for (const r of [1, 2, 3]) c.record(st(r, [gate("a")]));
    expect(c.replanned).toBe(true);
    return c;
  };
  const A = finding("A", 1);
  // oscillation + no_progress + budget all fire at round 6
  const c1 = replanned();
  c1.record(st(4, [], [A]));
  c1.record(st(5, [gate("g")], []));
  expect(c1.record(st(6, [], [A]))).toMatchObject({ kind: "escalate", reason: "oscillation" });
  // no_progress + budget fire, no oscillation
  const c2 = replanned();
  c2.record(st(4, [], [finding("B", 1)]));
  c2.record(st(5, [], [finding("C", 1)]));
  expect(c2.record(st(6, [], [finding("D", 1)]))).toMatchObject({
    kind: "escalate",
    reason: "no_progress",
  });
});

test("score weights: critical 8, minor 1; critical sorted before nit in feedback", () => {
  expect(score(st(1, [], [finding("c", 3)]))).toBe(8);
  expect(score(st(1, [gate("a")], [finding("a", 0), finding("b", 1), finding("c", 2)]))).toBe(
    10 + 1 + 3 + 5,
  );
  const c = new FixLoopController(DEFAULT_POLICY);
  const d = c.record(st(1, [], [finding("nit", 0), finding("crit", 3)]));
  if (d.kind !== "fix") throw new Error("expected fix");
  expect(d.feedback.indexOf("src/crit.ts")).toBeGreaterThan(-1);
  expect(d.feedback.indexOf("src/crit.ts")).toBeLessThan(d.feedback.indexOf("src/nit.ts"));
});

test("feedback lists gate failures before findings", () => {
  const c = new FixLoopController(DEFAULT_POLICY);
  const d = c.record(st(1, [gate("lint", "3 errors")], [finding("A", 3)]));
  if (d.kind !== "fix") throw new Error("expected fix");
  expect(d.feedback).toContain("Gate lint: 3 errors");
  expect(d.feedback.indexOf("Gate")).toBeLessThan(d.feedback.indexOf("src/A.ts"));
  expect(d.feedback).toContain("scenario-A");
  expect(d.feedback).toContain("fix-A");
});

test("feedback redacts secrets", () => {
  const c = new FixLoopController(DEFAULT_POLICY);
  const d = c.record(
    st(
      1,
      [gate("g", "leak ghp_abcDEF123")],
      [finding("A", 3, { suggestedFix: "rm sk-live_abc123" })],
    ),
  );
  if (d.kind !== "fix") throw new Error("expected fix");
  expect(d.feedback).not.toMatch(/ghp_abc|sk-live/);
  expect(d.feedback).toContain("[redacted]");
});

test("feedback is capped at 16 KiB, drops findings not gates", () => {
  const c = new FixLoopController(DEFAULT_POLICY);
  const many = Array.from({ length: 200 }, (_, i) =>
    finding(`f${String(i).padStart(3, "0")}`, 1, { failureScenario: "z".repeat(300) }),
  );
  const d = c.record(st(1, [gate("lint"), gate("types")], many));
  if (d.kind !== "fix") throw new Error("expected fix");
  expect(Buffer.byteLength(d.feedback)).toBeLessThanOrEqual(16 * 1024);
  expect(d.feedback).toContain("Gate lint");
  expect(d.feedback).toContain("Gate types");
  expect(d.feedback).toMatch(/… \d+ more findings omitted/);
});

test("score 0 with review escalation is escalate review_incomplete, never done", () => {
  const c = new FixLoopController(DEFAULT_POLICY);
  const d = c.record(st(1, [], [], ["diff truncated"]));
  expect(d).toMatchObject({
    kind: "escalate",
    reason: "review_incomplete",
    details: ["diff truncated"],
  });
  expect(new FixLoopController(DEFAULT_POLICY).record(st(1, [], [], [])).kind).toBe("done");
});

test("score > 0 with review escalation still fixes, but later escalation carries reasons", () => {
  const c = new FixLoopController(wide);
  const s = (r: number) => c.record(st(r, [gate("a")], [], ["verifier error"]));
  expect(s(1).kind).toBe("fix");
  expect(s(2).kind).toBe("fix");
  expect(s(3).kind).toBe("replan");
  s(4);
  s(5);
  expect(s(6)).toMatchObject({
    kind: "escalate",
    reason: "no_progress",
    details: ["verifier error"],
  });
});

test("replan history is a compact per-round summary", () => {
  const c = new FixLoopController(wide);
  c.record(st(1, [gate("a")]));
  c.record(st(2, [gate("a")]));
  const d = c.record(st(3, [gate("a")]));
  if (d.kind !== "replan") throw new Error("expected replan");
  expect(d.history).toContain("round 1");
  expect(d.history).toContain("score 10");
  expect(d.history).toContain("gate:a");
});
