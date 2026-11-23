import { defineConfig } from "vitest/config";

// Sandbox-heavy suites (real rewire-sandbox, real vitest/tsc/semgrep runs per test) are run one
// file at a time: in parallel they contend for CPU and the shared node_modules, and wall-clock
// gate timeouts then fail tests at random (row 97 of the final review).
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
