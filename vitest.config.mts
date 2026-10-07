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
    // CI runners (macOS ones especially) run real SQLite, sandbox and worker tests several
    // times slower than a laptop; give tests and hooks more room there.
    testTimeout: process.env.CI ? 30_000 : 10_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
});
