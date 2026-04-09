#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const ELECTRON_DEPS = ["electron", "@electron/rebuild"];

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

function writePackageJson(pkg) {
  fs.writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function preparePackageJsonForElectronBuilder() {
  const pkg = readPackageJson();
  pkg.dependencies = pkg.dependencies || {};
  pkg.devDependencies = pkg.devDependencies || {};

  let changed = false;
  for (const dep of ELECTRON_DEPS) {
    if (pkg.dependencies[dep]) {
      pkg.devDependencies[dep] = pkg.dependencies[dep];
      delete pkg.dependencies[dep];
      changed = true;
    }
  }

  if (changed) {
    writePackageJson(pkg);
  }

  return changed;
}

function runElectronBuilder(args) {
  const result = spawnSync("npx", ["electron-builder", ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function main() {
  const originalPackageJson = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
  let status = 1;

  try {
    preparePackageJsonForElectronBuilder();
    status = runElectronBuilder(process.argv.slice(2));
  } finally {
    fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson);
  }

  process.exit(status);
}

main();
