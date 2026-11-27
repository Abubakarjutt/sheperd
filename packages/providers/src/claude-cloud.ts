import { RewireError, redact } from "@rewire/core";
import { type AnthropicMessagesClient, AnthropicProvider } from "./anthropic.js";
import { providerError } from "./errors.js";
import { customHeaderNames } from "./openai-compatible.js";
import { firstSet, type ValueSources } from "./sources.js";
import type { ChatRequest, ChatResponse, Provider, ProviderSettings } from "./types.js";
import { baseUrlProblem } from "./url.js";

/** The clouds that serve Claude through a dedicated Anthropic SDK client. */
export type ClaudeCloudName = "bedrock" | "vertex" | "foundry";

export type ClaudeCloudOptions = {
  /** Test seam: the fetch the SDK client uses. */
  fetch?: typeof globalThis.fetch;
  /**
   * Test seam (Vertex): a google-auth-library `AuthClient` used instead of Application Default
   * Credentials, so a test never reads a credential file.
   */
  vertexAuthClient?: unknown;
};

type BedrockAuth =
  | { kind: "bearer"; token: string }
  | { kind: "keys"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: "profile"; profile: string }
  | { kind: "chain" };

/** Where a cloud client will send requests, resolved from models.toml and env. No secrets but auth. */
export type ClaudeCloudTarget =
  | {
      provider: "bedrock";
      region: string;
      baseUrl: string;
      auth: BedrockAuth;
      sources: ValueSources;
    }
  | { provider: "vertex"; project: string; region: string; baseUrl?: string; sources: ValueSources }
  | {
      provider: "foundry";
      apiKey: string;
      resource?: string;
      baseUrl?: string;
      sources: ValueSources;
    };

const set = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== "" ? v.trim() : undefined;

/** A value that becomes part of a host name (region, resource) must be one DNS label. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

function label(value: string, what: string, hint: string): string {
  if (!LABEL.test(value)) {
    throw new RewireError(
      "provider_auth_missing",
      `${what} ${JSON.stringify(value.slice(0, 64))} is not a valid name`,
      hint,
    );
  }
  return value;
}

/**
 * An SDK base-URL override, read from the env rewire was given (never from process.env behind
 * its back) and held to the models.toml rule: https, or http only on a loopback host.
 */
function envBaseUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = set(env[name]);
  if (v === undefined) return undefined;
  const problem = baseUrlProblem(v);
  if (problem !== undefined) {
    throw new RewireError(
      "provider_auth_missing",
      `${name} ${problem}`,
      `fix or unset ${name} (https, or http only for localhost, 127.0.0.1 or [::1])`,
    );
  }
  return v;
}

const BEDROCK_REGION_HINT =
  "set [providers.bedrock] region in models.toml, or AWS_REGION / AWS_DEFAULT_REGION";
const VERTEX_PROJECT_HINT =
  "set [providers.vertex] project in models.toml, or ANTHROPIC_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT";
const VERTEX_REGION_HINT =
  'set [providers.vertex] region in models.toml, or CLOUD_ML_REGION (default "global")';
const FOUNDRY_TARGET_HINT =
  "set [providers.foundry] resource (or base_url) in models.toml, or ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_BASE_URL";

/**
 * Resolves region, project, resource and auth for `provider` from `[providers.*]` settings
 * (first) and env. Throws `provider_auth_missing`, naming the toml key and env vars to set, when
 * something required is absent. Credentials are only ever taken from env or the platform's own
 * credential chain; they are never logged.
 */
