import { createHash, randomBytes } from "node:crypto";
import type { Finding } from "./schemas.js";

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMMSS-<6 hex>` in UTC. */
export function newRunId(now: Date = new Date()): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(3).toString("hex")}`;
}

/** Whitespace-normalized evidence text; shared by finding ids and evidence verification. */
export const normalizeEvidence = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Stable identity of a finding: sha256 of `category|file|normalizedEvidence`. */
export function fingerprintFinding(f: Finding): string {
  const evidence = normalizeEvidence(f.evidence);
  return createHash("sha256").update(`${f.category}|${f.file}|${evidence}`).digest("hex");
}
