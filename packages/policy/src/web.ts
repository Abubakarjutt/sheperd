import type { WebPolicy } from "./defaults.js";

/** A host name as policy compares it: lowercase, without trailing dots. */
export const normalizeHost = (host: string): string => host.toLowerCase().replace(/\.+$/, "");

/** `host` is `domain` or one of its subdomains (both normalized). */
export const domainWithin = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const DOMAIN = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);

/**
 * Why `raw` is not a valid `[web]` domain entry, or undefined. An entry is a bare host name
 * (it matches its subdomains too): no scheme, port, path or wildcard.
 */
export function domainProblem(raw: string): string | undefined {
  const d = normalizeHost(raw.trim());
  if (d === "") return "a domain must not be empty";
  if (d.startsWith("*."))
    return `"${raw}": write the domain without "*." (it matches its subdomains)`;
  if (!DOMAIN.test(d)) return `"${raw}" is not a domain name (no scheme, port, path or spaces)`;
  return undefined;
}

/**
 * The refusal (naming the rule) for a web request to `host`, or undefined when policy allows
 * it. Applies to fetch targets, each redirect hop, and the URLs of search results shown.
 */
export function webHostRefusal(web: WebPolicy, host: string): string | undefined {
  if (!web.enabled) return "web access is off ([web] enabled = false)";
  const h = normalizeHost(host);
  const denied = web.denyDomains.find((d) => domainWithin(h, d));
  if (denied !== undefined) return `${h} matches [web] deny_domains entry "${denied}"`;
  if (web.allowDomains !== undefined && !web.allowDomains.some((d) => domainWithin(h, d)))
    return `${h} is not in [web] allow_domains`;
  return undefined;
}
