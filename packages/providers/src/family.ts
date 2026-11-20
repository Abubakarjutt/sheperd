import { RewireError } from "@rewire/core";
import type { ModelRef } from "./types.js";

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
      return m ? m[0] : lower;
    }
    default:
      throw new RewireError(
        "model_ref_invalid",
        `unknown provider "${String((ref as { provider: unknown }).provider)}"`,
      );
  }
}
