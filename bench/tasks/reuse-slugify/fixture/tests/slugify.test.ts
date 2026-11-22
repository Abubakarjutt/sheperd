import { describe, expect, test } from "vitest";
import { slugify } from "../src/text/slugify.js";

describe("slugify", () => {
  test("lowercases and joins words with dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("strips accents", () => {
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
  });

  test("spells out ampersands", () => {
    expect(slugify("Salt & Pepper")).toBe("salt-and-pepper");
  });

  test("returns an empty string when nothing is usable", () => {
    expect(slugify("???")).toBe("");
  });
});
