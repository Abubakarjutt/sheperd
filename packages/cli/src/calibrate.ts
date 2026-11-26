import type { Writable } from "node:stream";
import { RewireError } from "@rewire/core";
import { compactionLimitOverride } from "@rewire/pipeline";
import {
  type ContextWindow,
  contextWindow,
  type ModelRef,
  ollamaChatTimeoutMs,
  type Provider,
  parseModelRef,
  suspectTruncation,
  TokenEstimator,
} from "@rewire/providers";
import {
  buildProbe,
  type CalibrationEntry,
  calibratedLimit,
  compactionLimit,
  decide,
  type LengthResult,
  loadCalibration,
  MAX_SCORE,
  PASS_SCORE,
  PROBE_MAX_TOKENS,
  planLengths,
  saveCalibration,
  score,
} from "@rewire/session";
import { loadFauxScript } from "./faux.js";
import { FAUX_WARNING, providerFactory, resolveModels } from "./run.js";
import { oneLine } from "./sanitize.js";
import { xdgDirs } from "./xdg.js";

export const CALIBRATE_USAGE = `usage: rewire calibrate <provider:model> [--max <tokens>] [--yes] [--models <file>] [--fresh]

Measures the model's effective context window with needle-retrieval probes at 8K, 16K, 32K, ...
up to 95% of its window (or --max), and caches the result in $XDG_CACHE_HOME/rewire/calibration.json.
The chat session's compaction then triggers at the calibrated size. Never runs automatically.

  --max <tokens>   largest probe length
  --yes            required for paid providers (anthropic, openai): the probes cost input tokens
  --models <file>  the models file (default: models.toml discovery, as rewire run)
  --fresh          ignore cached results for this model and measure again
`;

/** Wall-clock cap of one probe call for providers without their own (Ollama has REWIRE_OLLAMA_TIMEOUT_S). */
export const PROBE_TIMEOUT_MS = 600_000;

const PAID = new Set<ModelRef["provider"]>(["anthropic", "openai"]);

export type CalibrateOptions = {
  model?: string | undefined;
  max?: string | undefined;
  models?: string | undefined;
  yes: boolean;
  fresh: boolean;
};

export type CalibrateIo = {
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seam: the provider for a ref (default: `providerFactory`). */
  providers?: (ref: ModelRef) => Provider;
  /** Test seam: the context window lookup (default: `contextWindow` with `env`). */
  window?: (ref: ModelRef) => Promise<ContextWindow>;
  /** Test seam: a millisecond clock. */
  now?: () => number;
};

const usage = (message: string) => new RewireError("usage", message, "rewire calibrate --help");

export const lengthLabel = (len: number): string =>
  len % 1024 === 0 ? `${len / 1024}K` : `${len}`;

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function progressLine(len: number, r: LengthResult, cached: boolean): string {
  const mark = r.score >= PASS_SCORE ? "✓" : "✗";
  const note = r.error !== undefined ? `  (${oneLine(r.error, 200)})` : "";
  return `${lengthLabel(len).padEnd(5)}${mark} ${r.score}/${MAX_SCORE}  · ${formatDuration(r.ms)}${cached ? "  (cached)" : ""}${note}`;
}

function parseMax(raw: string | undefined): number {
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const t = raw.trim().toLowerCase();
  const m = /^(\d+)(k?)$/.exec(t);
  const n = m ? Number(m[1]) * (m[2] === "k" ? 1024 : 1) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw usage(
      `--max must be a positive number of tokens (got ${JSON.stringify(raw.slice(0, 40))})`,
    );
  }
  return n;
}

const errorText = (e: unknown): string =>
  e instanceof RewireError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

/**
 * `rewire calibrate`: probe the model at doubling lengths, record each length's score in the
 * cache as it completes (so Ctrl-C then a re-run resumes), stop after two consecutive lengths
 * under 4/5, and report the effective window. Paid providers need `--yes`; the gate runs before
 * any provider is made. Returns the exit code (0 done, 130 interrupted); errors throw.
 */
