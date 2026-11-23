import { RewireError } from "@rewire/core";
import type { ModelRef } from "./types.js";

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

/** Model family used to enforce that reviewers differ from the author's family. */
export function modelFamily(ref: ModelRef): string {
  if (ref.model.trim() === "") {
    throw new RewireError("model_ref_invalid", "model name is empty");
  }
  switch (ref.provider) {
    case "anthropic":
      return "claude";
    case "openai":
      return "gpt";
    case "faux":
      return `faux-${ref.model}`;
    case "ollama": {
      // Strip registry/namespace prefixes: "hf.co/Qwen/Qwen2.5-Coder-7B-GGUF:Q4_K_M" -> "qwen2.5-...".
      const lower = (ref.model.split("/").pop() ?? ref.model).toLowerCase();
      if (lower.startsWith("gpt-oss")) return "gpt";
      const m = /^[a-z]+/.exec(lower);
      const word = m ? m[0] : lower;
      return LINEAGE[word] ?? word;
    }
    default:
      throw new RewireError(
        "model_ref_invalid",
        `unknown provider "${String((ref as { provider: unknown }).provider)}"`,
      );
  }
}