export function resolveClaudeCloud(
  provider: ClaudeCloudName,
  settings: ProviderSettings,
  env: NodeJS.ProcessEnv,
): ClaudeCloudTarget {
  switch (provider) {
    case "bedrock": {
      const picked = firstSet([
        ["[providers.bedrock] region", settings.bedrock?.region],
        ["AWS_REGION", env.AWS_REGION],
        ["AWS_DEFAULT_REGION", env.AWS_DEFAULT_REGION],
      ]);
      if (picked === undefined) {
        throw new RewireError(
          "provider_auth_missing",
          "no AWS region for bedrock",
          BEDROCK_REGION_HINT,
        );
      }
      const token = set(env.AWS_BEARER_TOKEN_BEDROCK);
      const accessKeyId = set(env.AWS_ACCESS_KEY_ID);
      const secretAccessKey = set(env.AWS_SECRET_ACCESS_KEY);
      const sessionToken = set(env.AWS_SESSION_TOKEN);
      const profile = set(env.AWS_PROFILE);
      const auth: BedrockAuth =
        token !== undefined
          ? { kind: "bearer", token }
          : accessKeyId !== undefined && secretAccessKey !== undefined
            ? {
                kind: "keys",
                accessKeyId,
                secretAccessKey,
                ...(sessionToken !== undefined ? { sessionToken } : {}),
              }
            : profile !== undefined
              ? { kind: "profile", profile }
              : { kind: "chain" };
      const checked = label(picked.value, "AWS region", BEDROCK_REGION_HINT);
      // Passed explicitly: the SDK would otherwise read its override from process.env.
      const override = envBaseUrl(env, "ANTHROPIC_BEDROCK_MANTLE_BASE_URL");
      const baseUrl = override ?? `https://bedrock-mantle.${checked}.api.aws/anthropic`;
      const sources: Record<string, string> = { region: picked.source };
      if (override !== undefined) sources.baseUrl = "ANTHROPIC_BEDROCK_MANTLE_BASE_URL";
      return { provider, region: checked, auth, baseUrl, sources };
    }
    case "vertex": {
      const project = firstSet([
        ["[providers.vertex] project", settings.vertex?.project],
        ["ANTHROPIC_VERTEX_PROJECT_ID", env.ANTHROPIC_VERTEX_PROJECT_ID],
        ["GOOGLE_CLOUD_PROJECT", env.GOOGLE_CLOUD_PROJECT],
      ]);
      if (project === undefined) {
        throw new RewireError(
          "provider_auth_missing",
          "no Google Cloud project for vertex",
          VERTEX_PROJECT_HINT,
        );
      }
      const region = firstSet([
        ["[providers.vertex] region", settings.vertex?.region],
        ["CLOUD_ML_REGION", env.CLOUD_ML_REGION],
      ]) ?? { value: "global", source: "default" };
      const baseUrl = envBaseUrl(env, "ANTHROPIC_VERTEX_BASE_URL");
      const sources: Record<string, string> = { project: project.source, region: region.source };
      if (baseUrl !== undefined) sources.baseUrl = "ANTHROPIC_VERTEX_BASE_URL";
      return {
        provider,
        project: project.value,
        region: label(region.value, "Vertex region", VERTEX_REGION_HINT),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        sources,
      };
    }
    case "foundry": {
      const apiKey = set(env.ANTHROPIC_FOUNDRY_API_KEY);
      if (apiKey === undefined) {
        throw new RewireError(
          "provider_auth_missing",
          "ANTHROPIC_FOUNDRY_API_KEY is not set",
          "export ANTHROPIC_FOUNDRY_API_KEY with the Foundry resource's key",
        );
      }
      // models.toml wins over env; within one source a base URL wins over a resource.
      const fromToml = settings.foundry;
      const tomlBase = set(fromToml?.baseUrl);
      if (tomlBase !== undefined) {
        return {
          provider,
          apiKey,
          baseUrl: tomlBase,
          sources: { baseUrl: "[providers.foundry] base_url" },
        };
      }
      if (set(fromToml?.resource) === undefined) {
        const envBase = envBaseUrl(env, "ANTHROPIC_FOUNDRY_BASE_URL");
        if (envBase !== undefined) {
          return {
            provider,
            apiKey,
            baseUrl: envBase,
            sources: { baseUrl: "ANTHROPIC_FOUNDRY_BASE_URL" },
          };
        }
      }
      const resource = firstSet([
        ["[providers.foundry] resource", fromToml?.resource],
        ["ANTHROPIC_FOUNDRY_RESOURCE", env.ANTHROPIC_FOUNDRY_RESOURCE],
      ]);
      if (resource === undefined) {
        throw new RewireError(
          "provider_auth_missing",
          "no Foundry resource or base URL for foundry",
          FOUNDRY_TARGET_HINT,
        );
      }
      return {
        provider,
        apiKey,
        resource: label(resource.value, "Foundry resource", FOUNDRY_TARGET_HINT),
        sources: { resource: resource.source },
      };
    }
  }
}

/** The credential values of a target, for literal redaction from error messages. */
function secretsOf(t: ClaudeCloudTarget): string[] {
  if (t.provider === "foundry") return [t.apiKey];
  if (t.provider === "vertex") return [];
  switch (t.auth.kind) {
    case "bearer":
      return [t.auth.token];
    case "keys":
      return [t.auth.accessKeyId, t.auth.secretAccessKey, t.auth.sessionToken ?? ""];
    default:
      return [];
  }
}

/**
 * `defaultHeaders` for a cloud client. `ANTHROPIC_CUSTOM_HEADERS` is meant for Anthropic (often a
 * gateway credential), and the SDK merges it into `defaultHeaders`, which it applies after its
 * auth headers: it could replace the platform credential and would be sent to AWS, Google or
 * Azure. Every name it holds (in the env rewire was given or in process.env) is passed as `null`,
 * which removes the header before Bedrock signs the request and before Vertex adds its OAuth
 * token; then the platform's own header credential (a Bedrock API key, the Foundry key) is set
 * over it. SigV4 and Google OAuth are applied by the SDK after these headers.
 */
function cloudHeaders(t: ClaudeCloudTarget, env: NodeJS.ProcessEnv): Record<string, string | null> {
  const headers: Record<string, string | null> = {};
  for (const name of customHeaderNames(env, "ANTHROPIC_CUSTOM_HEADERS")) headers[name] = null;
  if (t.provider === "foundry") headers["x-api-key"] = t.apiKey;
  if (t.provider === "bedrock" && t.auth.kind === "bearer") {
    headers.authorization = `Bearer ${t.auth.token}`;
  }
  return headers;
}

