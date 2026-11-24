import { describe, expect, test } from "vitest";
import {
  Contract,
  Finding,
  FrozenTestManifest,
  fingerprintFinding,
  GateResult,
  HARD_BLOCK_CATEGORIES,
  newRunId,
  RewireError,
  RunEvent,
  SlopCategory,
  Verdict,
} from "../src/index.js";

const validFinding = {
  id: "f1",
  reviewer: "r",
  category: "broken",
  severity: 2,
  file: "a.ts",
  lineStart: 1,
  lineEnd: 2,
  evidence: "x",
  failureScenario: "y",
  confidence: 0.5,
  suggestedFix: "",
} as const;

const validGate = {
  gate: "tests",
  status: "pass",
  category: "broken",
  summary: "ok",
  details: null,
  durationMs: 1,
} as const;

describe("schemas", () => {
  test("contract requires at least one criterion", () => {
    expect(
      Contract.safeParse({
        id: "c1",
        title: "t",
        criteria: [],
        nonGoals: [],
        affectedAreas: [],
        openQuestions: [],
      }).success,
    ).toBe(false);
  });

  test("contract with a criterion is valid", () => {
    expect(
      Contract.safeParse({
        id: "c1",
        title: "t",
        criteria: [{ id: "AC-1", kind: "change", statement: "s" }],
        nonGoals: [],
        affectedAreas: [],
        openQuestions: [],
      }).success,
    ).toBe(true);
  });

  test("a criterion must say its kind: change or preserve, no default", () => {
    const base = { id: "c1", title: "t", nonGoals: [], affectedAreas: [], openQuestions: [] };
    const parse = (criterion: Record<string, unknown>) =>
      Contract.safeParse({ ...base, criteria: [{ id: "AC-1", statement: "s", ...criterion }] });
    expect(parse({}).success).toBe(false);
    expect(parse({ kind: "keep" }).success).toBe(false);
    expect(parse({ kind: "preserve" }).success).toBe(true);
    expect(parse({ kind: "change" }).success).toBe(true);
  });

  test("finding without evidence is invalid", () => {
    expect(Finding.safeParse({ ...validFinding, evidence: "" }).success).toBe(false);
  });

  test("finding without failureScenario is invalid", () => {
    expect(Finding.safeParse({ ...validFinding, failureScenario: "" }).success).toBe(false);
  });

  test("finding rejects out-of-range confidence and severity", () => {
    expect(Finding.safeParse({ ...validFinding, confidence: 1.1 }).success).toBe(false);
    expect(Finding.safeParse({ ...validFinding, severity: 4 }).success).toBe(false);
    expect(Finding.safeParse(validFinding).success).toBe(true);
  });

  test("slop category is exactly the nine spec ids in order", () => {
    expect(SlopCategory.options).toEqual([
      "broken",
      "fake_verification",
      "spec_drift",
      "security",
      "silent_failure",
      "bloat",
      "convention_drift",
      "maintainability",
      "entropy",
    ]);
  });

  test("hard block set is exactly the first five categories", () => {
    expect([...HARD_BLOCK_CATEGORIES]).toEqual([
      "broken",
      "fake_verification",
      "spec_drift",
      "security",
      "silent_failure",
    ]);
  });

  test("verdict and gate result parse", () => {
    expect(
      Verdict.safeParse({
        findingId: "f1",
        verdict: "upheld",
        reasoning: "r",
        verifierModel: "m",
      }).success,
    ).toBe(true);
    expect(
      Verdict.safeParse({ findingId: "f1", verdict: "maybe", reasoning: "", verifierModel: "m" })
        .success,
    ).toBe(false);
    expect(GateResult.safeParse(validGate).success).toBe(true);
    expect(GateResult.safeParse({ ...validGate, status: "skip" }).success).toBe(false);
  });

  test("frozen test manifest parses", () => {
    expect(
      FrozenTestManifest.safeParse({
        files: [{ path: "t.test.ts", sha256: "ab" }],
        criteriaToTests: { "AC-1": ["t.test.ts"] },
      }).success,
    ).toBe(true);
    expect(
      FrozenTestManifest.safeParse({ files: [{ path: "x" }], criteriaToTests: {} }).success,
    ).toBe(false);
  });
});

describe("RunEvent", () => {
  const base = { runId: "r1", ts: "2026-11-20T00:00:00.000Z" };
  test("parses every variant", () => {
    const events = [
      { ...base, type: "run_start", task: "t", repo: "r" },
      { ...base, type: "stage_start", stage: "s" },
      { ...base, type: "stage_end", stage: "s", ok: true },
      { ...base, type: "tool_call", stage: "s", tool: "t", isError: false, summary: "x" },
      { ...base, type: "gate_result", stage: "s", result: validGate },
      { ...base, type: "finding", stage: "s", finding: validFinding },
      {
        ...base,
        type: "verdict",
        stage: "s",
        verdict: { findingId: "f1", verdict: "refuted", reasoning: "r", verifierModel: "m" },
      },
      { ...base, type: "fix_round", round: 1, score: 3 },
      { ...base, type: "escalation", reason: "r", question: "q" },
      { ...base, type: "run_end", status: "verified", reportPath: "p" },
    ];
    for (const e of events) expect(RunEvent.safeParse(e).success, e.type).toBe(true);
  });

  test("rejects unknown type and missing stage", () => {
    expect(RunEvent.safeParse({ ...base, type: "nope" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, type: "stage_start" }).success).toBe(false);
    expect(
      RunEvent.safeParse({ ...base, type: "run_end", status: "done", reportPath: "p" }).success,
    ).toBe(false);
  });
});

describe("ids and fingerprints", () => {
  test("newRunId matches YYYYMMDD-HHMMSS-hex6", () => {
    expect(newRunId()).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  test("newRunId uses the supplied date in UTC", () => {
    expect(newRunId(new Date("2026-11-20T01:02:03Z"))).toMatch(/^20261120-010203-[0-9a-f]{6}$/);
  });

  test("fingerprint ignores whitespace differences in evidence", () => {
    expect(fingerprintFinding({ ...validFinding, evidence: "a  b\n" })).toBe(
      fingerprintFinding({ ...validFinding, evidence: "a b" }),
    );
  });

  test("fingerprint differs by category, file, and evidence", () => {
    const f = fingerprintFinding(validFinding);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintFinding({ ...validFinding, category: "security" })).not.toBe(f);
    expect(fingerprintFinding({ ...validFinding, file: "b.ts" })).not.toBe(f);
    expect(fingerprintFinding({ ...validFinding, evidence: "z" })).not.toBe(f);
  });

  test("fingerprint ignores reviewer, id, and line numbers", () => {
    expect(
      fingerprintFinding({
        ...validFinding,
        id: "other",
        reviewer: "q",
        lineStart: 9,
        lineEnd: 12,
      }),
    ).toBe(fingerprintFinding(validFinding));
  });
});

describe("RewireError", () => {
  test("carries code, message, hint", () => {
    const e = new RewireError("E_X", "bad", "try y");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("E_X");
    expect(e.message).toBe("bad");
    expect(e.hint).toBe("try y");
    expect(e.name).toBe("RewireError");
  });
});
