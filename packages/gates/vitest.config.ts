import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../sandbox/test/global-setup.ts"],
    testTimeout: 30000,
    // The fixture project holds its own tests; they only run inside gate tests.
    exclude: ["**/node_modules/**", "test/fixtures/**"],
  },
});
