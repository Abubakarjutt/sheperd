import { RewireError, redact } from "@rewire/core";

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
  opts: { apiKey?: string; secrets?: readonly string[]; signal?: AbortSignal | undefined } = {},
): RewireError {
  if (err instanceof RewireError) return err;
  if (opts.signal?.aborted || isAbort(err)) {
    return new RewireError("provider_aborted", `${provider} request aborted`);
  }
  const raw = collectMessages(err).join(" | ") || String(err);
  return new RewireError(
    "provider_error",
    `${provider} request failed: ${scrub(raw, [opts.apiKey, ...(opts.secrets ?? [])])}`,
  );
}

function scrub(s: string, secrets: readonly (string | undefined)[]): string {
  let out = s;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length >= 8) out = out.replaceAll(secret, "[redacted]");
  }
  return (
    redact(out)
      .replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
      // Google OAuth access tokens, and the credential parts of a SigV4-signed URL or header.
      .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
      .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi, "$1[redacted]")
      .replace(/((?:Signature|Credential)=)[A-Za-z0-9/+=_-]{8,}/g, "$1[redacted]")
      .slice(0, 500)
  );
}

/**
 * A throw from one of the caller's stream callbacks (`onDelta`, `onFirstChunk`): surfaced as-is,
 * never as a transport error.
 */
export function streamCallbackFailed(err: unknown, callback = "onDelta"): RewireError {
  return new RewireError(
    "provider_stream_callback_failed",
    `the ${callback} stream callback threw: ${err instanceof Error ? err.message : String(err)}`,
  );
}
