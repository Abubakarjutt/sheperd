import { readFile } from "node:fs/promises";
import { RewireError } from "@rewire/core";
import {
  type EndpointConfig,
  endpointNameProblem,
  isLoopbackHost,
  type ModelRef,
  modelFamily,
  type ProviderSettings,
  parseModelRef,
  registerAzureFamily,
  registerEndpoints,
} from "@rewire/providers";
import { parse } from "smol-toml";
import { z } from "zod";

export const ROLES = ["spec", "test-writer", "implementer", "reviewer", "verifier"] as const;
export type Role = (typeof ROLES)[number];

export type RoleRouting = Record<Role, ModelRef> & { independence: "cross-family" | "same-family" };
export type ModelsFile = {
  available: ModelRef[];
  overrides: Partial<Record<Role, ModelRef>>;
  /** The chat session's compaction settings (`[compaction]`); defaults when the table is absent. */
  compaction: CompactionConfig;
  /** Cloud provider settings (`[providers.*]`); absent when the file has none. */
  providers?: ProviderSettings;
  /** OpenAI-compatible endpoints (`[endpoints.<name>]`); registered by `loadModelsFile`. */
  endpoints?: Record<string, EndpointConfig>;
};

/**
 * `[compaction]` in models.toml. `limits` maps a canonical `provider:model` to a fixed compaction
 * limit in tokens (`[compaction.models."<provider:model>"] limit = N`), replacing the adaptive one.
 */
export type CompactionConfig = {
  /** Seconds of prompt reading one turn may cost (`latency_budget_s`, 5 to 3600). */
  latencyBudgetS: number;
  /** Tokens of recent user messages kept verbatim (`recent_user_tokens`, 1000 to 200000). */
  recentUserTokens: number;
  limits: Record<string, number>;
};

export const DEFAULT_LATENCY_BUDGET_S = 60;
export const DEFAULT_RECENT_USER_TOKENS = 20_000;
/** The smallest compaction limit, configured or computed. */
export const MIN_COMPACTION_LIMIT = 4096;
/** The smallest `context_window` an `[endpoints.<name>]` table may declare. */
export const MIN_ENDPOINT_CONTEXT_WINDOW = 4096;

/** A fresh copy of the defaults, safe to mutate. */
export const defaultCompactionConfig = (): CompactionConfig => ({
  latencyBudgetS: DEFAULT_LATENCY_BUDGET_S,
  recentUserTokens: DEFAULT_RECENT_USER_TOKENS,
  limits: {},
});

/** The configured fixed limit for `ref`, if any. */
export function compactionLimitOverride(
  config: CompactionConfig,
  ref: ModelRef,
): number | undefined {
  return Object.hasOwn(config.limits, show(ref)) ? config.limits[show(ref)] : undefined;
}

const same = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;
const show = (r: ModelRef): string => `${r.provider}:${r.model}`;

/**
 * Assign models to roles. The author roles use available[0]; the reviewer is the first model of
 * another family; the verifier prefers a family distinct from both, then one distinct from the
 * implementer, then falls back to the reviewer. Overrides win but must be in `available`;
 * `independence` is computed from the final assignment.
 */
export function resolveRouting(
  available: ModelRef[],
  overrides: Partial<Record<Role, ModelRef>> = {},
): RoleRouting {
  const author = available[0];
  if (author === undefined) {
    throw new RewireError("routing_no_models", "no models available", "list at least one model");
  }
  for (const [role, ref] of Object.entries(overrides)) {
    if (ref !== undefined && !available.some((a) => same(a, ref))) {
      throw new RewireError(
        "routing_override_unavailable",
        `override for role "${role}" (${show(ref)}) is not in the available models`,
      );
    }
  }
  const implementer = overrides.implementer ?? author;
  const implFam = modelFamily(implementer);
  const reviewer =
    overrides.reviewer ?? available.find((m) => modelFamily(m) !== implFam) ?? implementer;
  const revFam = modelFamily(reviewer);
  const verifier =
    overrides.verifier ??
    available.find((m) => {
      const f = modelFamily(m);
      return f !== implFam && f !== revFam;
    }) ??
    available.find((m) => modelFamily(m) !== implFam) ??
    reviewer;
  const independence =
    modelFamily(reviewer) !== implFam && modelFamily(verifier) !== implFam
      ? "cross-family"
      : "same-family";
  return {
    spec: overrides.spec ?? author,
    "test-writer": overrides["test-writer"] ?? author,
    implementer,
    reviewer,
    verifier,
    independence,
  };
}

