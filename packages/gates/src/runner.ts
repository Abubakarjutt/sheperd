import { GateResult, RewireError, type RunEvent } from "@rewire/core";
import type { Gate, GateContext } from "./types.js";

export const INSTALL_HINTS: Record<string, string> = {
  semgrep:
    "brew install semgrep, or pipx install semgrep (https://semgrep.dev/docs/getting-started/)",
  gitleaks:
    "brew install gitleaks, or download a release from https://github.com/gitleaks/gitleaks/releases",
  rg: "brew install ripgrep, or apt install ripgrep (https://github.com/BurntSushi/ripgrep#installation)",
  bwrap:
    "apt install bubblewrap (Linux only; version >= 0.8 required), or dnf install bubblewrap; macOS uses sandbox-exec and does not need it",
};

const GENERIC_HINT = "install it and make sure it is on PATH";
const MAX_SUMMARY = 500;

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
}

function errorSummary(e: unknown): string {
  if (e instanceof RewireError && e.code === "binary_missing") {
    const m = /^command not found: (\S+)/.exec(e.message);
    const bin = m?.[1];
    if (bin) return `${bin} not installed — ${INSTALL_HINTS[bin] ?? GENERIC_HINT}`;
    return `${e.message}${e.hint ? ` — ${e.hint}` : ""}`;
  }
  return `gate threw: ${e instanceof Error ? e.message : String(e)}`;
}

class Timeout extends Error {}

export async function runGates(
  gates: Gate[],
  ctx: GateContext,
  emit?: (e: RunEvent) => void,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const start = Date.now();
    const finish = (r: {
      status: GateResult["status"];
      summary: string;
      details?: unknown;
    }): GateResult => ({
      gate: gate.name,
      category: gate.category,
      status: r.status,
      summary: oneLine(r.summary),
      details: r.details,
      durationMs: Date.now() - start,
    });
    const fail = (summary: string, details?: unknown) =>
      finish({ status: "error", summary, details });

    let result: GateResult;
    try {
      if (ctx.signal?.aborted) {
        result = fail("aborted");
      } else {
        result = await runOne(gate, ctx, finish, fail);
        // A gate that ignored the caller's abort and returned anyway is not trusted.
        if (ctx.signal?.aborted) result = fail("aborted");
      }
    } catch (e) {
      result = fail(errorSummary(e));
    }
    results.push(result);
    // Observers must never break the run: swallow sync throws and async rejections.
    try {
      const r: unknown = emit?.({
        type: "gate_result",
        runId: ctx.runId,
        ts: new Date().toISOString(),
        stage: ctx.stage,
        result,
      });
      Promise.resolve(r).catch(() => {});
    } catch {
      // ignored
    }
  }
  return results;
}

async function runOne(
  gate: Gate,
  ctx: GateContext,
  finish: (r: { status: GateResult["status"]; summary: string; details?: unknown }) => GateResult,
  fail: (summary: string, details?: unknown) => GateResult,
): Promise<GateResult> {
  const timeoutMs = ctx.policy.gateTimeoutMs;
  const ac = new AbortController();
  const onParentAbort = () => ac.abort();
  ctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Timeout());
      }, timeoutMs);
    });
    // Promise.resolve().then so a synchronous throw inside run() is also caught.
    const running = Promise.resolve().then(() =>
      gate.run({ ...ctx, signal: ac.signal, deadline: Date.now() + timeoutMs }),
    );
    // Avoid an unhandled rejection if the gate rejects after losing the race.
    running.catch(() => {});
    const out = await Promise.race([running, timeout]);
    const parsed = GateResult.safeParse({
      ...(typeof out === "object" && out !== null ? out : {}),
      gate: gate.name,
      category: gate.category,
      durationMs: 0,
    });
    if (!parsed.success || typeof out !== "object" || out === null) {
      const issue = parsed.success ? undefined : parsed.error.issues[0];
      const text = issue
        ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
        : "not an object";
      return fail(`invalid gate result: ${text}`);
    }
    return finish({
      status: parsed.data.status,
      summary: parsed.data.summary,
      details: parsed.data.details,
    });
  } catch (e) {
    if (e instanceof Timeout) return fail(`timed out after ${timeoutMs}ms`);
    return fail(errorSummary(e));
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
}

/** True only when there is at least one result and every one passed. */
export function isVerified(results: GateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === "pass");
}
