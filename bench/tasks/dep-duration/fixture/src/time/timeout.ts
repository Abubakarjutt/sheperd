import { formatDuration } from "./format.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

export function describeTimeout(ms: number | undefined): string {
  return `timeout: ${formatDuration(ms ?? DEFAULT_TIMEOUT_MS)}`;
}
