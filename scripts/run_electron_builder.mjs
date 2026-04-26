#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const ELECTRON_DEPS = ["electron", "@electron/rebuild"];

function isFalseEnv(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function isMacBuild(args) {
  return args.some((arg) => arg === "--mac" || arg.startsWith("--mac="));
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

function writePackageJson(pkg) {
  fs.writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function preparePackageJsonForElectronBuilder(args) {
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

  if (isMacBuild(args) && process.env.COWORK_MAC_UNSIGNED === "1") {
    pkg.build = pkg.build || {};
    pkg.build.mac = pkg.build.mac || {};
    pkg.build.mac.identity = null;
    pkg.build.mac.notarize = false;
    pkg.build.mac.gatekeeperAssess = false;
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    changed = true;
  } else if (isMacBuild(args) && isFalseEnv(process.env.CSC_IDENTITY_AUTO_DISCOVERY)) {
    pkg.build = pkg.build || {};
    pkg.build.mac = pkg.build.mac || {};
    pkg.build.mac.identity = null;
    pkg.build.mac.notarize = false;
    pkg.build.mac.gatekeeperAssess = false;
    changed = true;
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
    const args = process.argv.slice(2);
    preparePackageJsonForElectronBuilder(args);
    status = runElectronBuilder(args);
  } finally {
    fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson);
  }

  process.exit(status);
}

main();
