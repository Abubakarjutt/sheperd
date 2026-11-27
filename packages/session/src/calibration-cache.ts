import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RewireError, redact } from "@rewire/core";
import type { ModelRef } from "@rewire/providers";
import { z } from "zod";
import { decide, MAX_SCORE } from "./calibration.js";
import { COMPACTION_FLOOR } from "./trigger.js";

/**
 * `<cacheDir>/rewire/calibration.json`: `rewire calibrate` results keyed by
 * `provider:model@digest`. Written atomically (temp file, then rename), file 0600 in a 0700
 * directory, after every measured length so an interrupted run resumes. Read defensively: a
 * corrupt file or a malformed entry is ignored with a warning, and `effective` is recomputed from
 * the per-length results, never taken from the file.
 */

export const CALIBRATION_FILE_MAX_BYTES = 1024 * 1024;

/** A measured score, or a provider error (no score: not a measurement, retried next run). */
const LengthResultSchema = z.union([
  z.strictObject({
    score: z.number().int().min(0).max(MAX_SCORE),
    ms: z.number().finite().nonnegative(),
    at: z.string().max(64),
  }),
  z.strictObject({
    error: z.string().max(500),
    ms: z.number().finite().nonnegative(),
    at: z.string().max(64),
  }),
]);
const TruncatedSchema = z.strictObject({
  length: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  estimated: z.number().int().positive(),
});
const EntrySchema = z.strictObject({
  effective: z.number().int().positive().optional(),
  results: z.record(z.string().regex(/^[1-9]\d{0,9}$/), LengthResultSchema),
  /** The window the run measured with (for Ollama the loaded runtime window when known). */
  window: z.number().int().positive(),
  completedAt: z.string().max(64).optional(),
  /** The provider read far fewer tokens than sent: the run stopped and is never used. */
  truncated: TruncatedSchema.optional(),
});

export type LengthResult = z.infer<typeof LengthResultSchema>;
export type CalibrationEntry = {
  effective?: number;
  results: Record<string, LengthResult>;
  window: number;
  completedAt?: string;
  truncated?: z.infer<typeof TruncatedSchema>;
};

/** A calibration whose measured window differs from the current one by more than this share is stale. */
export const CALIBRATION_WINDOW_TOLERANCE = 0.1;
export type CalibrationCacheOptions = { cacheDir: string; warn?: (message: string) => void };

export function calibrationKey(ref: ModelRef, digest: string | undefined): string {
  return `${ref.provider}:${ref.model}@${digest !== undefined && digest !== "" ? digest : "nodigest"}`;
}

export function calibrationPath(cacheDir: string): string {
  return join(cacheDir, "rewire", "calibration.json");
}

const failed = (message: string) => new RewireError("calibration_failed", message);
const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** The raw file's entries (undefined when absent or unreadable as an object; warned). */
async function readAll(o: CalibrationCacheOptions): Promise<Record<string, unknown>> {
  const file = calibrationPath(o.cacheDir);
  const warn = o.warn ?? (() => {});
  let fh: FileHandle | undefined;
  let raw: string;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) {
      warn(`ignoring ${file}: not a regular file`);
      return {};
    }
    if (st.size > CALIBRATION_FILE_MAX_BYTES) {
      warn(`ignoring ${file}: larger than ${CALIBRATION_FILE_MAX_BYTES} bytes`);
      return {};
    }
    raw = await fh.readFile("utf8");
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return {};
    warn(`ignoring ${file}: ${errno(e) === "ELOOP" ? "it is a symlink" : (e as Error).message}`);
    return {};
  } finally {
    await fh?.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    warn(`ignoring ${file}: not valid JSON`);
    return {};
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    warn(`ignoring ${file}: not a JSON object`);
    return {};
  }
  return json as Record<string, unknown>;
}

/** A checked entry, with `effective` recomputed from its results. */
function checked(
  key: string,
  value: unknown,
  o: CalibrationCacheOptions,
): CalibrationEntry | undefined {
  const r = EntrySchema.safeParse(value);
  if (!r.success) {
    o.warn?.(`ignoring the calibration for ${key}: malformed entry`);
    return undefined;
  }
  const { effective: stored, ...rest } = r.data;
  const { effective } = decide(rest.results);
  if (stored !== effective) {
    o.warn?.(
      `the calibration for ${key} stored effective ${stored ?? "none"}; its results give ${effective ?? "none"}`,
    );
  }
  return effective !== undefined ? { ...rest, effective } : rest;
}

