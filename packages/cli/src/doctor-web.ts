import { type Policy, webOffReason } from "@rewire/policy";
import { type Env, resolveSearch, type WebConfig } from "@rewire/web";

/** What doctor says when no search backend is set up and none was chosen. */
const NONE_AUTO =
  "set OLLAMA_API_KEY, TAVILY_API_KEY or BRAVE_API_KEY, or [web] search in models.toml";

/** The host of the configured SearXNG URL (models.toml validated it: no credentials or query). */
function searxngHost(url: string | undefined): string {
  try {
    return url === undefined ? "(unset)" : new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/**
 * Doctor's `web` line: the search backend and the NAME of the env var its key came from (never a
 * value), the SearXNG host when used, and the policy state from `webOffReason`. `ok: false` is a
 * note (web is optional and never fails a run), not a failure.
 */
export function webLine(
  config: WebConfig,
  env: Env,
  policy: Policy,
): { ok: boolean; detail: string } {
  const off = webOffReason(policy);
  if (off !== undefined) return { ok: false, detail: `off — ${off}` };
  const w = policy.web;
  const rules = [
    ...(w.allowDomains !== undefined ? [`allow_domains ${w.allowDomains.length} sites`] : []),
    ...(w.denyDomains.length > 0 ? [`deny_domains ${w.denyDomains.length}`] : []),
  ];
  const tail = ` · fetch: on · policy: on${rules.length > 0 ? `, ${rules.join(", ")}` : ""}`;
  const r = resolveSearch(config, env);
  if ("none" in r) {
    const what = config.search === undefined ? NONE_AUTO : r.none;
    return { ok: false, detail: `search: none — ${what}${tail}` };
  }
  const from =
    r.backend === "searxng"
      ? ` at ${searxngHost(config.searxngUrl)}`
      : ` (${r.keyEnv ?? "no key"})`;
  return { ok: true, detail: `search: ${r.backend}${from}${tail}` };
}
