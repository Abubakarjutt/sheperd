import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replaced with the package version by the sheperd bundler (scripts/npm/build.mjs, esbuild
 * `define`); never set when running from the source checkout.
 */
declare const REWIRE_BUNDLE_VERSION: string | undefined;

/**
 * Replaced by the sheperd bundler with the sha256 (hex) of each platform package's
 * rewire-sandbox, keyed `<platform>-<arch>`, computed from the binaries it packs.
 */
declare const REWIRE_BUNDLE_SANDBOX_SHA256: Record<string, string> | undefined;

/** The published `sheperd` version when running from the npm bundle; undefined from source. */
export const BUNDLE_VERSION: string | undefined =
  typeof REWIRE_BUNDLE_VERSION === "string" ? REWIRE_BUNDLE_VERSION : undefined;

/**
 * The sha256 of every platform package binary this bundle was built with; undefined from
 * source. The sandbox lookup refuses a platform package binary that does not match (#22).
 */
export const BUNDLE_SANDBOX_SHA256: Readonly<Record<string, string>> | undefined =
  typeof REWIRE_BUNDLE_SANDBOX_SHA256 === "object" && REWIRE_BUNDLE_SANDBOX_SHA256 !== null
    ? Object.freeze({ ...REWIRE_BUNDLE_SANDBOX_SHA256 })
    : undefined;

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
