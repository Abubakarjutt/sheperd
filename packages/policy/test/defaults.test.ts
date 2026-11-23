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

test("credential read-deny covers common credential stores and key files (I10)", () => {
  for (const g of [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.config/gh/**",
    "~/.git-credentials",
    "~/.docker/config.json",
    "~/.kube/**",
    "~/.config/gcloud/**",
    "~/.azure/**",
    "~/.gnupg/**",
    "~/.pypirc",
    "~/.config/rewire/**",
    "**/*key*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/id_ed25519*",
  ]) {
    expect(DEFAULT_POLICY.credentialDenyGlobs).toContain(g);
  }
});

test("credential read-deny never covers CA bundles (a blanket **/*.pem breaks semgrep)", () => {
  expect(DEFAULT_POLICY.credentialDenyGlobs).not.toContain("**/*.pem");
});

test("DEFAULT_POLICY is deeply frozen (row 5)", () => {
  expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
  expect(Object.isFrozen(DEFAULT_POLICY.testGlobs)).toBe(true);
  expect(() => {
    (DEFAULT_POLICY.gates as string[]).push("x");
  }).toThrow();
});