export async function calibrateCommand(
  o: CalibrateOptions,
  io: CalibrateIo,
  signal: AbortSignal,
): Promise<number> {
  if (o.model === undefined || o.model.trim() === "") throw usage("no model given");
  const ref = parseModelRef(o.model.trim());
  const max = parseMax(o.max);
  const fauxPath = io.env.REWIRE_FAUX_SCRIPT;
  const faux = fauxPath ? loadFauxScript(fauxPath) : undefined;
  const models = await resolveModels(o.models, io.cwd, io.env, faux);
  const name = `${ref.provider}:${ref.model}`;
  if (!models.available.some((m) => m.provider === ref.provider && m.model === ref.model)) {
    throw new RewireError(
      "calibration_failed",
      `${name} is not among the available models`,
      "list it in models.toml (or --models), or run rewire doctor to see what is available",
    );
  }
  if (faux) io.stderr.write(`${FAUX_WARNING}\n`);
  const { cacheDir } = xdgDirs(io.env);
  const warn = (m: string) => io.stderr.write(`warning: ${oneLine(m, 300)}\n`);
  const window = await (io.window ?? ((r) => contextWindow(r, { env: io.env })))(ref);
  const plan = planLengths(window.window, max);
  if (plan.length === 0) {
    throw new RewireError(
      "calibration_failed",
      `nothing to measure: the smallest probe is ${lengthLabel(8192)} and ${name} allows ${Math.min(Math.floor(0.95 * window.window), max)} tokens`,
      window.source === "default" ? "the window lookup fell back to the default" : undefined,
    );
  }
  const cached = o.fresh
    ? undefined
    : await loadCalibration(ref, window.digest, { cacheDir, warn });
  const results: Record<string, LengthResult> = { ...(cached?.results ?? {}) };
  const todo = plan.filter((len) => results[String(len)] === undefined);

  // Paid gate: before any provider exists, so nothing can be spent.
  if (PAID.has(ref.provider) && !o.yes && todo.length > 0) {
    const tokens = todo.reduce((n, l) => n + l, 0);
    io.stderr.write(
      `calibrating ${name} sends up to ${todo.length} probes (${todo.map(lengthLabel).join(", ")}): about ${tokens.toLocaleString("en-US")} input tokens, billed by ${ref.provider}\n`,
    );
    throw new RewireError(
      "calibration_failed",
      `${ref.provider} is a paid provider: calibration needs --yes`,
      "re-run with --yes to spend",
    );
  }

  const providers = io.providers ?? providerFactory(io.env, faux);
  const now = io.now ?? Date.now;
  const timeoutMs = ref.provider === "ollama" ? ollamaChatTimeoutMs(io.env) : PROBE_TIMEOUT_MS;
  io.stdout.write(
    `calibrating ${name} (window ${window.window.toLocaleString("en-US")}${window.provisional ? ", provisional" : ""}): ${plan.map(lengthLabel).join(", ")}\n`,
  );
  const entry = (): CalibrationEntry => ({ results, window: window.window });
  let provider: Provider | undefined;
  let interrupted = false;
  for (const len of plan) {
    const key = String(len);
    const have = results[key];
    if (have !== undefined) {
      io.stdout.write(`${progressLine(len, have, true)}\n`);
      continue;
    }
    if (decide(results).stop) break;
    if (signal.aborted) {
      interrupted = true;
      break;
    }
    const estimator = new TokenEstimator();
    const probe = buildProbe(len, len, estimator);
    const started = now();
    let result: LengthResult;
    try {
      provider ??= providers(ref);
      const reply = await provider.chat({
        model: ref.model,
        system: probe.system,
        messages: [{ role: "user", content: probe.user }],
        maxTokens: PROBE_MAX_TOKENS,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        timeoutMs,
      });
      const estimated = estimator.estimate(probe.system, [{ role: "user", content: probe.user }]);
      const truncated = suspectTruncation(estimated, reply.usage.inputTokens);
      result = {
        score: score(reply.message.text, probe.answers),
        ms: now() - started,
        at: new Date().toISOString(),
        ...(truncated
          ? {
              error: `the provider read ${reply.usage.inputTokens} input tokens: the prompt was probably truncated`,
            }
          : {}),
      };
    } catch (e) {
      if (signal.aborted) {
        interrupted = true;
        break;
      }
      result = { score: 0, ms: now() - started, at: new Date().toISOString(), error: errorText(e) };
    }
    results[key] = result;
    await saveCalibration(ref, window.digest, entry(), { cacheDir, warn });
    io.stdout.write(`${progressLine(len, result, false)}\n`);
  }

  const measured = Object.keys(results).length;
  if (interrupted) {
    io.stderr.write(
      `interrupted: ${measured} length${measured === 1 ? "" : "s"} recorded; run the same command again to continue\n`,
    );
    return 130;
  }
  const { effective } = decide(results);
  const done: CalibrationEntry = {
    ...entry(),
    ...(effective !== undefined ? { effective } : {}),
    completedAt: new Date().toISOString(),
  };
  await saveCalibration(ref, window.digest, done, { cacheDir, warn });
  io.stdout.write(
    effective !== undefined
      ? `effective context: ${lengthLabel(effective)} (${effective.toLocaleString("en-US")} tokens)\n`
      : `effective context: below ${lengthLabel(plan[0] as number)} (no length scored ${PASS_SCORE}/${MAX_SCORE})\n`,
  );
  const override = compactionLimitOverride(models.compaction, ref);
  const limit = compactionLimit({
    window,
    calibrated: calibratedLimit(done) as number,
    latencyBudgetS: models.compaction.latencyBudgetS,
    ...(override !== undefined ? { override } : {}),
  });
  io.stdout.write(
    `compaction will trigger at ~${Math.floor(limit.limit / 1000)}k for this model (${limit.reason})\n`,
  );
  return 0;
}
