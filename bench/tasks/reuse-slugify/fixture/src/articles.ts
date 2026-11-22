import type { Article } from "./models.js";

export function formatByline(article: Article): string {
  const day = article.publishedAt.slice(0, 10);
  return `By ${article.author.name} on ${day}`;
}

export function sortNewestFirst(articles: Article[]): Article[] {
  return [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
