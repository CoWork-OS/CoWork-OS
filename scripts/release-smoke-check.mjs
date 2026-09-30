import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const packageName = process.env.COWORK_RELEASE_PACKAGE_NAME || "cowork-os";
if (!["cowork-os", "@cowork-os/cowork-os"].includes(packageName)) {
  throw new Error("Unexpected release package name.");
}
const pkgDir = path.resolve(process.cwd(), "node_modules", packageName);
const pkgJsonPath = path.join(pkgDir, "package.json");

if (!fs.existsSync(pkgJsonPath)) {
  throw new Error(`Expected installed package at ${pkgJsonPath}`);
}

const webIndexPath = path.join(pkgDir, "dist", "web", "index.html");
const webAssetsPath = path.join(pkgDir, "dist", "web", "assets");
if (!fs.existsSync(webIndexPath) || !fs.existsSync(webAssetsPath)) {
  throw new Error("Installed package is missing the browser application build");
}
if (!fs.readdirSync(webAssetsPath).some((name) => name.endsWith(".js"))) {
  throw new Error("Installed browser application is missing its JavaScript asset");
}
const webManifest = JSON.parse(
  fs.readFileSync(path.join(pkgDir, "dist", "web", "web-manifest.json"), "utf8"),
);
const installedManifest = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
if (webManifest.apiVersion !== 1 || webManifest.appVersion !== installedManifest.version) {
  throw new Error("Installed browser application version does not match the package");
}

const pkgRequire = createRequire(pkgJsonPath);
const electron = pkgRequire("electron");
const betterSqlite3Path = pkgRequire.resolve("better-sqlite3");
const out = execFileSync(
  electron,
  [
    "-e",
    `const Database=require(${JSON.stringify(betterSqlite3Path)});const db=new Database(':memory:');db.close();console.log('ok')`,
  ],
  {
    cwd: pkgDir,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  },
);

if ((out || "").trim() !== "ok") {
  console.error("Installed package check failed; better-sqlite3 not loading in Electron.");
  process.exit(1);
}

const browserSmoke = spawnSync(
  process.execPath,
  [path.join(pkgDir, "scripts", "qa", "smoke-browser-preview.mjs")],
  {
    cwd: pkgDir,
    env: { ...process.env, COWORK_WEB_SMOKE_DAEMON_ENTRY: "bin/coworkd-node.js" },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  },
);
if (browserSmoke.stdout) process.stdout.write(browserSmoke.stdout);
if (browserSmoke.stderr) process.stderr.write(browserSmoke.stderr);
if (browserSmoke.error || browserSmoke.status !== 0) {
  throw browserSmoke.error || new Error("Installed browser workflow smoke failed.");
}
