import { RewireError } from "@rewire/core";
import { z } from "zod";
import type { ChatMessage, ChatRequest, ModelRef, Provider } from "./types.js";

/** Returns the first top-level balanced JSON object in `s`, respecting strings and escapes. */
export function extractFirstJsonObject(s: string): string | undefined {
  const from = s.indexOf("{");
  if (from < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return s.slice(from, i + 1);
  }
  return undefined;
}

function describeError(err: z.ZodError): string {
  const pretty = (z as { prettifyError?: (e: z.ZodError) => string }).prettifyError;
  return pretty ? pretty(err) : JSON.stringify(err.issues);
}

export async function structured<T>(
  provider: Provider,
  ref: ModelRef,
  schema: z.ZodType<T>,
  req: Omit<ChatRequest, "model">,
): Promise<T> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const system = `${req.system}\n\nReply with a single JSON object only, no prose and no code fences. It must conform to this JSON schema:\n${jsonSchema}`;
  const messages: ChatMessage[] = [...req.messages];
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await provider.chat({ ...req, model: ref.model, system, messages });
    const reply = resp.message.text;
    if (resp.stopReason === "error" || resp.stopReason === "length") {
      lastProblem = `provider stopped with "${resp.stopReason}"`;
    } else {
      const json = extractFirstJsonObject(reply);
      let problem: string | undefined;
      if (json === undefined) {
        problem = "no JSON object found in reply";
      } else {
        let value: unknown;
        try {
          value = JSON.parse(json);
        } catch (e) {
          problem = `invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (problem === undefined) {
          const parsed = schema.safeParse(value);
          if (parsed.success) return parsed.data;
          problem = describeError(parsed.error);
        }
      }
      lastProblem = problem;
    }
    messages.push(
      { role: "assistant", content: reply },
      {
        role: "user",
        content: `Your reply was not valid:\n${lastProblem}\n\nReturn corrected JSON only: a single JSON object conforming to the schema.`,
      },
    );
  }
  throw new RewireError(
    "structured_output_invalid",
    `model did not return valid structured output after retry: ${lastProblem}`,
  );
}
