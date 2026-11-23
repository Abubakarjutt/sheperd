import { describe, expect, test } from "vitest";
import { formatByline, sortNewestFirst } from "../src/articles.js";
import type { Article } from "../src/models.js";

const make = (id: number, publishedAt: string): Article => ({
  id,
  title: `Article ${id}`,
  author: { id: 1, name: "Ann Lee" },
  publishedAt,
});

describe("articles", () => {
  test("formatByline", () => {
    expect(formatByline(make(1, "2025-03-04T10:00:00Z"))).toBe("By Ann Lee on 2025-03-04");
  });

  test("sortNewestFirst does not mutate its input", () => {
    const input = [make(1, "2025-01-01T00:00:00Z"), make(2, "2025-02-01T00:00:00Z")];
    expect(sortNewestFirst(input).map((a) => a.id)).toEqual([2, 1]);
    expect(input.map((a) => a.id)).toEqual([1, 2]);
  });
});
