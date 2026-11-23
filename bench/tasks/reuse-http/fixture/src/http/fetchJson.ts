export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export type FetchJsonOptions = {
  /** Extra attempts after the first one, for network errors and 5xx. Default 2. */
  retries?: number;
  /** Per-attempt timeout. Default 5000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
};

/** GET a JSON document with retries on network errors and 5xx, and a per-attempt timeout. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (res.status >= 500) {
        lastError = new HttpError(res.status, url);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