/** A model ref whose family is known: an unsupported cloud model or a router id fails at load. */
const RefString = z.string().transform((s, ctx) => {
  try {
    const ref = parseModelRef(s);
    modelFamily(ref);
    return ref;
  } catch (e) {
    // The RewireError's hint (e.g. "declare [endpoints.<name>]") rides along to the file error.
    const hint = e instanceof RewireError ? e.hint : undefined;
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : String(e),
      ...(hint !== undefined ? { params: { hint } } : {}),
    });
    return z.NEVER;
  }
});

/** The first hint a ref issue carried (see `RefString`), if any. */
function issueHint(issues: z.core.$ZodIssue[]): string | undefined {
  for (const i of issues) {
    const hint =
      i.code === "custom" ? (i.params as { hint?: unknown } | undefined)?.hint : undefined;
    if (typeof hint === "string") return hint;
  }
  return undefined;
}

const CompactionToml = z.strictObject({
  latency_budget_s: z.number().min(5).max(3600).optional(),
  recent_user_tokens: z.number().int().min(1000).max(200_000).optional(),
  models: z
    .record(z.string(), z.strictObject({ limit: z.number().int().min(MIN_COMPACTION_LIMIT) }))
    .optional(),
});

/** An absolute http(s) URL; https is required unless `loopbackHttp` and the host is loopback. */
const UrlString = (loopbackHttp: boolean) =>
  z.string().superRefine((s, ctx) => {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be an absolute https URL" });
      return;
    }
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
      ctx.addIssue({
        code: "custom",
        message: "must not carry credentials, a query or a fragment (put the key in an env var)",
      });
      return;
    }
    if (u.protocol === "https:") return;
    if (loopbackHttp && u.protocol === "http:" && isLoopbackHost(u.hostname)) return;
    ctx.addIssue({
      code: "custom",
      message: loopbackHttp
        ? "must be https (http only for localhost, 127.0.0.1 or [::1])"
        : "must be https",
    });
  });

const isLoopbackUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
};

const Setting = z.string().min(1);

/** A model family name, for `[endpoints.<name>] family` and `[providers.azure] family`. */
const Family = z.string().regex(/^[a-z][a-z0-9._-]{0,31}$/, "must be a lowercase family name");

const ProvidersToml = z.strictObject({
  bedrock: z.strictObject({ region: Setting.optional() }).optional(),
  vertex: z.strictObject({ project: Setting.optional(), region: Setting.optional() }).optional(),
  foundry: z
    .strictObject({ resource: Setting.optional(), base_url: UrlString(true).optional() })
    .optional(),
  azure: z
    .strictObject({
      endpoint: UrlString(true).optional(),
      api_version: Setting.optional(),
      family: Family.optional(),
    })
    .optional(),
});

const EndpointToml = z
  .strictObject({
    base_url: UrlString(true),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the name of an env var, not a key")
      .optional(),
    family: Family.optional(),
    context_window: z.number().int().min(MIN_ENDPOINT_CONTEXT_WINDOW).optional(),
    max_tokens_field: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.api_key_env === undefined && !isLoopbackUrl(e.base_url)) {
      ctx.addIssue({
        code: "custom",
        path: ["api_key_env"],
        message: "is required unless base_url is a loopback http URL",
      });
    }
  });

const EndpointsToml = z.record(z.string(), EndpointToml).superRefine((endpoints, ctx) => {
  for (const name of Object.keys(endpoints)) {
    const problem = endpointNameProblem(name);
    if (problem !== undefined) ctx.addIssue({ code: "custom", path: [name], message: problem });
  }
});

const ModelsToml = z.strictObject({
  available: z.array(RefString).min(1, "available must list at least one model"),
  compaction: CompactionToml.optional(),
  endpoints: EndpointsToml.optional(),
  providers: ProvidersToml.optional(),
  roles: z
    .object(Object.fromEntries(ROLES.map((r) => [r, RefString.optional()])))
    .strict()
    .optional(),
});

/**
 * Read `available = [...]` and the optional `[roles]`, `[compaction]`, `[providers.*]` and
 * `[endpoints.<name>]` tables from a TOML file. The endpoints are registered (`registerEndpoints`)
 * before the refs are parsed, replacing those of the previous load; an invalid file leaves the
 * previous load's endpoints registered and its own not.
 */
