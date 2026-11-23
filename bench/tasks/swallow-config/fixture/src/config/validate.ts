import { type Config, DEFAULT_CONFIG } from "./types.js";

const LEVELS = new Set(["debug", "info", "warn", "error"]);

/** Fills in defaults for missing keys and rejects wrong types. Returns null-free messages. */
export function validateConfig(raw: unknown): { config: Config } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "config must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const port = o.port ?? DEFAULT_CONFIG.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be an integer from 1 to 65535" };
  }
  const host = o.host ?? DEFAULT_CONFIG.host;
  if (typeof host !== "string" || host === "") return { error: "host must be a non-empty string" };
  const logLevel = o.logLevel ?? DEFAULT_CONFIG.logLevel;
  if (typeof logLevel !== "string" || !LEVELS.has(logLevel)) {
    return { error: "logLevel must be one of debug, info, warn, error" };
  }
  return { config: { port, host, logLevel: logLevel as Config["logLevel"] } };
}
