import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RewireError } from "@rewire/core";
import { z } from "zod";
import { getModelInfo, normalizeOllamaHost, OllamaProvider, probeOllama } from "./ollama.js";
import { structured } from "./structured.js";
import type { ModelRef, Provider } from "./types.js";

export type Role = "spec" | "test-writer" | "implementer" | "reviewer" | "verifier";

/** Bump when the smoke test changes; cached results from other versions are ignored. */
export const FITNESS_TEST_VERSION = 2;

const TOOL_ROLES: readonly Role[] = ["test-writer", "implementer"];
/**
 * Room for reasoning models (deepseek-r1, qwq) that think before answering; 1024 cut their
 * tool-call arguments off and cached them as unfit (row 42, test version 2).
 */
const SMOKE_MAX_TOKENS = 4096;

const CacheSchema = z.record(
  z.string(),
  z.object({
    ok: z.boolean(),
    reason: z.string().optional(),
    testVersion: z.number(),
    at: z.string(),
  }),
);
type Cache = z.infer<typeof CacheSchema>;

async function readCache(file: string): Promise<Cache> {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {}; // missing or unparseable: re-test, never assume a pass
  }
}

async function writeCache(dir: string, file: string, cache: Cache): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, file);
}

const SmokeSchema = z.strictObject({ ok: z.literal(true), n: z.literal(3) });
const ECHO_TOOL = {
  name: "echo",
  description: "Echoes the given value back.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

/** Returns a failure reason, or undefined when the model passes the smoke test. */
async function smokeTest(
  provider: Provider,
  ref: ModelRef,
  role: Role,
  timeoutMs?: number,
): Promise<string | undefined> {
  const t = timeoutMs === undefined ? {} : { timeoutMs };
  try {
    await structured(provider, ref, SmokeSchema, {
      system: "You are a precise assistant that follows output instructions exactly.",
      messages: [{ role: "user", content: "Return ok=true and n=3" }],
      maxTokens: SMOKE_MAX_TOKENS,
      ...t,
    });
  } catch (err) {
    if (err instanceof RewireError && err.code === "structured_output_invalid") {
      return `structured output check failed: ${err.message}`;
    }
    throw err;
  }
  if (!TOOL_ROLES.includes(role)) return undefined;
  const resp = await provider.chat({
    model: ref.model,
    system: "You must call the provided tool to answer. Do not answer in prose.",
    messages: [{ role: "user", content: 'Call the echo tool with value "ping".' }],
    tools: [ECHO_TOOL],
    maxTokens: SMOKE_MAX_TOKENS,
    ...t,
  });
  if (resp.stopReason !== "tool_use") {
    return `tool call check failed: expected a tool call, got stop reason "${resp.stopReason}"`;
  }
  const calls = resp.message.toolCalls;
  if (calls.length !== 1) {
    return `tool call check failed: expected exactly one tool call, got ${calls.length}`;
  }
  const call = calls[0] as (typeof calls)[number];
  if (call.name !== "echo") {
    return `tool call check failed: called "${call.name}" instead of "echo"`;
  }
  if (call.arguments.value !== "ping") {
    return `tool call check failed: echo value was ${JSON.stringify(call.arguments.value)}, expected "ping"`;
  }
  return undefined;
}

export async function assertRoleFit(
  ref: ModelRef,
  role: Role,
  cacheDir: string,
  opts: { baseUrl?: string; provider?: Provider; chatTimeoutMs?: number } = {},
): Promise<void> {
  if (ref.provider !== "ollama") return;
  const baseUrl = opts.baseUrl ?? normalizeOllamaHost(process.env.OLLAMA_HOST);
  await probeOllama(baseUrl);
  const info = await getModelInfo(baseUrl, ref.model);
  if (TOOL_ROLES.includes(role) && !info.capabilities.includes("tools")) {
    throw new RewireError(
      "model_unfit",
      `${ref.model} lacks tool calling, required for role ${role}`,
    );
  }
  const file = join(cacheDir, "fitness.json");
  const key = `${info.digest}:${role}`;
  const cache = await readCache(file);
  const hit = cache[key];
  if (hit && hit.testVersion === FITNESS_TEST_VERSION) {
    if (hit.ok) return;
    throw new RewireError(
      "model_unfit",
      `${hit.reason ?? `${ref.model} previously failed the smoke test for role ${role}`} (cached ${hit.at})`,
      `delete ${resolve(file)} to re-test`,
    );
  }
  let reason: string | undefined;
  try {
    reason = await smokeTest(
      opts.provider ?? new OllamaProvider(baseUrl),
      ref,
      role,
      opts.chatTimeoutMs,
    );
  } catch (err) {
    // Only deterministic model-behaviour failures are verdicts on the model. Everything else
    // (5xx, timeouts, unreachable, aborts, ...) is transient: rethrow with its own code, uncached.
    if (err instanceof RewireError && err.code === "provider_bad_tool_args") {
      reason = `malformed tool call: ${err.message}`;
    } else {
      throw err;
    }
  }
  cache[key] = {
    ok: reason === undefined,
    ...(reason === undefined ? {} : { reason: unfitMessage(ref, role, reason) }),
    testVersion: FITNESS_TEST_VERSION,
    at: new Date().toISOString(),
  };
  await writeCache(cacheDir, file, cache);
  if (reason !== undefined) throw new RewireError("model_unfit", unfitMessage(ref, role, reason));
}

function unfitMessage(ref: ModelRef, role: Role, reason: string): string {
  return `${ref.model} is not fit for role ${role}: ${reason}`;
}
