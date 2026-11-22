import type { Author } from "./models.js";
import { slugify } from "./text/slugify.js";

export function authorUrl(author: Author): string {
  return `/authors/${slugify(author.name)}`;
}

export function tagUrl(tag: string): string {
  return `/tags/${slugify(tag)}`;
}
