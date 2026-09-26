#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const target = process.argv[2];
if (!["electron", "daemon", "cli", "retired"].includes(target)) {
  throw new Error("Expected one build target: electron, daemon, cli, or retired");
}

const root = path.join(import.meta.dirname, "..");
if (target === "retired") {
  for (const relativePath of ["build/healthkit-bridge", "native/healthkit-bridge/.build"]) {
    await fs.rm(path.join(root, relativePath), { recursive: true, force: true });
  }
} else {
  // TypeScript does not remove JavaScript emitted for deleted source files. A clean
  // target directory keeps retired modules out of local and packaged builds.
  const output = path.join(root, "dist", target);
  await fs.rm(output, { recursive: true, force: true });
}
