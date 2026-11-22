export type Config = {
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export const DEFAULT_CONFIG: Config = { port: 8080, host: "127.0.0.1", logLevel: "info" };

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${path}: ${message}`, options);
    this.name = "ConfigError";
  }
}
