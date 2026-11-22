import { expect, test } from "vitest";
import { CONFIG_FILE_GLOBS, DEFAULT_POLICY } from "../src/index.js";

test("gitattributes files are protected (they can hide a diff from reviewers)", () => {
  expect(DEFAULT_POLICY.protectedGlobs).toContain("**/.gitattributes");
});

test("every canonical config file pattern is a protected glob (S40)", () => {
  for (const g of CONFIG_FILE_GLOBS) expect(DEFAULT_POLICY.protectedGlobs).toContain(g);
  for (const g of [
    "**/.config/mise.toml",
    "**/mise.*.toml",
    "**/.mise.*.toml",
    "**/mise/config.toml",
    "**/mise/config.*.toml",
    "**/mise/conf.d/**",
  ]) {
    expect(CONFIG_FILE_GLOBS).toContain(g);
  }
});

test("the mise globs do not protect an ordinary source directory named mise", () => {
  expect(DEFAULT_POLICY.protectedGlobs).not.toContain("**/mise/**");
});
