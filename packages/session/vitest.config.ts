import { defineConfig } from "vitest/config";

// Chat tests run the real rewire-sandbox; one file at a time keeps wall-clock timeouts stable.
export default defineConfig({
  test: { testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