/**
 * Builds the platform's dedicated client. The SDK is imported here, on first use, so `rewire`
 * startup never loads the AWS or Google auth libraries.
 */
async function clientFor(
  t: ClaudeCloudTarget,
  env: NodeJS.ProcessEnv,
  opts: ClaudeCloudOptions,
): Promise<AnthropicMessagesClient> {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  const defaultHeaders = cloudHeaders(t, env);
  switch (t.provider) {
    case "bedrock": {
      const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
      const auth =
        t.auth.kind === "bearer"
          ? { apiKey: t.auth.token }
          : t.auth.kind === "keys"
            ? {
                apiKey: null,
                awsAccessKey: t.auth.accessKeyId,
                awsSecretAccessKey: t.auth.secretAccessKey,
                awsSessionToken: t.auth.sessionToken ?? null,
              }
            : t.auth.kind === "profile"
              ? { apiKey: null, awsProfile: t.auth.profile }
              : { apiKey: null };
      return new AnthropicBedrockMantle({
        awsRegion: t.region,
        baseURL: t.baseUrl,
        ...auth,
        defaultHeaders,
        ...fetchOpt,
      });
    }
    case "vertex": {
      const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
      const client = new AnthropicVertex({
        projectId: t.project,
        region: t.region,
        // null, not undefined: the SDK then uses its regional default, never process.env.
        baseURL: t.baseUrl ?? null,
        ...(opts.vertexAuthClient !== undefined
          ? { authClient: opts.vertexAuthClient as never }
          : {}),
        defaultHeaders,
        ...fetchOpt,
      });
      await googleCredentials(client);
      return client;
    }
    case "foundry": {
      const { default: AnthropicFoundry } = await import("@anthropic-ai/foundry-sdk");
      return new AnthropicFoundry({
        apiKey: t.apiKey,
        ...(t.baseUrl !== undefined
          ? { baseURL: t.baseUrl, resource: null }
          : { resource: t.resource ?? null, baseURL: null }),
        defaultHeaders,
        ...fetchOpt,
      });
    }
  }
}

/**
 * The Vertex constructor starts resolving Google credentials (ADC) and awaits them only inside a
 * request, after the abort check: a first chat aborted before sending would leave a rejection
 * unhandled and kill the process. Await it here, so a missing or broken ADC is always handled
 * and reported as `provider_auth_missing` before any request.
 */
async function googleCredentials(client: object): Promise<void> {
  const pending = (client as { _authClientPromise?: Promise<unknown> })._authClientPromise;
  if (pending === undefined) return;
  try {
    await pending;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new RewireError(
      "provider_auth_missing",
      `no usable Google credentials for vertex: ${redact(why).slice(0, 300)}`,
      "run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS to a credential file",
    );
  }
}

/**
 * The dedicated Anthropic client for Claude on Bedrock (`AnthropicBedrockMantle`), Vertex
 * (`AnthropicVertex`) or Foundry (`AnthropicFoundry`). Rejects with `provider_auth_missing` when
 * the region, project or key is absent.
 */
export async function createClaudeCloudClient(
  provider: ClaudeCloudName,
  settings: ProviderSettings,
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof globalThis.fetch,
  opts: Omit<ClaudeCloudOptions, "fetch"> = {},
): Promise<AnthropicMessagesClient> {
  const target = resolveClaudeCloud(provider, settings, env);
  try {
    return await clientFor(target, env, { ...opts, ...(fetchFn ? { fetch: fetchFn } : {}) });
  } catch (err) {
    throw providerError(provider, err, { secrets: secretsOf(target) });
  }
}

/**
 * Claude on a cloud platform: the same request mapping, streaming and error handling as
 * `AnthropicProvider`, over the platform's client. Configuration is checked at construction
 * (`provider_auth_missing` before any run starts); the SDK loads on the first chat.
 */
export class ClaudeCloudProvider implements Provider {
  /** Holds credentials: never expose or log it. */
  private readonly target: ClaudeCloudTarget;
  /** Holds credentials: never expose or log it. */
  private readonly env: NodeJS.ProcessEnv;
  private inner: Promise<AnthropicProvider> | undefined;

  constructor(
    readonly provider: ClaudeCloudName,
    settings: ProviderSettings,
    env: NodeJS.ProcessEnv,
    private readonly opts: ClaudeCloudOptions = {},
  ) {
    this.target = resolveClaudeCloud(provider, settings, env);
    this.env = env;
  }

  private async load(): Promise<AnthropicProvider> {
    const secrets = secretsOf(this.target);
    let client: AnthropicMessagesClient;
    try {
      client = await clientFor(this.target, this.env, this.opts);
    } catch (err) {
      throw providerError(this.provider, err, { secrets });
    }
    return new AnthropicProvider("", client, { name: this.provider, secrets });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.inner === undefined) {
      const p = this.load();
      this.inner = p;
      // A failed load is retried by the next chat, never cached.
      p.catch(() => {
        if (this.inner === p) this.inner = undefined;
      });
    }
    return (await this.inner).chat(req);
  }
}