export async function loadModelsFile(path: string): Promise<ModelsFile> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new RewireError(
      "models_file_invalid",
      `cannot read models file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const invalid = (issues: z.core.$ZodIssue[]): RewireError =>
    new RewireError(
      "models_file_invalid",
      `invalid models file ${path}: ${issues
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      issueHint(issues),
    );
  // Endpoints first: refs like "groq:llama-3.3-70b" parse only once "groq" is registered.
  const rawEndpoints = (raw as { endpoints?: unknown } | null)?.endpoints;
  let endpoints: Record<string, EndpointConfig> | undefined;
  if (rawEndpoints !== undefined) {
    const e = EndpointsToml.safeParse(rawEndpoints);
    if (!e.success) {
      throw invalid(e.error.issues.map((i) => ({ ...i, path: ["endpoints", ...i.path] })));
    }
    endpoints = endpointConfigs(e.data);
  }
  // `[providers.azure] family` too: it decides the family of every azure: ref.
  const rawProviders = (raw as { providers?: unknown } | null)?.providers;
  let azureFamily: string | undefined;
  if (rawProviders !== undefined) {
    const p = ProvidersToml.safeParse(rawProviders);
    if (!p.success) {
      throw invalid(p.error.issues.map((i) => ({ ...i, path: ["providers", ...i.path] })));
    }
    azureFamily = p.data.azure?.family;
  }
  // One file's endpoints and Azure family at a time: this load replaces the previous file's, and
  // a failed load puts the previous ones back.
  const previous = loaded;
  previous?.undo();
  const undo = register(endpoints ?? {}, azureFamily);
  try {
    const r = ModelsToml.safeParse(raw);
    if (!r.success) throw invalid(r.error.issues);
    const overrides: Partial<Record<Role, ModelRef>> = {};
    for (const role of ROLES) {
      const ref = (r.data.roles as Record<string, ModelRef | undefined> | undefined)?.[role];
      if (ref) overrides[role] = ref;
    }
    const out: ModelsFile = {
      available: r.data.available,
      overrides,
      compaction: compactionConfig(r.data.compaction, path),
    };
    if (r.data.providers !== undefined) out.providers = providerSettings(r.data.providers);
    if (endpoints !== undefined) out.endpoints = endpoints;
    loaded = { endpoints: endpoints ?? {}, azureFamily, undo };
    return out;
  } catch (e) {
    undo();
    loaded =
      previous !== undefined
        ? {
            ...previous,
            undo: register(previous.endpoints, previous.azureFamily),
          }
        : undefined;
    throw e;
  }
}

function register(
  endpoints: Record<string, EndpointConfig>,
  azureFamily: string | undefined,
): () => void {
  const undoEndpoints = registerEndpoints(endpoints);
  const undoAzure = registerAzureFamily(azureFamily);
  return () => {
    undoAzure();
    undoEndpoints();
  };
}

/**
 * What the last successful `loadModelsFile` registered (its endpoints and `[providers.azure]
 * family`), and how to unregister it.
 */
let loaded:
  | {
      endpoints: Record<string, EndpointConfig>;
      azureFamily: string | undefined;
      undo: () => void;
    }
  | undefined;

function endpointConfigs(raw: z.infer<typeof EndpointsToml>): Record<string, EndpointConfig> {
  const out: Record<string, EndpointConfig> = {};
  for (const [name, e] of Object.entries(raw)) {
    const c: EndpointConfig = { baseUrl: e.base_url };
    if (e.api_key_env !== undefined) c.apiKeyEnv = e.api_key_env;
    if (e.family !== undefined) c.family = e.family;
    if (e.context_window !== undefined) c.contextWindow = e.context_window;
    if (e.max_tokens_field !== undefined) c.maxTokensField = e.max_tokens_field;
    out[name] = c;
  }
  return out;
}

/** Drops absent keys so the result has only what the file set. */
const defined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function providerSettings(raw: z.infer<typeof ProvidersToml>): ProviderSettings {
  const out: ProviderSettings = {};
  if (raw.bedrock) out.bedrock = defined({ region: raw.bedrock.region });
  if (raw.vertex) out.vertex = defined({ project: raw.vertex.project, region: raw.vertex.region });
  if (raw.foundry) {
    out.foundry = defined({ resource: raw.foundry.resource, baseUrl: raw.foundry.base_url });
  }
  if (raw.azure) {
    out.azure = defined({
      endpoint: raw.azure.endpoint,
      apiVersion: raw.azure.api_version,
      family: raw.azure.family,
    });
  }
  return out;
}

function compactionConfig(
  raw: z.infer<typeof CompactionToml> | undefined,
  path: string,
): CompactionConfig {
  const config = defaultCompactionConfig();
  if (raw === undefined) return config;
  if (raw.latency_budget_s !== undefined) config.latencyBudgetS = raw.latency_budget_s;
  if (raw.recent_user_tokens !== undefined) config.recentUserTokens = raw.recent_user_tokens;
  for (const [key, { limit }] of Object.entries(raw.models ?? {})) {
    let ref: ModelRef;
    try {
      ref = parseModelRef(key);
    } catch (e) {
      throw new RewireError(
        "models_file_invalid",
        `invalid models file ${path}: compaction.models.${JSON.stringify(key)}: ${e instanceof Error ? e.message : String(e)}`,
        e instanceof RewireError ? e.hint : undefined,
      );
    }
    config.limits[show(ref)] = limit;
  }
  return config;
}
