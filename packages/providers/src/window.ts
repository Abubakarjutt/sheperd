import { RewireError } from "@rewire/core";
import { findOllamaTag, getLoadedOllamaModel, showOllamaModel } from "./ollama.js";
import { ollamaBaseUrl } from "./registry.js";
import { type ChatMessage, type ModelRef, PROVIDER_NAMES, type ToolSpec } from "./types.js";

/** Where a context window came from, most trusted first. */
export type WindowSource = "loaded" | "model" | "table" | "default";
export type ContextWindow = { window: number; source: WindowSource; digest?: string };

export type ContextWindowOptions = {
  env?: NodeJS.ProcessEnv;
  /** Ollama base URL; defaults to OLLAMA_HOST from `env`. */
  baseUrl?: string;
  /** Faux only: the window to report. Falls back to REWIRE_FAUX_WINDOW. */
  fauxWindow?: number;
};

/** The window assumed when nothing better is known. Deliberately small. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/** Faux only: the context window the faux provider reports (positive integer). */
export const FAUX_WINDOW_ENV = "REWIRE_FAUX_WINDOW";

/**
 * Known input windows, keyed by model-id prefix; the longest matching prefix wins.
 * as of 2026-11-25. Conservative: the standard (non-beta) window, and for models whose
 * input cap is below the total window, the input cap. Unlisted models get the default.
 */
export const WINDOW_TABLE: Readonly<
  Record<"anthropic" | "openai", ReadonlyArray<[string, number]>>
> = {
  anthropic: [
    ["claude-3", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-haiku-4", 200_000],
  ],
  openai: [
    ["gpt-4", 8_192],
    ["gpt-4-turbo", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4.1", 1_000_000],
    ["gpt-5", 272_000],
    ["o1", 200_000],
    ["o3", 200_000],
    ["o4-mini", 200_000],
  ],
};

const DEFAULT: ContextWindow = { window: DEFAULT_CONTEXT_WINDOW, source: "default" };

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
  return best ? { window: best[1], source: "table" } : DEFAULT;
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
 * `parameters`, then model_info `*.context_length`. Any request failing only removes that source;
 * a model missing from /api/tags gets the default.
 */
async function ollamaWindow(baseUrl: string, model: string): Promise<ContextWindow> {
  const [loaded, tag, show] = await Promise.all([
    settle(getLoadedOllamaModel(baseUrl, model)),
    settle(findOllamaTag(baseUrl, model)),
    settle(showOllamaModel(baseUrl, model)),
  ]);
  const digest = loaded?.digest ?? tag?.digest;
  const withDigest = (w: number, source: WindowSource): ContextWindow =>
    digest !== undefined ? { window: w, source, digest } : { window: w, source };
  if (loaded?.contextLength) return withDigest(loaded.contextLength, "loaded");
  // Not pulled (or tags unreadable): /api/show cannot describe what we would run.
  if (tag === undefined) return digest !== undefined ? { ...DEFAULT, digest } : DEFAULT;
  const fromShow = show?.numCtx ?? show?.contextLength ?? null;
  if (fromShow !== null) return withDigest(fromShow, "model");
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
  const env = opts.env ?? process.env;
  switch (ref.provider) {
    case "anthropic":
    case "openai":
      return fromTable(WINDOW_TABLE[ref.provider], ref.model);
    case "faux": {
      const w = positiveInt(opts.fauxWindow) ?? positiveInt(Number(env[FAUX_WINDOW_ENV] ?? ""));
      return w !== null ? { window: w, source: "model" } : DEFAULT;
    }
    case "ollama": {
      let baseUrl: string;
      try {
        baseUrl = opts.baseUrl ?? ollamaBaseUrl(env);
      } catch {
        return DEFAULT;
      }
      return ollamaWindow(baseUrl, ref.model);
    }
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

/** Uncorrected token estimate: chars/4 over the request, rounded up. */
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

  /** Corrected estimate of the input tokens for this request. */
  estimate(system: string, messages: ChatMessage[], tools?: ToolSpec[]): number {
    return Math.ceil(estimateTokens(messages, system, tools) * this.r);
  }

  /**
   * Feeds back a real count. `estimated` is what `estimate()` returned for that request. The
   * first observation sets the ratio; later ones move it as an EMA. Non-positive or
   * non-finite values (e.g. faux usage of 0) are ignored. The ratio stays within 0.5..2.0.
   */
  observe(estimated: number, actualInputTokens: number): void {
    if (!(Number.isFinite(estimated) && estimated > 0)) return;
    if (!(Number.isFinite(actualInputTokens) && actualInputTokens > 0)) return;
    const sample = this.r * (actualInputTokens / estimated);
    this.r = clampRatio(
      this.observed ? (1 - TOKEN_RATIO_ALPHA) * this.r + TOKEN_RATIO_ALPHA * sample : sample,
    );
    this.observed = true;
  }
}
