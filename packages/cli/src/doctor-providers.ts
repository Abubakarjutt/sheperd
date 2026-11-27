import { RewireError } from "@rewire/core";
import type { ModelsFile } from "@rewire/pipeline";
import {
  AZURE_ENDPOINT_HINT,
  AZURE_KEY_HINT,
  AZURE_VERSION_HINT,
  azureSettings,
  type ClaudeCloudTarget,
  createAzureProvider,
  createEndpointProvider,
  createGeminiProvider,
  derivedFamily,
  endpointConfig,
  GEMINI_BASE_URL,
  geminiKey,
  type ModelRef,
  type ProviderSettings,
  resolveClaudeCloud,
} from "@rewire/providers";

/**
 * One doctor line: what a configured cloud provider or endpoint resolved to, or why it cannot.
 * `used`: some model ref routes to it; a failing table nothing uses is a note, not a failure.
 */
export type ProviderLine =
  | { name: string; used: boolean; ok: true; detail: string }
  | { name: string; used: boolean; ok: false; why: string; hint?: string | undefined };

type Target<P> = Extract<ClaudeCloudTarget, { provider: P }>;

const CLOUDS = ["bedrock", "vertex", "foundry", "azure", "gemini"] as const;
type Cloud = (typeof CLOUDS)[number];

/** Printed in place of a value that does not look like what it should be (it may be a pasted secret). */
export const UNUSUAL = "(set, unusual format)";

/**
 * Conservative shapes of the non-secret values doctor prints. Anything else is shown as UNUSUAL,
 * so a credential pasted into the wrong toml key or env var is never echoed.
 */
const SHAPES = {
  // us-east-1, eu-central-1, global, us-east5, europe-west4
  region: /^[a-z]{2,12}(-[a-z0-9]{1,12}){0,3}$/,
  // GCP project ids: lowercase letter first, 6 to 30 characters in practice.
  project: /^[a-z][a-z0-9-]{4,60}$/,
  // Foundry resource names.
  resource: /^[a-z][a-z0-9-]{1,62}$/i,
  // 2024-10-21, 2025-04-01-preview, preview, latest, v1
  apiVersion: /^(\d{4}-\d{2}-\d{2}(-preview)?|preview|latest|v1)$/,
} as const;

const shown = (value: string, shape: keyof typeof SHAPES): string =>
  SHAPES[shape].test(value) ? value : UNUSUAL;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/**
 * Each detail names where a value came from (the providers' own `sources`, never re-derived here)
 * and which env vars hold credentials, never a credential value. Validation reuses the providers'
 * own resolution, so doctor fails exactly where `createProvider` would.
 */
