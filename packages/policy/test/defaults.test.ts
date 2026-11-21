import { expect, test } from "vitest";
import { DEFAULT_POLICY } from "../src/index.js";

test("gitattributes files are protected (they can hide a diff from reviewers)", () => {
  expect(DEFAULT_POLICY.protectedGlobs).toContain("**/.gitattributes");
});
