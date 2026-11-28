/**
 * A web call that was refused or failed in an expected way (SSRF, policy, a secret in the query,
 * an HTTP error, a non-text type, a timeout). Callers turn it into a tool error result; it is not
 * a `RewireError` and has no code.
 */
export class WebError extends Error {
  override readonly name = "WebError";
}
