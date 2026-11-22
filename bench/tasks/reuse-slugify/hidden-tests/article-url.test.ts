import { describe, expect, test } from "vitest";
import { articleUrl } from "../src/articles.js";
import type { Article } from "../src/models.js";

const make = (id: number, title: string): Article => ({
  id,
  title,
  author: { id: 1, name: "Ann Lee" },
  publishedAt: "2025-01-01T00:00:00Z",
});

describe("articleUrl", () => {
  test("slug and id", () => {
    expect(articleUrl(make(12, "Plain Title"))).toBe("/articles/plain-title-12");
  });

  test("accents are stripped", () => {
    expect(articleUrl(make(7, "Héllo, Wörld!"))).toBe("/articles/hello-world-7");
  });

  test("ampersands are spelled out", () => {
    expect(articleUrl(make(3, "R&D Café"))).toBe("/articles/r-and-d-cafe-3");
  });

  test("surrounding punctuation and whitespace do not leave dashes", () => {
    expect(articleUrl(make(5, "  --Trim me--  "))).toBe("/articles/trim-me-5");
  });

  test("a title with nothing usable falls back to the id", () => {
    expect(articleUrl(make(9, "!!!"))).toBe("/articles/9");
  });
});
