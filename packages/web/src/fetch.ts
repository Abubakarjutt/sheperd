import { BUNDLE_VERSION } from "@rewire/core";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";
import { WebError } from "./error.js";
import { htmlToText } from "./html.js";
import { checkOutgoingUrl } from "./outgoing.js";
import { defaultResolver, pinnedLookup, type Resolver, vetHost } from "./ssrf.js";

/** Sent on every request; carries no user or machine details. */
export const USER_AGENT = `rewire/${BUNDLE_VERSION ?? "dev"}`;

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_URL_CHARS = 2048;
export const MAX_REDIRECTS = 5;

/** What `webFetch` and `webSearch` hand to their `fetch`. */
export type WebRequestInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  redirect: "manual" | "error";
  signal: AbortSignal;
  /**
   * The pinned-address dispatcher (`webFetch` only). A fetch that ignores it loses the DNS
   * rebinding guard, so `webFetch` always uses `defaultFetch`; only tests inject another.
   */
  dispatcher?: Dispatcher;
};

/** A `fetch`: `webSearch` takes one (tests); `webFetch` never does (see `webFetchUsing`). */
export type WebFetchFn = (url: string, init: WebRequestInit) => Promise<Response>;

/** undici's own `fetch`, so the undici `Agent` passed as `dispatcher` is honoured. */
export const defaultFetch: WebFetchFn = (url, init) =>
  undiciFetch(url, init) as unknown as Promise<Response>;

export type WebFetchOptions = {
  resolve?: Resolver;
  signal?: AbortSignal;
  /**
   * A policy check on each hop's host, given lowercased and without a trailing dot: the refusal
   * (naming the rule), or undefined to allow.
   */
  isAllowed?: (host: string) => string | undefined;
  /** Overrides of the caps, for tests. */
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
};

export type WebFetchResult = {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  /** The media type without parameters, e.g. `text/html`. */
  contentType: string;
  text: string;
  /** True when the body or the text was cut at a cap. */
  truncated: boolean;
};

/** Checks every hop's URL before it is requested. */
function checkUrl(raw: string): URL {
  if (raw.length > MAX_URL_CHARS) {
    throw new WebError(`refused: the URL is longer than ${MAX_URL_CHARS} characters`);
  }
  // The raw string first: `URL` lowercases the host, which hides an upper-case key pattern.
  const rawSecret = checkOutgoingUrl(raw);
  if (rawSecret !== undefined) throw new WebError(rawSecret);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError("refused: not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WebError(`refused: only http and https URLs are fetched, not ${u.protocol}`);
  }
  if (u.username !== "" || u.password !== "") {
    throw new WebError("refused: the URL carries credentials (user:password@)");
  }
  if (u.href.length > MAX_URL_CHARS) {
    throw new WebError(`refused: the URL is longer than ${MAX_URL_CHARS} characters`);
  }
  const secret = checkOutgoingUrl(u.href);
  if (secret !== undefined) throw new WebError(secret);
  return u;
}

const TEXT_TYPES = /^(?:text\/[a-z0-9.+-]+|application\/(?:[a-z0-9.-]+\+)?(?:json|xml))$/;
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * GET `url` from this process with the SSRF guard: every hop's URL is checked (http(s) only,
 * length, no credentials, no secret), passed through `isAllowed`, and its host resolved and
 * vetted; the connection goes to the vetted address (no DNS rebinding). Redirects are followed
 * by hand, at most 5. Only text types are read; HTML becomes text with links kept. Throws
 * `WebError` for every refusal and expected failure; a caller's abort is re-thrown as is.
 */
export function webFetch(url: string, o: WebFetchOptions = {}): Promise<WebFetchResult> {
  return webFetchUsing(defaultFetch, url, o);
}

/**
 * `webFetch` over an injected transport. Test-only: it is not exported from the package entry,
 * because a transport that drops `dispatcher` would silently lose the pinned address.
 */
export async function webFetchUsing(
  fetchFn: WebFetchFn,
  url: string,
  o: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const resolve = o.resolve ?? defaultResolver;
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const agents: Agent[] = [];
  const timedOut = (): WebError =>
    new WebError(`timed out after ${Math.round(timeoutMs / 1000)} s (${timeoutMs} ms)`);
  try {
    let current = checkUrl(url);
    for (let hop = 0; ; hop++) {
      const refused = o.isAllowed?.(current.hostname.toLowerCase().replace(/\.$/, ""));
      if (refused !== undefined) throw new WebError(`refused by policy: ${refused}`);
      let pin: Awaited<ReturnType<typeof vetHost>>;
      try {
        pin = await vetHost(current.hostname, resolve, signal);
      } catch (e) {
        if (timeout.aborted) throw timedOut();
        throw e;
      }
      const agent = new Agent({ connect: { lookup: pinnedLookup(pin) } });
      agents.push(agent);
      let res: Response;
      try {
        res = await fetchFn(current.href, {
          method: "GET",
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html, text/*;q=0.9, application/json;q=0.8, application/xml;q=0.8",
          },
          redirect: "manual",
          signal,
          dispatcher: agent,
        });
      } catch (e) {
        if (timeout.aborted) throw timedOut();
        if (o.signal?.aborted) throw e;
        throw new WebError(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS)
          throw new WebError(`refused: more than ${MAX_REDIRECTS} redirects`);
        // The raw Location too, before `URL` normalises it (and lowercases its host).
        const rawSecret = checkOutgoingUrl(location);
        if (rawSecret !== undefined) throw new WebError(rawSecret);
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new WebError("refused: a redirect to an invalid URL");
        }
        current = checkUrl(next);
        continue;
      }
      const header = res.headers.get("content-type");
      const contentType = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (contentType === "" || !TEXT_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new WebError(
          contentType === ""
            ? "refused: the response has no content type; only text, JSON and XML are read"
            : `refused: ${contentType} is not text; only text, JSON and XML are read`,
        );
      }
      let body: { bytes: Uint8Array; truncated: boolean };
      try {
        body = await readCapped(res, o.maxBytes ?? MAX_BODY_BYTES, signal);
      } catch (e) {
        if (timeout.aborted) throw timedOut();
        throw e;
      }
      const decoded = decode(body.bytes, header ?? "", HTML_TYPES.has(contentType));
      const maxChars = o.maxChars ?? MAX_TEXT_CHARS;
      let text: string;
      let cut: boolean;
      if (HTML_TYPES.has(contentType)) {
        const t = htmlToText(decoded, current.href, maxChars);
        text = t.text;
        cut = t.truncated;
      } else {
        cut = decoded.length > maxChars;
        text = cut ? decoded.slice(0, maxChars) : decoded;
      }
      return {
        url: current.href,
        status: res.status,
        contentType,
        text,
        truncated: body.truncated || cut,
      };
    }
  } finally {
    for (const a of agents) void a.destroy().catch(() => {});
  }
}

/** Read at most `max` bytes of the body, giving up when `signal` aborts. */
async function readCapped(
  res: Response,
  max: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (res.body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (size + value.byteLength > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated || signal.aborted) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, truncated };
}

/**
 * The header's charset; for HTML without one, a `<meta charset>` (or http-equiv content type)
 * in the first 1024 bytes; else UTF-8. An unknown label falls back to UTF-8.
 */
function decode(bytes: Uint8Array, contentType: string, html: boolean): string {
  let charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
  if (charset === undefined && html) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    charset = /<meta\b[^>]{0,512}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]{1,40})/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
