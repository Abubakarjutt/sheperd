/**
 * Where each resolved value came from: a models.toml key (`[providers.bedrock] region`), an env
 * var name, or `default`. Names only, never values; `rewire doctor` prints them.
 */
export type ValueSources = Readonly<Record<string, string>>;

/**
 * The first set (non-blank) value among `sources`, in precedence order, with the label of its
 * source: the one place each precedence list lives, so a value and the label doctor prints for it
 * cannot drift apart.
 */
export function firstSet(
  sources: readonly (readonly [label: string, value: string | undefined])[],
): { value: string; source: string } | undefined {
  for (const [source, v] of sources) {
    const value = v?.trim();
    if (value !== undefined && value !== "") return { value, source };
  }
  return undefined;
}
