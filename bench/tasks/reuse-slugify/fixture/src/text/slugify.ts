const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * URL-safe slug: strips accents, spells out "&", lowercases, and collapses every run of other
 * characters into a single "-". May return an empty string.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
