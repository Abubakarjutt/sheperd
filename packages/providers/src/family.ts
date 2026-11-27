import { RewireError } from "@rewire/core";
import { builtinProvider, endpointConfig, type ModelRef } from "./types.js";

/**
 * Ollama names whose leading word is not their lineage (row 96): code, vision and reasoning
 * variants share training with their base family, so they never count as independent of it.
 */
const LINEAGE: Readonly<Record<string, string>> = {
  codellama: "llama",
  llava: "llama",
  qwq: "qwen",
  codeqwen: "qwen",
  codegemma: "gemma",
};

/** The family a model id names under the Ollama rules: last path segment, leading word, lineage. */
function ollamaFamily(model: string): string {
  // Strip registry/namespace prefixes: "hf.co/Qwen/Qwen2.5-Coder-7B-GGUF:Q4_K_M" -> "qwen2.5-...".
  const lower = (model.split("/").pop() ?? model).toLowerCase();
  if (lower.startsWith("gpt-oss")) return "gpt";
  const m = /^[a-z]+/.exec(lower);
  const word = m ? m[0] : lower;
  return LINEAGE[word] ?? word;
}

/** Vendor path segments in hosted ids ("anthropic/claude-opus-5-5") and the family they name. */
const VENDOR: Readonly<Record<string, string>> = {
  anthropic: "claude",
  openai: "gpt",
  google: "gemini",
  "meta-llama": "llama",
  "x-ai": "grok",
  mistralai: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
};

/** Last segments that name a router or a server-side default, not a model. */
const META_IDS: ReadonlySet<string> = new Set(["auto", "router", "default", ""]);

/** Path segments that name a router serving models of several families. */
const ROUTER_VENDORS: ReadonlySet<string> = new Set(["openrouter"]);

/**
 * The family of a model behind an OpenAI-compatible endpoint, from the model id alone (never the
 * endpoint name, which the user picks): hosted ids name other vendors' models, often behind a
 * vendor path ("anthropic/claude-opus-5-5" on OpenRouter is Claude). Independence is never
 * inferred from an id that names no model: a router or meta id needs an explicit `family`.
 */
function endpointFamily(ref: ModelRef): string {
  const segs = ref.model.toLowerCase().split("/");
  const last = segs[segs.length - 1] ?? "";
  const path = segs.slice(0, -1);
  if (META_IDS.has(last) || path.some((s) => ROUTER_VENDORS.has(s))) {
    throw new RewireError(
      "model_ref_invalid",
      `cannot tell the model family of "${ref.provider}:${ref.model}": it names a router or default, not a model`,
      `set [endpoints.${ref.provider}] family = "<family>" in models.toml`,
    );
  }
  // The vendor segment right before the model, else the first segment of a longer path.
  for (const seg of [path[path.length - 1], path[0]]) {
    const family = seg !== undefined ? VENDOR[seg] : undefined;
    if (family === "gemini" && last.includes("gemma")) return "gemma";
    if (family !== undefined) return family;
  }
  if (last.includes("claude")) return "claude";
  if (/^(gpt-|o1|o3|o4|chatgpt|codex)/.test(last)) return "gpt";
  if (last.includes("gemini")) return "gemini";
  if (last.includes("gemma")) return "gemma";
  return ollamaFamily(ref.model);
}

/** Bedrock, Vertex and Foundry are supported for Claude only. */
function cloudClaude(ref: ModelRef): string {
  if (!ref.model.toLowerCase().includes("claude")) {
    throw new RewireError(
      "model_ref_invalid",
      `${ref.provider} supports Claude models only, not "${ref.model}"`,
      ref.provider === "bedrock"
        ? "use a Claude model id such as bedrock:anthropic.claude-opus-5-5"
        : `use a Claude model id such as ${ref.provider}:claude-opus-5-5`,
    );
  }
  return "claude";
}

/** Model family used to enforce that reviewers differ from the author's family. */
export function modelFamily(ref: ModelRef): string {
  if (ref.model.trim() === "") {
    throw new RewireError("model_ref_invalid", "model name is empty");
  }
  const provider = builtinProvider(ref.provider);
  if (provider === undefined) {
    const endpoint = endpointConfig(ref.provider);
    if (endpoint === undefined) {
      throw new RewireError(
        "model_ref_invalid",
        `unknown provider "${String((ref as { provider: unknown }).provider)}"`,
      );
    }
    return endpoint.family ?? endpointFamily(ref);
  }
  switch (provider) {
    case "anthropic":
      return "claude";
    case "openai":
    case "azure":
      return "gpt";
    case "gemini":
      return "gemini";
    case "bedrock":
    case "vertex":
    case "foundry":
      return cloudClaude(ref);
    case "faux":
      return `faux-${ref.model}`;
    case "ollama":
      return ollamaFamily(ref.model);
  }
}
