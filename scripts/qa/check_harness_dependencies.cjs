/* eslint-disable no-console */
// Harness database suites otherwise skip when the addon has the wrong ABI.
// The required gate must fail visibly instead of losing recovery/replay coverage.
const { execFileSync } = require("node:child_process");

try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try {
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
  execFileSync("sqlite3", ["--version"], { stdio: "ignore", timeout: 10_000 });
  console.log("[harness] Native SQLite and sqlite3 CLI are available.");
} catch (error) {
  console.error("[harness] Required database test dependencies are unavailable:", error.message);
  console.error(
    "[harness] Use Node 24+, install sqlite3, and run npm rebuild better-sqlite3 --ignore-scripts=false for the active Node ABI.",
  );
  process.exitCode = 1;
}
