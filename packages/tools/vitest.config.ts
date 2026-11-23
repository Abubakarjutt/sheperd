import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["../sandbox/test/global-setup.ts"],
    testTimeout: 30000,
  },
});
