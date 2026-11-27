import { RewireError } from "@rewire/core";
import type { ModelsFile } from "@rewire/pipeline";
import {
  AZURE_ENDPOINT_HINT,
  AZURE_KEY_HINT,
  AZURE_VERSION_HINT,
  type ClaudeCloudTarget,
  createAzureProvider,
  createEndpointProvider,
  createGeminiProvider,
  derivedFamily,
  endpointConfig,
  GEMINI_BASE_URL,
  type ModelRef,
  type ProviderSettings,
  resolveClaudeCloud,
} from "@rewire/providers";

/** One doctor line: what a configured cloud provider or endpoint resolved to, or why it cannot. */
export type ProviderLine =
  | { name: string; ok: true; detail: string }
  | { name: string; ok: false; why: string; hint?: string | undefined };

type Target<P> = Extract<ClaudeCloudTarget, { provider: P }>;

const CLOUDS = ["bedrock", "vertex", "foundry", "azure", "gemini"] as const;
type Cloud = (typeof CLOUDS)[number];

const set = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== "" ? v.trim() : undefined;

/** The label of the first source that has a value, in the providers' own precedence. */
const sourceOf = (sources: [label: string, value: string | undefined][]): string =>
  sources.find(([, v]) => set(v) !== undefined)?.[0] ?? "default";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** `, host <host> (<VAR>)` when an SDK base-URL override is set in env. */
const envHost = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = set(env[name]);
  return v !== undefined ? `, host ${hostOf(v)} (${name})` : "";
};

/**
 * Each detail names where a value came from and which env vars hold credentials, never a
 * credential value: credentials are only ever reported by variable name. Validation reuses the
 * providers' own resolution, so doctor fails exactly where `createProvider` would.
 */
function cloudDetail(name: Cloud, s: ProviderSettings, env: NodeJS.ProcessEnv): string {
  switch (name) {
    case "bedrock": {
      const t = resolveClaudeCloud("bedrock", s, env) as Target<"bedrock">;
      const region = sourceOf([
        ["[providers.bedrock] region", s.bedrock?.region],
        ["AWS_REGION", env.AWS_REGION],
        ["AWS_DEFAULT_REGION", env.AWS_DEFAULT_REGION],
      ]);
      const auth =
        t.auth.kind === "bearer"
          ? "AWS_BEARER_TOKEN_BEDROCK"
          : t.auth.kind === "keys"
            ? `AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY${t.auth.sessionToken !== undefined ? " + AWS_SESSION_TOKEN" : ""}`
            : t.auth.kind === "profile"
              ? "AWS_PROFILE"
              : "the AWS default credential chain";
      return `region ${t.region} (${region})${envHost(env, "ANTHROPIC_BEDROCK_MANTLE_BASE_URL")}, auth ${auth}`;
    }
    case "vertex": {
      const t = resolveClaudeCloud("vertex", s, env) as Target<"vertex">;
      const project = sourceOf([
        ["[providers.vertex] project", s.vertex?.project],
        ["ANTHROPIC_VERTEX_PROJECT_ID", env.ANTHROPIC_VERTEX_PROJECT_ID],
        ["GOOGLE_CLOUD_PROJECT", env.GOOGLE_CLOUD_PROJECT],
      ]);
      const region = sourceOf([
        ["[providers.vertex] region", s.vertex?.region],
        ["CLOUD_ML_REGION", env.CLOUD_ML_REGION],
      ]);
      const adc =
        set(env.GOOGLE_APPLICATION_CREDENTIALS) !== undefined
          ? " (GOOGLE_APPLICATION_CREDENTIALS)"
          : "";
      return `project ${t.project} (${project}), region ${t.region} (${region})${envHost(env, "ANTHROPIC_VERTEX_BASE_URL")}, auth Google application default credentials${adc}`;
    }
    case "foundry": {
      const t = resolveClaudeCloud("foundry", s, env) as Target<"foundry">;
      const target =
        t.baseUrl !== undefined
          ? `host ${hostOf(t.baseUrl)} (${set(s.foundry?.baseUrl) !== undefined ? "[providers.foundry] base_url" : "ANTHROPIC_FOUNDRY_BASE_URL"})`
          : `resource ${t.resource} (${set(s.foundry?.resource) !== undefined ? "[providers.foundry] resource" : "ANTHROPIC_FOUNDRY_RESOURCE"})`;
      return `${target}, key ANTHROPIC_FOUNDRY_API_KEY`;
    }
    case "azure": {
      // Every missing piece at once (the provider stops at the first); the SDK has no default
      // API version, so a missing one is a failure here too.
      const endpoint = set(s.azure?.endpoint) ?? set(env.AZURE_OPENAI_ENDPOINT);
      const version = set(s.azure?.apiVersion) ?? set(env.OPENAI_API_VERSION);
      const missing: [string, string][] = [];
      if (set(env.AZURE_OPENAI_API_KEY) === undefined) {
        missing.push(["AZURE_OPENAI_API_KEY is not set", AZURE_KEY_HINT]);
      }
      if (endpoint === undefined) missing.push(["no Azure OpenAI endpoint", AZURE_ENDPOINT_HINT]);
      if (version === undefined) missing.push(["no Azure OpenAI API version", AZURE_VERSION_HINT]);
      if (missing.length > 0) {
        throw new RewireError(
          "provider_auth_missing",
          missing.map(([m]) => m).join("; "),
          missing.map(([, h]) => h).join("; "),
        );
      }
      createAzureProvider(s, env);
      const endpointFrom = sourceOf([
        ["[providers.azure] endpoint", s.azure?.endpoint],
        ["AZURE_OPENAI_ENDPOINT", env.AZURE_OPENAI_ENDPOINT],
      ]);
      const versionFrom = sourceOf([
        ["[providers.azure] api_version", s.azure?.apiVersion],
        ["OPENAI_API_VERSION", env.OPENAI_API_VERSION],
      ]);
      return `host ${hostOf(endpoint as string)} (${endpointFrom}), api version ${version} (${versionFrom}), key AZURE_OPENAI_API_KEY`;
    }
    case "gemini": {
      createGeminiProvider(env);
      const key = set(env.GEMINI_API_KEY) !== undefined ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
      return `host ${hostOf(GEMINI_BASE_URL)}, key ${key}`;
    }
  }
}

