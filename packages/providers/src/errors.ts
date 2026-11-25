import { RewireError } from "@rewire/core";

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "APIUserAbortError" ||
    err.constructor.name === "APIUserAbortError"
  );
}

function collectMessages(err: unknown, depth = 0): string[] {
  if (depth > 4 || typeof err !== "object" || err === null) return [];
  const out: string[] = [];
  const o = err as { message?: unknown; error?: unknown };
  if (typeof o.message === "string") out.push(o.message);
  out.push(...collectMessages(o.error, depth + 1));
  return out;
}

/**
 * Wrap an SDK/network error without leaking secrets. The real API key (when long enough)
 * is redacted literally, then key-shaped tokens are redacted by pattern.
 * Aborts become `provider_aborted` so callers can tell cancellation from failure.
 */
export function providerError(
  provider: string,
  err: unknown,
  opts: { apiKey?: string; signal?: AbortSignal | undefined } = {},
): RewireError {
  if (err instanceof RewireError) return err;
  if (opts.signal?.aborted || isAbort(err)) {
    return new RewireError("provider_aborted", `${provider} request aborted`);
  }
  const raw = collectMessages(err).join(" | ") || String(err);
  return new RewireError(
    "provider_error",
    `${provider} request failed: ${scrub(raw, opts.apiKey)}`,
  );
}

function scrub(s: string, apiKey?: string): string {
  let out = s;
  if (apiKey !== undefined && apiKey.length >= 8) out = out.replaceAll(apiKey, "[redacted]");
  return out
    .replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .slice(0, 500);
}

/** A throw from the caller's `onDelta` stream callback: surfaced as-is, never as a transport error. */
export function streamCallbackFailed(err: unknown): RewireError {
  return new RewireError(
    "provider_stream_callback_failed",
    `the onDelta stream callback threw: ${err instanceof Error ? err.message : String(err)}`,
  );
}
