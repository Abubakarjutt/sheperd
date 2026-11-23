import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replaced with the package version by the sheperd bundler (scripts/npm/build.mjs, esbuild
 * `define`); never set when running from the source checkout.
 */
declare const REWIRE_BUNDLE_VERSION: string | undefined;

/** The published `sheperd` version when running from the npm bundle; undefined from source. */
export const BUNDLE_VERSION: string | undefined =
  typeof REWIRE_BUNDLE_VERSION === "string" ? REWIRE_BUNDLE_VERSION : undefined;

/**
 * Where a package's shipped, non-JS assets (prompts/, rules/) live. `moduleUrl` is the
 * `import.meta.url` of a module that sits directly in the package's dist/. From source that is
 * the package directory; in the sheperd bundle every module is dist/main.js and the assets are
 * copied to assets/<pkg>/ next to dist/.
 */
export function assetRoot(pkg: string, moduleUrl: string, bundleVersion = BUNDLE_VERSION): string {
  const up = join(dirname(fileURLToPath(moduleUrl)), "..");
  return bundleVersion === undefined ? up : join(up, "assets", pkg);
}
