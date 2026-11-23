/** Stable sort by a derived key; returns a new array. */
export function sortBy<T>(items: readonly T[], key: (item: T) => string | number): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
