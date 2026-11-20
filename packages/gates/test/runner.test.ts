import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GateResult, RewireError, RunEvent } from "@rewire/core";
import { DEFAULT_POLICY } from "@rewire/policy";
import { profileFor, SandboxClient } from "@rewire/sandbox";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Gate, type GateContext, INSTALL_HINTS, isVerified, runGates } from "../src/index.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "rewire-gates-")));

function makeCtx(over: Partial<GateContext> = {}, timeoutMs = 5000): GateContext {
  const root = tmp();
  const scratch = tmp();
  const client = new SandboxClient(profileFor("verify", root, DEFAULT_POLICY, scratch));
  return {
    worktree: root,
    baseRef: "HEAD",
    client,
    registryClient: client,
    pack: {
      packageManager: "pnpm",
      testRunner: "vitest",
      testCommand: [],
      testJsonArgs: [],
      lintCommand: null,
      tsconfig: join(root, "tsconfig.json"),
    },
    policy: { ...DEFAULT_POLICY, gateTimeoutMs: timeoutMs },
    scratch,
    ...over,
  };
}

const gate = (name: string, run: Gate["run"]): Gate => ({ name, category: "broken", run });
const ok = (name: string) =>
  gate(name, async () => ({ status: "pass", summary: "ok", details: null }));

const res = (status: GateResult["status"]): GateResult => ({
  gate: "g",
  status,
  category: "broken",
  summary: "",
  details: null,
  durationMs: 1,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runGates", () => {
  test("missing_binary_fails_closed", async () => {
    const ctx = makeCtx();
    const g = gate("semgrep", async (c) => {
      await c.client.exec(["semgrep-nope", "--version"], { timeoutMs: 5000, cwd: c.worktree });
      return { status: "pass", summary: "ran", details: null };
    });
    const [r] = await runGates([g], ctx);
    expect(r?.status).toBe("error");
    expect(r?.summary).toMatch(/semgrep-nope not installed/);
  });

  test("missing known binary uses its install hint", async () => {
    const g = gate("semgrep", async () => {
      throw new RewireError("binary_missing", "command not found: semgrep");
    });
    const [r] = await runGates([g], makeCtx());
    expect(r?.summary).toBe(`semgrep not installed — ${INSTALL_HINTS.semgrep}`);
  });

  test("timeout_fails_closed and aborts the signal", async () => {
    let signal: AbortSignal | undefined;
    const g = gate("slow", async (c) => {
      signal = c.signal;
      await new Promise((r) => setTimeout(r, 10_000));
      return { status: "pass", summary: "late", details: null };
    });
    const [r] = await runGates([g], makeCtx({}, 100));
    expect(r?.status).toBe("error");
    expect(r?.summary).toBe("timed out after 100ms");
    expect(signal?.aborted).toBe(true);
  });

  test("timer is cleared after a fast gate", async () => {
    vi.useFakeTimers();
    await runGates([ok("a")], makeCtx({}, 60_000));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("throwing gate becomes error not pass", async () => {
    const g = gate("boom", async () => {
      throw new Error("kaboom");
    });
    const [r] = await runGates([g], makeCtx());
    expect(r?.status).toBe("error");
    expect(r?.summary).toBe("gate threw: kaboom");
  });

  test("synchronous throw becomes error", async () => {
    const g = gate("sync", (() => {
      throw new Error("sync boom");
    }) as Gate["run"]);
    const [r] = await runGates([g], makeCtx());
    expect(r?.status).toBe("error");
  });

  test("invalid return shape becomes error", async () => {
    const g = gate("bad", (async () => ({ nope: true })) as unknown as Gate["run"]);
    const [r] = await runGates([g], makeCtx());
    expect(r?.status).toBe("error");
    expect(r?.summary).toMatch(/^invalid gate result: /);
  });

  test("status outside the enum becomes error", async () => {
    const g = gate("bad", (async () => ({
      status: "skipped",
      summary: "x",
      details: null,
    })) as unknown as Gate["run"]);
    const [r] = await runGates([g], makeCtx());
    expect(r?.status).toBe("error");
    expect(r?.summary).toMatch(/invalid gate result/);
  });

  test("non-object return becomes error", async () => {
    const g = gate("bad", (async () => "pass") as unknown as Gate["run"]);
    const [r] = await runGates([g], makeCtx());
    expect(r?.status).toBe("error");
  });

  test("summaries are one line and at most 500 chars", async () => {
    const g = gate("boom", async () => {
      throw new Error(`line1\nline2 ${"x".repeat(2000)}`);
    });
    const [r] = await runGates([g], makeCtx());
    expect(r?.summary).not.toMatch(/\n/);
    expect(r?.summary.length).toBeLessThanOrEqual(500);
  });

  test("a failure does not short-circuit; one valid event per gate", async () => {
    const events: RunEvent[] = [];
    const gates = [
      gate("a", async () => ({ status: "fail", summary: "no", details: { n: 1 } })),
      gate("b", async () => {
        throw new Error("x");
      }),
      ok("c"),
    ];
    const results = await runGates(gates, makeCtx(), (e) => events.push(e));
    expect(results.map((r) => r.status)).toEqual(["fail", "error", "pass"]);
    expect(results.map((r) => r.gate)).toEqual(["a", "b", "c"]);
    expect(events).toHaveLength(3);
    for (const e of events) expect(RunEvent.safeParse(e).success).toBe(true);
    expect(events.every((e) => e.type === "gate_result")).toBe(true);
  });

  test("caller abort marks remaining gates as aborted without running them", async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const first = gate("first", async () => {
      ran.push("first");
      ac.abort();
      return { status: "pass", summary: "ok", details: null };
    });
    const second = gate("second", async () => {
      ran.push("second");
      return { status: "pass", summary: "ok", details: null };
    });
    const events: RunEvent[] = [];
    const results = await runGates([first, second], makeCtx({ signal: ac.signal }), (e) =>
      events.push(e),
    );
    expect(ran).toEqual(["first"]);
    expect(results[1]).toMatchObject({ status: "error", summary: "aborted", gate: "second" });
    expect(events).toHaveLength(2);
  });
});

describe("isVerified", () => {
  test("false when any error", () => expect(isVerified([res("pass"), res("error")])).toBe(false));
  test("false when any fail", () => expect(isVerified([res("pass"), res("fail")])).toBe(false));
  test("true when all pass", () => expect(isVerified([res("pass"), res("pass")])).toBe(true));
  test("empty list is not verified", () => expect(isVerified([])).toBe(false));
});

describe("INSTALL_HINTS", () => {
  test("covers the required binaries", () => {
    for (const b of ["semgrep", "gitleaks", "rg", "bwrap"])
      expect(INSTALL_HINTS[b]).toMatch(/brew|apt/);
    expect(INSTALL_HINTS.bwrap).toMatch(/0\.8/);
  });
});
