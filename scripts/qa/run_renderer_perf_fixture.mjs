#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = ["vitest", "run", "src/renderer/utils/__tests__/renderer-perf-fixture.test.ts"];

const result = spawnSync("npx", args, {
  stdio: "inherit",
  env: {
    ...process.env,
  },
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
