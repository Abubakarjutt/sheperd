import { RewireError } from "@rewire/core";
import OpenAI, { AzureOpenAI } from "openai";
import { OpenAIProvider } from "./openai.js";
import { endpointConfig, type ProviderSettings } from "./types.js";
import { baseUrlProblem, isLoopbackUrl } from "./url.js";

/** Gemini's OpenAI-compatible API (https://ai.google.dev/gemini-api/docs/openai). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export type OpenAICompatibleOptions = {
  /** Test seam: the fetch the SDK client uses. */
  fetch?: typeof globalThis.fetch;
};

const set = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== "" ? v.trim() : undefined;

/**
 * Options every non-OpenAI client gets: the base URL and key are always passed, so the SDK never
 * falls back to `OPENAI_BASE_URL`/`OPENAI_API_KEY` from process.env, and OpenAI's organization and
 * project ids (`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) are never sent to another vendor.
 */
function clientOptions(baseURL: string, apiKey: string, opts: OpenAICompatibleOptions) {
  return {
    baseURL,
    apiKey,
    organization: null,
    project: null,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  };
}

function checkedUrl(value: string, what: string, hint: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) {
    throw new RewireError("provider_auth_missing", `${what} ${problem}`, hint);
  }
  return value;
}

const AZURE_KEY_HINT = "set AZURE_OPENAI_API_KEY";
const AZURE_ENDPOINT_HINT =
  "set [providers.azure] endpoint in models.toml, or AZURE_OPENAI_ENDPOINT (https://<resource>.openai.azure.com)";
const AZURE_VERSION_HINT =
  'set [providers.azure] api_version in models.toml, or OPENAI_API_VERSION (for example "2024-10-21")';

/**
 * GPT on Azure OpenAI. The model ref is the deployment name; the SDK sends
 * `<endpoint>/openai/deployments/<deployment>/chat/completions?api-version=<v>` with an `api-key`
 * header. Endpoint and API version come from `[providers.azure]` first, then env; the key only
 * from `AZURE_OPENAI_API_KEY`. The installed SDK has no default API version, so a missing one is
 * `provider_auth_missing` here rather than an SDK error.
 */
export function createAzureProvider(
  settings: ProviderSettings,
  env: NodeJS.ProcessEnv,
  opts: OpenAICompatibleOptions = {},
): OpenAIProvider {
  const apiKey = set(env.AZURE_OPENAI_API_KEY);
  if (apiKey === undefined) {
    throw new RewireError(
      "provider_auth_missing",
      "AZURE_OPENAI_API_KEY is not set",
      AZURE_KEY_HINT,
    );
  }
  const fromToml = set(settings.azure?.endpoint);
  const endpoint = fromToml ?? set(env.AZURE_OPENAI_ENDPOINT);
  if (endpoint === undefined) {
    throw new RewireError("provider_auth_missing", "no Azure OpenAI endpoint", AZURE_ENDPOINT_HINT);
  }
  checkedUrl(
    endpoint,
    fromToml !== undefined ? "[providers.azure] endpoint" : "AZURE_OPENAI_ENDPOINT",
    AZURE_ENDPOINT_HINT,
  );
  const apiVersion = set(settings.azure?.apiVersion) ?? set(env.OPENAI_API_VERSION);
  if (apiVersion === undefined) {
    throw new RewireError(
      "provider_auth_missing",
      "no Azure OpenAI API version",
      AZURE_VERSION_HINT,
    );
  }
  // The SDK's own endpoint handling: trailing slashes dropped, then `/openai`. Passing the base
  // URL (not `endpoint`) keeps it from reading OPENAI_BASE_URL or AZURE_OPENAI_ENDPOINT itself.
  const client = new AzureOpenAI({
    ...clientOptions(`${endpoint.replace(/\/+$/, "")}/openai`, apiKey, opts),
    apiVersion,
  });
  return new OpenAIProvider(apiKey, client, { name: "azure" });
}

/**
 * Gemini through its OpenAI-compatible API, with Bearer auth from `GEMINI_API_KEY` (else
 * `GOOGLE_API_KEY`). The output cap goes in `max_tokens`: it is the field Google's compatibility
 * layer has always accepted (Vertex AI's OpenAI docs list `max_completion_tokens` only as an alias).
 */
export function createGeminiProvider(
  env: NodeJS.ProcessEnv,
  opts: OpenAICompatibleOptions = {},
): OpenAIProvider {
  const apiKey = set(env.GEMINI_API_KEY) ?? set(env.GOOGLE_API_KEY);
  if (apiKey === undefined) {
    throw new RewireError(
      "provider_auth_missing",
      "GEMINI_API_KEY is not set",
      "set GEMINI_API_KEY (or GOOGLE_API_KEY)",
    );
  }
  const client = new OpenAI(clientOptions(GEMINI_BASE_URL, apiKey, opts));
  return new OpenAIProvider(apiKey, client, {
    name: "gemini",
    params: { maxTokensField: "max_tokens" },
  });
}

/**
 * A key the SDK insists on for construction but that is never sent: the `Authorization: null`
 * default header removes the header the SDK would build from it.
 */
const UNSENT_KEY = "rewire-no-key";

/**
 * A user-named OpenAI-compatible endpoint (`[endpoints.<name>]`): `<base_url>/chat/completions`
 * with Bearer auth from the env var `api_key_env` names. A loopback endpoint without
 * `api_key_env` sends no Authorization header at all; any other endpoint without one fails closed.
 */
export function createEndpointProvider(
  name: string,
  env: NodeJS.ProcessEnv,
  opts: OpenAICompatibleOptions = {},
): OpenAIProvider {
  const config = endpointConfig(name);
  if (config === undefined) {
    throw new RewireError(
      "provider_unknown",
      `no provider registered for "${name}"`,
      `declare [endpoints.${name}] in models.toml`,
    );
  }
  const baseUrl = checkedUrl(
    config.baseUrl,
    `[endpoints.${name}] base_url`,
    `fix [endpoints.${name}] base_url in models.toml`,
  );
  const params = { maxTokensField: config.maxTokensField ?? ("max_tokens" as const) };
  if (config.apiKeyEnv === undefined) {
    if (!isLoopbackUrl(baseUrl)) {
      throw new RewireError(
        "provider_auth_missing",
        `[endpoints.${name}] has no api_key_env`,
        `set [endpoints.${name}] api_key_env to the name of the env var holding its key`,
      );
    }
    const client = new OpenAI({
      ...clientOptions(baseUrl, UNSENT_KEY, opts),
      defaultHeaders: { Authorization: null },
    });
    return new OpenAIProvider("", client, { name, params });
  }
  const apiKey = set(env[config.apiKeyEnv]);
  if (apiKey === undefined) {
    throw new RewireError(
      "provider_auth_missing",
      `${config.apiKeyEnv} is not set`,
      `set ${config.apiKeyEnv} (named by [endpoints.${name}] api_key_env)`,
    );
  }
  const client = new OpenAI(clientOptions(baseUrl, apiKey, opts));
  return new OpenAIProvider(apiKey, client, { name, params });
}
