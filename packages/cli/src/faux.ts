import { readFileSync, statSync } from "node:fs";
import { RewireError } from "@rewire/core";
import type { ScriptedTurn } from "@rewire/providers";
import { z } from "zod";

export const FAUX_MAX_BYTES = 1024 * 1024;

const Turn = z.strictObject({
  text: z.string().optional(),
  toolCalls: z
    .array(
      z.strictObject({
        id: z.string().optional(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  stopReason: z.enum(["end", "tool_use", "length", "error"]).optional(),
});

const FauxFile = z.strictObject({ scripts: z.record(z.string(), z.array(Turn)) });

export type FauxScript = { scripts: Record<string, ScriptedTurn[]> };

/** Test/bench only. `{ "scripts": { "<model name>": [ {text, toolCalls, stopReason}, ... ] } }`. */
export function loadFauxScript(path: string): FauxScript {
  const tooBig = () =>
    new RewireError(
      "faux_script_invalid",
      `faux script ${path} is larger than ${FAUX_MAX_BYTES} bytes`,
    );
  let raw: string;
  try {
    if (statSync(path).size > FAUX_MAX_BYTES) throw tooBig();
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof RewireError) throw e;
    throw new RewireError(
      "faux_script_invalid",
      `cannot read faux script ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (Buffer.byteLength(raw) > FAUX_MAX_BYTES) throw tooBig();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RewireError("faux_script_invalid", `invalid faux script ${path}: not JSON`);
  }
  const r = FauxFile.safeParse(json);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new RewireError("faux_script_invalid", `invalid faux script ${path}: ${why.join("; ")}`);
  }
  const scripts: Record<string, ScriptedTurn[]> = {};
  for (const [model, turns] of Object.entries(r.data.scripts)) {
    scripts[model] = turns.map((t) => ({
      ...(t.text !== undefined ? { text: t.text } : {}),
      ...(t.toolCalls ? { toolCalls: t.toolCalls.map((c) => ({ ...c, id: c.id ?? "" })) } : {}),
      ...(t.stopReason ? { stopReason: t.stopReason } : {}),
    }));
  }
  return { scripts };
}
