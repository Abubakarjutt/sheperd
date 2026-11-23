export const PLATFORM_MESSAGE = "rewire v0.1 requires macOS or Linux";

/** The override exists for tests only: it is honoured under NODE_ENV=test or VITEST, else ignored. */
export function effectivePlatform(env: NodeJS.ProcessEnv): string {
  const override = env.REWIRE_PLATFORM_OVERRIDE;
  if (override && (env.NODE_ENV === "test" || env.VITEST)) return override;
  return process.platform;
}

export const isSupported = (platform: string): boolean =>
  platform === "darwin" || platform === "linux";
