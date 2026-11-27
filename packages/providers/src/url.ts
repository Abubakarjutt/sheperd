/** The one loopback check: `localhost`, `127.x.x.x` or `[::1]`, as `URL.hostname` spells them. */
export const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);

/** True when `s` is an absolute URL (any scheme) whose host is loopback. */
export function isLoopbackUrl(s: string): boolean {
  try {
    return isLoopbackHost(new URL(s).hostname);
  } catch {
    return false;
  }
}

/**
 * Why `s` cannot be a provider base URL, or undefined when it can: it must be absolute, carry no
 * credentials, query or fragment, and be https (http only on a loopback host).
 */
export function baseUrlProblem(s: string): string | undefined {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "must be an absolute https URL";
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    return "must not carry credentials, a query or a fragment";
  }
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return undefined;
  return "must be https (http only for localhost, 127.0.0.1 or [::1])";
}
