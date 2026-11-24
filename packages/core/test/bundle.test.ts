import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { assetRoot, BUNDLE_VERSION } from "../src/index.js";

test("from source there is no bundle version", () => {
  expect(BUNDLE_VERSION).toBeUndefined();
});

test("assetRoot is the package directory above dist/ when running from source", () => {
  const mod = pathToFileURL(join("/x", "packages", "pipeline", "dist", "assets.js")).href;
  expect(assetRoot("pipeline", mod)).toBe(join("/x", "packages", "pipeline"));
});

test("assetRoot in the sheperd bundle is assets/<package>/ next to dist/", () => {
  const mod = pathToFileURL(join("/g", "node_modules", "sheperd", "dist", "main.js")).href;
  expect(assetRoot("pipeline", mod, "0.1.0-beta.1")).toBe(
    join("/g", "node_modules", "sheperd", "assets", "pipeline"),
  );
});
