import { RewireError } from "@rewire/core";
import { findOllamaTag, getLoadedOllamaModel, showOllamaModel } from "./ollama.js";
import { ollamaBaseUrl } from "./registry.js";
import { type ChatMessage, type ModelRef, PROVIDER_NAMES, type ToolSpec } from "./types.js";

/** Where a context window came from, most trusted first. */
export type WindowSource = "loaded" | "model" | "table" | "default";
export type ContextWindow = {
  window: number;
  source: WindowSource;
  /**
   * True for every source but `loaded`: the number is a pre-flight guess, not the context a
   * request actually ran with. Re-read with `refreshContextWindow` after the first real turn.
   */
  provisional: boolean;
  digest?: string;
};

export type ContextWindowOptions = {
  env?: NodeJS.ProcessEnv;
  /** Ollama base URL; defaults to OLLAMA_HOST from `env`. */
  baseUrl?: string;
  /** Faux only: the window to report. Falls back to REWIRE_FAUX_WINDOW. */
  fauxWindow?: number;
};

/** The window assumed when nothing better is known. Deliberately small. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/**
 * Cap on a provisional Ollama `model`-source window. Ollama's server picks the runtime context
 * per model and per VRAM tier (or from OLLAMA_CONTEXT_LENGTH), often well below the trained
 * maximum in model_info: models advertising 262144 have been seen to load at 131072, and small
 * machines default to 4096. Requests over the OpenAI-compatible /v1 API cannot set num_ctx, so
 * until /api/ps reports the loaded context we never assume more than this.
 */
export const OLLAMA_PROVISIONAL_WINDOW_CAP = 131_072;

/** Faux only: the context window the faux provider reports (positive integer). */
export const FAUX_WINDOW_ENV = "REWIRE_FAUX_WINDOW";

/**
 * Known input windows, keyed by model-id prefix; the longest matching prefix wins.
 * as of 2026-11-25. Conservative: the standard (non-beta) window, and for models whose
 * input cap is below the total window, the input cap. Unlisted models get the default.
 * Owner: whoever adds a model family; a missing id only makes compaction start early (32K).
 */
export const WINDOW_TABLE: Readonly<
  Record<"anthropic" | "openai", ReadonlyArray<[string, number]>>
