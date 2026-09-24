import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Keep the full suite within native-resource and shared-state limits in CI.
    maxWorkers: 4,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/electron/security/**/*.ts", "src/shared/types.ts"],
    },
    testTimeout: 10000,
  },
});