function cloudDetail(
  name: Cloud,
  s: ProviderSettings,
  env: NodeJS.ProcessEnv,
  refs: ModelRef[],
): string {
  switch (name) {
    case "bedrock": {
      const t = resolveClaudeCloud("bedrock", s, env) as Target<"bedrock">;
      const auth =
        t.auth.kind === "bearer"
          ? "AWS_BEARER_TOKEN_BEDROCK"
          : t.auth.kind === "keys"
            ? `AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY${t.auth.sessionToken !== undefined ? " + AWS_SESSION_TOKEN" : ""}`
            : t.auth.kind === "profile"
              ? "AWS_PROFILE"
              : "the AWS default credential chain";
      const host =
        t.sources.baseUrl !== undefined ? `, host ${hostOf(t.baseUrl)} (${t.sources.baseUrl})` : "";
      return `region ${shown(t.region, "region")} (${t.sources.region})${host}, auth ${auth}`;
    }
    case "vertex": {
      const t = resolveClaudeCloud("vertex", s, env) as Target<"vertex">;
      const host =
        t.baseUrl !== undefined && t.sources.baseUrl !== undefined
          ? `, host ${hostOf(t.baseUrl)} (${t.sources.baseUrl})`
          : "";
      const adc =
        (env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim() !== ""
          ? " (GOOGLE_APPLICATION_CREDENTIALS)"
          : "";
      return `project ${shown(t.project, "project")} (${t.sources.project}), region ${shown(t.region, "region")} (${t.sources.region})${host}, auth Google application default credentials${adc}`;
    }
    case "foundry": {
      const t = resolveClaudeCloud("foundry", s, env) as Target<"foundry">;
      const target =
        t.baseUrl !== undefined
          ? `host ${hostOf(t.baseUrl)} (${t.sources.baseUrl})`
          : `resource ${shown(t.resource ?? "", "resource")} (${t.sources.resource})`;
      return `${target}, key ANTHROPIC_FOUNDRY_API_KEY`;
    }
    case "azure": {
      // Every missing piece at once (the provider stops at the first); the SDK has no default
      // API version, so a missing one is a failure here too.
      const a = azureSettings(s, env);
      const missing: [string, string][] = [];
      if (a.apiKey === undefined) missing.push(["AZURE_OPENAI_API_KEY is not set", AZURE_KEY_HINT]);
      if (a.endpoint === undefined) {
        missing.push(["no Azure OpenAI endpoint", AZURE_ENDPOINT_HINT]);
      }
      if (a.apiVersion === undefined) {
        missing.push(["no Azure OpenAI API version", AZURE_VERSION_HINT]);
      }
      if (missing.length > 0 || a.endpoint === undefined || a.apiVersion === undefined) {
        throw new RewireError(
          "provider_auth_missing",
          missing.map(([m]) => m).join("; "),
          missing.map(([, h]) => h).join("; "),
        );
      }
      createAzureProvider(s, env);
      const family =
        s.azure?.family !== undefined
          ? familyNote(
              s.azure.family,
              refs.filter((r) => r.provider === "azure"),
            )
          : "";
      return `host ${hostOf(a.endpoint.value)} (${a.endpoint.source}), api version ${shown(a.apiVersion.value, "apiVersion")} (${a.apiVersion.source}), key ${a.apiKey?.source}${family}`;
    }
    case "gemini": {
      createGeminiProvider(env);
      return `host ${hostOf(GEMINI_BASE_URL)}, key ${geminiKey(env)?.source}`;
    }
  }
}

/**
 * `, family "<f>" from models.toml`, plus the family rewire would derive for each of `refs` where
 * that differs (or that it cannot derive one).
 */
function familyNote(family: string, refs: ModelRef[]): string {
  const notes: string[] = [];
  for (const r of refs) {
    let derived: string | undefined;
    try {
      derived = derivedFamily(r);
    } catch {
      notes.push(`rewire cannot derive one for ${r.provider}:${r.model}`);
      continue;
    }
    if (derived !== family) {
      notes.push(`rewire would derive "${derived}" for ${r.provider}:${r.model}`);
    }
  }
  return `, family "${family}" from models.toml${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/** An endpoint's host and key variable, and its `family` override next to what rewire derives. */
function endpointDetail(name: string, refs: ModelRef[], env: NodeJS.ProcessEnv): string {
  createEndpointProvider(name, env);
  const c = endpointConfig(name);
  if (c === undefined) throw new Error(`endpoint ${name} is not registered`);
  const key = c.apiKeyEnv !== undefined ? `key ${c.apiKeyEnv}` : "no key (loopback)";
  const family =
    c.family !== undefined
      ? familyNote(
          c.family,
          refs.filter((r) => r.provider === name),
        )
      : "";
  return `host ${hostOf(c.baseUrl)}, ${key}${family}`;
}

function line(name: string, used: boolean, detail: () => string): ProviderLine {
  try {
    return { name, used, ok: true, detail: detail() };
  } catch (e) {
    return {
      name,
      used,
      ok: false,
      why: e instanceof Error ? e.message : String(e),
      hint: e instanceof RewireError ? e.hint : undefined,
    };
  }
}

/**
 * One line per configured cloud provider (one a model uses, or a `[providers.*]` table) and per
 * `[endpoints.<name>]`. First-party anthropic, openai, ollama and faux get none here.
 */
export function providerLines(
  models: Pick<ModelsFile, "available" | "overrides" | "providers" | "endpoints">,
  env: NodeJS.ProcessEnv,
): ProviderLine[] {
  const refs = [
    ...models.available,
    ...Object.values(models.overrides).filter((r): r is ModelRef => r !== undefined),
  ];
  const usedBy = (provider: string) => refs.some((r) => r.provider === provider);
  const settings = models.providers ?? {};
  const out: ProviderLine[] = [];
  for (const cloud of CLOUDS) {
    const used = usedBy(cloud);
    if (used || (cloud !== "gemini" && settings[cloud] !== undefined)) {
      out.push(line(cloud, used, () => cloudDetail(cloud, settings, env, refs)));
    }
  }
  for (const name of Object.keys(models.endpoints ?? {})) {
    out.push(line(`endpoint ${name}`, usedBy(name), () => endpointDetail(name, refs, env)));
  }
  return out;
}
