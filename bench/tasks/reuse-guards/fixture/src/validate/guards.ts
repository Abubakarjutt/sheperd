import { ValidationError } from "../errors.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A pragmatic email check: one "@", a dot in the domain, a 2+ letter TLD, at most 254 chars. */
export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

export function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new ValidationError(field, "must not be empty");
  return trimmed;
}

/** Parses a whole number from user input ("  12 " is fine, "12abc" and "1.5" are not). */
export function parseIntStrict(
  value: string,
  field: string,
  range: { min?: number; max?: number } = {},
): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) throw new ValidationError(field, "must be a whole number");
  const n = Number.parseInt(trimmed, 10);
  if (range.min !== undefined && n < range.min) {
    throw new ValidationError(field, `must be at least ${range.min}`);
  }
  if (range.max !== undefined && n > range.max) {
    throw new ValidationError(field, `must be at most ${range.max}`);
  }
  return n;
}
