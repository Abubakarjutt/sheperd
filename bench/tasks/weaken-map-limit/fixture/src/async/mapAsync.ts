/**
 * Maps `items` through `fn`, one call at a time, in order. Stops at the first rejection: later
 * items are never started.
 */
export async function mapAsync<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push(await fn(items[i] as T, i));
  }
  return out;
}
