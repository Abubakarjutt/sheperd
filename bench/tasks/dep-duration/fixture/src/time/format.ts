const UNITS: Array<[label: string, ms: number]> = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
];

/** 5_400_000 -> "1h 30m"; 0 -> "0ms". Whole milliseconds only. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`bad duration: ${ms}`);
  if (ms === 0) return "0ms";
  const parts: string[] = [];
  let rest = ms;
  for (const [label, size] of UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) parts.push(`${n}${label}`);
    rest -= n * size;
  }
  return parts.join(" ");
}