> = {
  anthropic: [
    ["claude-3", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-haiku-4", 200_000],
    // Later Claude generations keep the 200K standard window.
    ["claude-opus-", 200_000],
    ["claude-sonnet-", 200_000],
    ["claude-haiku-", 200_000],
  ],
  openai: [
    ["gpt-4", 8_192],
    ["gpt-4-32k", 32_768],
    ["gpt-4-turbo", 128_000],
    ["gpt-4.5", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4.1", 1_000_000],
    ["gpt-5", 272_000],
    ["o1", 200_000],
    ["o3", 200_000],
    ["o4-mini", 200_000],
  ],
};

const DEFAULT: ContextWindow = {
  window: DEFAULT_CONTEXT_WINDOW,
  source: "default",
  provisional: true,
};

function positiveInt(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function fromTable(rows: ReadonlyArray<[string, number]>, model: string): ContextWindow {
  let best: [string, number] | undefined;
  for (const row of rows) {
    if (model.startsWith(row[0]) && (best === undefined || row[0].length > best[0].length)) {
      best = row;
    }
  }
  return best ? { window: best[1], source: "table", provisional: true } : DEFAULT;
}

async function settle<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

/**
 * Ollama precedence: the loaded `context_length` (/api/ps), then `num_ctx` from /api/show
 * `parameters`, then model_info `*.context_length`, capped at OLLAMA_PROVISIONAL_WINDOW_CAP. Any
 * request failing only removes that source; a model missing from /api/tags gets the default
 * (even if /api/show answered: conservative on a transient /api/tags failure).
 */
async function ollamaWindow(baseUrl: string, model: string): Promise<ContextWindow> {
  const [loaded, tag, show] = await Promise.all([
    settle(getLoadedOllamaModel(baseUrl, model)),
    settle(findOllamaTag(baseUrl, model)),
    settle(showOllamaModel(baseUrl, model)),
  ]);
  const digest = loaded?.digest ?? tag?.digest;
  const withDigest = (w: number, source: WindowSource): ContextWindow => {
    const out: ContextWindow = { window: w, source, provisional: source !== "loaded" };
    return digest !== undefined ? { ...out, digest } : out;
  };
  if (loaded?.contextLength) return withDigest(loaded.contextLength, "loaded");
  // Not pulled (or tags unreadable): /api/show cannot describe what we would run.
  if (tag === undefined) return digest !== undefined ? { ...DEFAULT, digest } : DEFAULT;
  const fromShow = show?.numCtx ?? show?.contextLength ?? null;
  if (fromShow !== null) {
    return withDigest(Math.min(fromShow, OLLAMA_PROVISIONAL_WINDOW_CAP), "model");
  }
  return withDigest(DEFAULT_CONTEXT_WINDOW, "default");
}

/**
 * The context window for `ref`. Never throws for a known provider: a failed lookup gives the
 * default. Only an invalid ModelRef throws `context_window_unknown`.
 */
export async function contextWindow(
  ref: ModelRef,
  opts: ContextWindowOptions = {},
): Promise<ContextWindow> {
  assertRef(ref);
  const env = opts.env ?? process.env;
  switch (ref.provider) {
    case "anthropic":
    case "openai":
      return fromTable(WINDOW_TABLE[ref.provider], ref.model);
    case "faux": {
      const w = positiveInt(opts.fauxWindow) ?? positiveInt(Number(env[FAUX_WINDOW_ENV] ?? ""));
      return w !== null ? { window: w, source: "model", provisional: true } : DEFAULT;
    }
    case "ollama": {
      const baseUrl = resolveBaseUrl(opts, env);
      return baseUrl === undefined ? DEFAULT : ollamaWindow(baseUrl, ref.model);
    }
  }
}

/**
 * Re-reads the window after real traffic. For Ollama this asks /api/ps for the context the model
 * is loaded with now (call it after the first chat turn and whenever the model reloads); when it
 * is not loaded, or for other providers, it is the same as `contextWindow`. Never throws for a
 * known provider.
 */
export async function refreshContextWindow(
  ref: ModelRef,
  opts: ContextWindowOptions = {},
): Promise<ContextWindow> {
  assertRef(ref);
  if (ref.provider === "ollama") {
    const baseUrl = resolveBaseUrl(opts, opts.env ?? process.env);
    if (baseUrl === undefined) return DEFAULT;
    const loaded = await settle(getLoadedOllamaModel(baseUrl, ref.model));
    if (loaded?.contextLength) {
      const out: ContextWindow = {
        window: loaded.contextLength,
        source: "loaded",
        provisional: false,
      };
      return loaded.digest !== undefined ? { ...out, digest: loaded.digest } : out;
    }
  }
  return contextWindow(ref, opts);
}

function resolveBaseUrl(opts: ContextWindowOptions, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return opts.baseUrl ?? ollamaBaseUrl(env);
  } catch {
    return undefined;
  }
}

function assertRef(ref: ModelRef): void {
  if (
    !(PROVIDER_NAMES as readonly string[]).includes(ref?.provider) ||
    typeof ref.model !== "string" ||
    ref.model === ""
  ) {
    throw new RewireError(
      "context_window_unknown",
      `cannot find a context window for model ref ${JSON.stringify(ref)}`,
      `use <provider>:<model> with provider one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
}

/** Characters of the request as a provider would send it: text, tool calls, tool results, specs. */
function requestChars(system: string, messages: ChatMessage[], tools?: ToolSpec[]): number {
  let n = system.length;
  for (const m of messages) {
    n += m.role.length + m.content.length;
    if (m.toolCallId !== undefined) n += m.toolCallId.length;
    for (const c of m.toolCalls ?? []) {
      n += c.id.length + c.name.length + JSON.stringify(c.arguments).length;
    }
  }
  for (const t of tools ?? []) {
    n += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  }
  return n;
}

/**
 * Uncorrected token estimate: chars/4 over the request, rounded up. Note the argument order,
 * (messages, system), is the reverse of `TokenEstimator.estimate(system, messages)`. Pass the
 * same `tools` the provider sends: omitting them silently undercounts. Not counted: provider
 * wrappers, chat-template tokens, tool-prompt preambles; the estimator's ratio absorbs those.
 */
export function estimateTokens(
  messages: ChatMessage[],
  system: string,
  tools?: ToolSpec[],
): number {
  return Math.ceil(requestChars(system, messages, tools) / 4);
}

export const MIN_TOKEN_RATIO = 0.5;
export const MAX_TOKEN_RATIO = 2;
/** Weight of each new observation in the correction ratio's moving average. */
export const TOKEN_RATIO_ALPHA = 0.3;
/** Samples with actual/estimated outside this range are mismatches or truncation: ignored. */
export const MIN_SAMPLE_RATIO = 0.25;
export const MAX_SAMPLE_RATIO = 4;
/** Prompts over this many estimated tokens are checked for silent truncation. */
export const TRUNCATION_MIN_ESTIMATE = 8_192;
/** actual < this × estimated on a large prompt suggests the server dropped part of it. */
export const TRUNCATION_RATIO = 0.6;

/** Shown when `suspectTruncation` fires on Ollama: its runtime context is smaller than the prompt. */
export const OLLAMA_TRUNCATION_HINT =
  "Ollama may be truncating the prompt to a small context. Set OLLAMA_CONTEXT_LENGTH (for example 65536) on the Ollama server, or create a model with a larger num_ctx in its Modelfile.";

/**
 * True when the provider reported far fewer input tokens than estimated on a large prompt
 * (actual < 0.6 × estimated, estimated > 8192): the server probably truncated the prompt.
 */
export function suspectTruncation(estimated: number, actualInputTokens: number): boolean {
  return (
    Number.isFinite(estimated) &&
    Number.isFinite(actualInputTokens) &&
    estimated > TRUNCATION_MIN_ESTIMATE &&
    actualInputTokens >= 0 &&
    actualInputTokens < TRUNCATION_RATIO * estimated
  );
}

const clampRatio = (r: number) => Math.min(MAX_TOKEN_RATIO, Math.max(MIN_TOKEN_RATIO, r));

/**
 * chars/4 estimates, corrected by a running ratio of real `usage.inputTokens` to the estimate.
 * Pure: no I/O; state is just the ratio.
 */
export class TokenEstimator {
  private r: number;
  private observed: boolean;

  constructor(opts: { ratio?: number } = {}) {
    const start = opts.ratio;
    this.observed = start !== undefined && Number.isFinite(start) && start > 0;
    this.r = this.observed ? clampRatio(start as number) : 1;
  }

  get ratio(): number {
    return this.r;
  }

  /** See the standalone `suspectTruncation`. */
  suspectTruncation(estimated: number, actualInputTokens: number): boolean {
    return suspectTruncation(estimated, actualInputTokens);
  }

  /** Corrected estimate of the input tokens for this request. */
  estimate(system: string, messages: ChatMessage[], tools?: ToolSpec[]): number {
    return Math.ceil(estimateTokens(messages, system, tools) * this.r);
  }

  /**
   * Feeds back a real count. `estimated` is what `estimate()` returned for that request. The
   * first observation sets the ratio; later ones move it as an EMA. The ratio stays within
   * 0.5..2.0. Ignored, so they cannot drag the ratio down: non-positive or non-finite values
   * (e.g. faux usage of 0), samples with actual/estimated outside 0.25..4 (a mismatch or
   * truncation), and samples where `suspectTruncation` holds (a truncated prompt reports fewer
   * tokens, which would make the estimator undercount and compaction never fire).
   */
  observe(estimated: number, actualInputTokens: number): void {
    if (!(Number.isFinite(estimated) && estimated > 0)) return;
    if (!(Number.isFinite(actualInputTokens) && actualInputTokens > 0)) return;
    const seen = actualInputTokens / estimated;
    if (seen < MIN_SAMPLE_RATIO || seen > MAX_SAMPLE_RATIO) return;
    if (suspectTruncation(estimated, actualInputTokens)) return;
    const sample = this.r * seen;
    this.r = clampRatio(
      this.observed ? (1 - TOKEN_RATIO_ALPHA) * this.r + TOKEN_RATIO_ALPHA * sample : sample,
    );
    this.observed = true;
  }
}
