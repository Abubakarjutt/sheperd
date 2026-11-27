import type { Writable } from "node:stream";
import { RewireError, redact } from "@rewire/core";
import { compactionLimitOverride } from "@rewire/pipeline";
import {
  builtinProvider,
  type ContextWindow,
  contextWindow,
  endpointConfig,
  type ModelRef,
  OLLAMA_TRUNCATION_HINT,
  ollamaChatTimeoutMs,
  type Provider,
  type ProviderName,
  parseModelRef,
  refreshContextWindow,
  TokenEstimator,
  TRUNCATION_RATIO,
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
  MIN_PROBE_LENGTH,
  PASS_SCORE,
  PROBE_MAX_TOKENS,
  planLengths,
  saveCalibration,
  score,
  windowChanged,
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
  --yes            required for paid providers (all but ollama and a loopback endpoint): the probes cost input tokens
  --models <file>  the models file (default: models.toml discovery, as rewire run)
  --fresh          ignore cached results for this model and measure again
`;

/** Wall-clock cap of one probe call for providers without their own (Ollama has REWIRE_OLLAMA_TIMEOUT_S). */
export const PROBE_TIMEOUT_MS = 600_000;

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);

/**
 * Paid providers need `--yes`: every provider except Ollama, faux and an endpoint whose
 * `base_url` is loopback. An unknown name fails closed (paid).
 */
export function isPaidProvider(provider: string): boolean {
  const builtin = builtinProvider(provider);
  if (builtin !== undefined) return builtin !== "ollama" && builtin !== "faux";
  const endpoint = endpointConfig(provider);
  if (endpoint === undefined) return true;
  try {
    return !isLoopbackHost(new URL(endpoint.baseUrl).hostname);
  } catch {
    return true;
  }
}

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
  /**
   * Test seam: re-reads the window after the first probe (default: `refreshContextWindow` for
   * Ollama, whose loaded runtime window is known only after a request; none otherwise).
   */
  refreshWindow?: (ref: ModelRef) => Promise<ContextWindow>;
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
  const label = lengthLabel(len).padEnd(5);
  if (!("score" in r)) return `${label}⚠ error: ${oneLine(redact(r.error), 80)} (will retry)`;
  const mark = r.score >= PASS_SCORE ? "✓" : "✗";
  return `${label}${mark} ${r.score}/${MAX_SCORE}  · ${formatDuration(r.ms)}${cached ? "  (cached)" : ""}`;
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

/** A short stable label for a provider failure: the RewireError code, `timeout`, or the errno. */
function errorCode(e: unknown): string {
  if (e instanceof RewireError) return e.code;
  const err = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
  if (err?.name === "TimeoutError") return "timeout";
  for (const c of [err?.code, err?.cause?.code]) {
    if (typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c)) return c;
  }
  return typeof err?.name === "string" && err.name !== "" ? err.name : "error";
}

const errorText = (e: unknown): string => {
  const message = e instanceof Error ? e.message : String(e);
  return redact(`${errorCode(e)}: ${message}`).slice(0, 500);
};

/** What to check when probes keep failing. */
const ERROR_HINT: Record<ProviderName, string> = {
  ollama: "is Ollama running? check OLLAMA_HOST and `ollama ps`, or raise REWIRE_OLLAMA_TIMEOUT_S",
  anthropic: "check ANTHROPIC_API_KEY, the network and the rate limits",
  openai: "check OPENAI_API_KEY, the network and the rate limits",
  faux: "check the faux script (REWIRE_FAUX_SCRIPT)",
  bedrock: "check the AWS credentials and region, the network and the rate limits",
  vertex: "check the Google Cloud credentials, project and region, the network and the rate limits",
  foundry:
    "check ANTHROPIC_FOUNDRY_API_KEY and the Foundry resource, the network and the rate limits",
  azure: "check AZURE_OPENAI_API_KEY and the Azure endpoint, the network and the rate limits",
  gemini: "check GEMINI_API_KEY, the network and the rate limits",
};

const errorHint = (provider: string): string => {
  const builtin = builtinProvider(provider);
  return builtin !== undefined
    ? ERROR_HINT[builtin]
    : `check the [endpoints.${provider}] base_url and api_key_env, the network and the rate limits`;
};

/** Two provider errors in a row end the run (the recorded lengths are kept). */
export const MAX_CONSECUTIVE_ERRORS = 2;

/**
 * `rewire calibrate`: probe the model at doubling lengths, record each length in the cache as it
 * completes (so Ctrl-C then a re-run resumes), stop after two consecutive scored lengths under
 * 4/5, and report the effective window. A provider error is not a score: it is recorded as an
 * error, retried by the next run, and leaves the run incomplete; two in a row end the run. A
 * truncated prompt (the provider read < 0.6 of the estimate) stops the run, never scored. Paid
 * providers need `--yes`; the gate runs before any provider is made. Returns 0 when complete,
 * 130 when interrupted; failures throw `calibration_failed`.
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
      `nothing to measure: the smallest probe is ${lengthLabel(MIN_PROBE_LENGTH)} and ${name} allows ${Math.min(Math.floor(0.95 * window.window), max)} tokens`,
      window.source === "default" ? "the window lookup fell back to the default" : undefined,
    );
  }
  let digest = window.digest;
  let cached = o.fresh ? undefined : await loadCalibration(ref, digest, { cacheDir, warn });
  const staleNote = (measured: number, now: number) =>
    io.stderr.write(
      `calibration stale: window changed (measured at ${measured.toLocaleString("en-US")}, now ${now.toLocaleString("en-US")}): measuring again\n`,
    );
  if (cached !== undefined && !window.provisional && windowChanged(cached.window, window.window)) {
    staleNote(cached.window, window.window);
    cached = undefined;
  }
  let results: Record<string, LengthResult> = { ...(cached?.results ?? {}) };
  const inPlan = () =>
    Object.fromEntries(plan.flatMap((l) => (results[l] ? [[String(l), results[l]]] : [])));
  const needs = (len: number) => {
    const r = results[String(len)];
    return r === undefined || !("score" in r);
  };
  const todo = decide(inPlan()).stop ? [] : plan.filter(needs);

  // Paid gate: before any provider exists, so nothing can be spent.
  if (isPaidProvider(ref.provider) && !o.yes && todo.length > 0) {
    const tokens = todo.reduce((n, l) => n + l, 0);
    io.stderr.write(
      `calibrating ${name} sends up to ${todo.length} probes (${todo.map(lengthLabel).join(", ")}): at most about ${tokens.toLocaleString("en-US")} input tokens billed by ${ref.provider} (a token count, not a price: rewire has no price table)\n`,
    );
    throw new RewireError(
      "calibration_failed",
      `${ref.provider} is a paid provider: calibration needs --yes`,
      "re-run with --yes to spend",
    );
  }

  const providers = io.providers ?? providerFactory(io.env, faux, models.providers);
  const refreshWindow =
    io.refreshWindow ??
    (ref.provider === "ollama"
      ? (r: ModelRef) => refreshContextWindow(r, { env: io.env })
      : undefined);
  const now = io.now ?? Date.now;
  const timeoutMs = ref.provider === "ollama" ? ollamaChatTimeoutMs(io.env) : PROBE_TIMEOUT_MS;
  io.stdout.write(
    `calibrating ${name} (window ${window.window.toLocaleString("en-US")}${window.provisional ? ", provisional" : ""}): ${plan.map(lengthLabel).join(", ")}\n`,
  );
  // The window the run measures with: for Ollama the loaded window, known after the first probe.
  let measured = window.window;
  let refreshed = false;
  const entry = (): CalibrationEntry => ({ results, window: measured });
  const save = (e: CalibrationEntry) => saveCalibration(ref, digest, e, { cacheDir, warn });
  let provider: Provider | undefined;
  let interrupted = false;
  let errorsInARow = 0;
  for (const len of plan) {
    const key = String(len);
    const have = results[key];
    if (have !== undefined && "score" in have) {
      io.stdout.write(`${progressLine(len, have, true)}\n`);
      continue;
    }
    if (decide(inPlan()).stop) break;
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
      if (!refreshed && refreshWindow !== undefined) {
        refreshed = true;
        const w = await refreshWindow(ref).catch(() => undefined);
        if (w !== undefined && w.source === "loaded") {
          if (Object.keys(results).length > 0 && windowChanged(measured, w.window)) {
            staleNote(measured, w.window);
            results = {};
          }
          measured = w.window;
          digest ??= w.digest;
        }
      }
      const estimated = estimator.estimate(probe.system, [{ role: "user", content: probe.user }]);
      const read = reply.usage.inputTokens;
      if (Number.isFinite(read) && read > 0 && read < TRUNCATION_RATIO * estimated) {
        // Never a score: the model did not see the whole probe.
        delete results[key];
        await save({ ...entry(), truncated: { length: len, inputTokens: read, estimated } });
        io.stdout.write(
          `${lengthLabel(len).padEnd(5)}⚠ truncated: the provider read ${read.toLocaleString("en-US")} of ~${estimated.toLocaleString("en-US")} tokens\n`,
        );
        throw new RewireError(
          "calibration_failed",
          `${name} truncated the ${lengthLabel(len)} probe: its runtime context is smaller than the prompt`,
          ref.provider === "ollama"
            ? OLLAMA_TRUNCATION_HINT
            : "the provider's context is smaller than the probe; lower --max",
        );
      }
      errorsInARow = 0;
      result = {
        score: score(reply.message.text, probe.answers),
        ms: now() - started,
        at: new Date().toISOString(),
      };
    } catch (e) {
      if (e instanceof RewireError && e.code === "calibration_failed") throw e;
      if (signal.aborted) {
        interrupted = true;
        break;
      }
      result = { error: errorText(e), ms: now() - started, at: new Date().toISOString() };
      errorsInARow++;
    }
    results[key] = result;
    await save(entry());
    io.stdout.write(`${progressLine(len, result, false)}\n`);
    if (errorsInARow >= MAX_CONSECUTIVE_ERRORS) {
      throw new RewireError(
        "calibration_failed",
        `${MAX_CONSECUTIVE_ERRORS} probes in a row failed (last: ${"error" in result ? oneLine(result.error, 200) : "?"}); the lengths measured so far are kept`,
        errorHint(ref.provider),
      );
    }
  }

  const recorded = Object.values(results).filter((r) => "score" in r).length;
  if (interrupted) {
    io.stderr.write(
      `interrupted: ${recorded} length${recorded === 1 ? "" : "s"} recorded; run the same command again to continue\n`,
    );
    return 130;
  }
  const final = inPlan();
  const errored = Object.entries(final)
    .filter(([, r]) => !("score" in r))
    .map(([l]) => lengthLabel(Number(l)));
  if (errored.length > 0) {
    throw new RewireError(
      "calibration_failed",
      `calibration incomplete: ${errored.join(", ")} failed with a provider error`,
      `run the same command again to retry ${errored.length === 1 ? "it" : "them"}`,
    );
  }
  const { effective } = decide(final);
  const done: CalibrationEntry = {
    results: final,
    window: measured,
    ...(effective !== undefined ? { effective } : {}),
    completedAt: new Date().toISOString(),
  };
  await save(done);
  io.stdout.write(
    effective !== undefined
      ? `effective context: ${lengthLabel(effective)} (${effective.toLocaleString("en-US")} tokens)\n`
      : `effective context: below ${lengthLabel(plan[0] as number)} (no length scored ${PASS_SCORE}/${MAX_SCORE})\n`,
  );
  const override = compactionLimitOverride(models.compaction, ref);
  const limit = compactionLimit({
    window: { ...window, window: measured },
    calibrated: calibratedLimit(done) as number,
    latencyBudgetS: models.compaction.latencyBudgetS,
    ...(override !== undefined ? { override } : {}),
  });
  io.stdout.write(
    `compaction will trigger at ~${Math.floor(limit.limit / 1000)}k for this model (${limit.reason})\n`,
  );
  return 0;
}