/** The cached calibration of `ref` at `digest`, if a well-formed one exists. Never throws. */
export async function loadCalibration(
  ref: ModelRef,
  digest: string | undefined,
  o: CalibrationCacheOptions,
): Promise<CalibrationEntry | undefined> {
  try {
    if (!(await safeDir(o.cacheDir, false))) return undefined;
  } catch (e) {
    o.warn?.(`ignoring the calibration cache: ${(e as Error).message}`);
    return undefined;
  }
  const key = calibrationKey(ref, digest);
  const all = await readAll(o);
  if (!Object.hasOwn(all, key)) return undefined;
  return checked(key, all[key], o);
}

/**
 * The compaction limit a cached calibration gives: only a completed run counts. Its effective
 * window, or the floor when no length passed.
 */
export function calibratedLimit(entry: CalibrationEntry | undefined): number | undefined {
  if (entry?.completedAt === undefined || entry.truncated !== undefined) return undefined;
  // A completed run never has errored lengths; a file claiming otherwise is not used.
  if (Object.values(entry.results).some((r) => !("score" in r))) return undefined;
  return entry.effective ?? COMPACTION_FLOOR;
}

/** Whether `current` is more than CALIBRATION_WINDOW_TOLERANCE away from the measured window. */
export function windowChanged(measured: number, current: number): boolean {
  return Math.abs(current - measured) > CALIBRATION_WINDOW_TOLERANCE * measured;
}

/** What the chat trigger takes from a cached calibration at the current window. */
export type CalibrationState = {
  calibrated?: number;
  /** A completed calibration exists but was measured at another window: not used. */
  stale?: { measured: number; current: number };
};

/**
 * `calibrated` from a completed, usable entry measured at about the current window. A
 * provisional current window (Ollama before its first request, faux) is not compared: the
 * session re-checks once the loaded window is known.
 */
export function calibrationState(
  entry: CalibrationEntry | undefined,
  current: { window: number; provisional: boolean },
): CalibrationState {
  const limit = calibratedLimit(entry);
  if (entry === undefined || limit === undefined) return {};
  if (!current.provisional && windowChanged(entry.window, current.window)) {
    return { stale: { measured: entry.window, current: current.window } };
  }
  return { calibrated: limit };
}

/** `<cacheDir>/rewire`, a real directory (created 0700 when `create`); never a symlink. */
async function safeDir(cacheDir: string, create: boolean): Promise<string | undefined> {
  const dir = join(cacheDir, "rewire");
  for (;;) {
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw failed(`${dir} is a symlink or not a directory`);
      }
      return dir;
    } catch (e) {
      if (e instanceof RewireError) throw e;
      if (errno(e) !== "ENOENT") throw e;
    }
    if (!create) return undefined;
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
    }
  }
}

const cleanEntry = (e: CalibrationEntry): CalibrationEntry => ({
  ...e,
  results: Object.fromEntries(
    Object.entries(e.results).map(([len, r]) => [
      len,
      "error" in r ? { ...r, error: redact(r.error).slice(0, 500) } : r,
    ]),
  ),
});

/**
 * Store `entry` for `ref` at `digest`, keeping the file's other well-formed entries. Atomic: a
 * temp file (0600, exclusive) renamed over the file. Throws `calibration_failed` on an unsafe
 * cache directory.
 */
export async function saveCalibration(
  ref: ModelRef,
  digest: string | undefined,
  entry: CalibrationEntry,
  o: CalibrationCacheOptions,
): Promise<void> {
  const dir = (await safeDir(o.cacheDir, true)) as string;
  const key = calibrationKey(ref, digest);
  const out: Record<string, CalibrationEntry> = {};
  const all = await readAll(o);
  for (const [k, v] of Object.entries(all)) {
    if (k === key) continue;
    const e = checked(k, v, { cacheDir: o.cacheDir });
    if (e !== undefined) out[k] = e;
  }
  out[key] = cleanEntry(entry);
  const file = calibrationPath(o.cacheDir);
  const tmp = join(dir, `.calibration.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await fh.writeFile(`${JSON.stringify(out, null, 2)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
