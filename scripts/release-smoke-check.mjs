import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const pkgDir = path.resolve(process.cwd(), "node_modules/cowork-os");
const pkgJsonPath = path.join(pkgDir, "package.json");

if (!fs.existsSync(pkgJsonPath)) {
  throw new Error(`Expected installed package at ${pkgJsonPath}`);
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
