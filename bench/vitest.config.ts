import { defineConfig } from "vitest/config";

// Only the harness's own tests. The fixtures under tasks/ are inputs, never run here.
export default defineConfig({ test: { include: ["runner/test/**/*.test.ts"] } });
