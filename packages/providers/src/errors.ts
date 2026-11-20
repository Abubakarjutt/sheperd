import { RewireError } from "@rewire/core";

/** Wrap an SDK/network error without leaking secrets; keep the original off the message. */
export function providerError(provider: string, err: unknown): RewireError {
  if (err instanceof RewireError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const e = new RewireError("provider_error", `${provider} request failed: ${scrub(raw)}`);
  return e;
}

function scrub(s: string): string {
  return s
    .replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .slice(0, 500);
}
