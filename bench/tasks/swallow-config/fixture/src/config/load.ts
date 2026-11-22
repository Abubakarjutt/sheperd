import { readFileSync } from "node:fs";
import { ConfigError, type Config } from "./types.js";
import { validateConfig } from "./validate.js";

/** Reads and validates the JSON config at `path`. */
export function loadConfig(path: string): Config {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(path, "invalid JSON", { cause });
  }
  const result = validateConfig(raw);
  if ("error" in result) throw new ConfigError(path, result.error);
  return result.config;
}
