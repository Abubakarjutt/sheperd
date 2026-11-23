import { assetRoot } from "@rewire/core";

/** Where this package's shipped assets live, from source or from the sheperd bundle. */
export const PACKAGE_ROOT = assetRoot("reviewers", import.meta.url);
