import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Keep the full suite within the native-resource and shared-state limits
    // of CI runners after the Vitest 5 worker-pool changes.
    maxWorkers: 4,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/electron/security/**/*.ts", "src/shared/types.ts"],
    },
    testTimeout: 10000,
  },
});