/** An endpoint's host and key variable, and its `family` override next to what rewire derives. */
function endpointDetail(name: string, refs: ModelRef[], env: NodeJS.ProcessEnv): string {
  createEndpointProvider(name, env);
  const c = endpointConfig(name);
  if (c === undefined) throw new Error(`endpoint ${name} is not registered`);
  const key = c.apiKeyEnv !== undefined ? `key ${c.apiKeyEnv}` : "no key (loopback)";
  let family = "";
  if (c.family !== undefined) {
    const notes: string[] = [];
    for (const r of refs.filter((r) => r.provider === name)) {
      let derived: string | undefined;
      try {
        derived = derivedFamily(r);
      } catch {
        notes.push(`rewire cannot derive one for ${name}:${r.model}`);
        continue;
      }
      if (derived !== c.family) {
        notes.push(`rewire would derive "${derived}" for ${name}:${r.model}`);
      }
    }
    family = `, family "${c.family}" from models.toml${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
  }
  return `host ${hostOf(c.baseUrl)}, ${key}${family}`;
}

function line(name: string, detail: () => string): ProviderLine {
  try {
    return { name, ok: true, detail: detail() };
  } catch (e) {
    return {
      name,
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
  const settings = models.providers ?? {};
  const out: ProviderLine[] = [];
  for (const cloud of CLOUDS) {
    const used =
      refs.some((r) => r.provider === cloud) ||
      (cloud !== "gemini" && settings[cloud] !== undefined);
    if (used) out.push(line(cloud, () => cloudDetail(cloud, settings, env)));
  }
  for (const name of Object.keys(models.endpoints ?? {})) {
    out.push(line(`endpoint ${name}`, () => endpointDetail(name, refs, env)));
  }
  return out;
}
