#!/usr/bin/env node
/**
 * Removes Keychain "Safe Storage" items left by former CoWork OS identities.
 *
 * Dry run by default; pass --yes to delete. An identity is only removed when
 * the app's own legacy-identity worker confirms that it no longer decrypts any
 * stored setting or channel config (run CoWork OS once first so the startup
 * migration can move anything it still holds to the current identity).
 *
 * Only CoWork-specific identities are candidates. Generic identities shared
 * with other software (Electron, com.github.Electron, Chromium) and the
 * current "CoWork OS" identity are never touched.
 *
 * Usage:
 *   npm run keychain:cleanup            # show what would be removed
 *   npm run keychain:cleanup -- --yes   # remove it
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKER_FLAG = "--cowork-safe-storage-migration-worker";
const RESULT_PREFIX = "COWORK_SAFE_STORAGE_MIGRATION_RESULT=";

/** Former CoWork-only identities (see LEGACY_MAC_SAFE_STORAGE_APP_NAMES). */
export const REMOVABLE_IDENTITIES = [
  "cowork-os",
  "cowork-oss",
  "com.cowork-os.app",
  "cowork-profile-probe",
  "cowork-safe-storage-probe",
];
export const PROTECTED_IDENTITIES = ["CoWork OS", "Electron", "com.github.Electron", "Chromium"];

function log(message) {
  process.stdout.write(`[keychain-cleanup] ${message}\n`);
}

function userDataDir(env = process.env) {
  return (
    env.COWORK_USER_DATA_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "cowork-os")
  );
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 failed: ${result.stderr.trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function tableExists(dbPath, table) {
  return (
    sqliteJson(dbPath, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)
      .length > 0
  );
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Ciphertext only; the worker reports which rows a given identity can decrypt. */
export function loadEncryptedRows(dbPath) {
  const rows = sqliteJson(
    dbPath,
    "SELECT category, encrypted_data, checksum FROM secure_settings WHERE encrypted_data LIKE 'os:%'",
  );
  if (tableExists(dbPath, "channels")) {
    for (const channel of sqliteJson(
      dbPath,
      "SELECT id, config FROM channels WHERE config LIKE 'enc:%'",
    )) {
      const encrypted = `os:${channel.config.slice("enc:".length)}`;
      rows.push({
        category: `channel:${channel.id}`,
        encrypted_data: encrypted,
        checksum: checksum(encrypted),
      });
    }
  }
  return rows;
}

function countDecryptableRows(identity, rows) {
  const electron = path.join(ROOT, "node_modules", ".bin", "electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [".", WORKER_FLAG, identity], {
    cwd: ROOT,
    env,
    input: JSON.stringify(rows),
    encoding: "utf8",
    timeout: 60_000,
    // The worker prints decrypted values; they are counted here, never logged.
    stdio: ["pipe", "pipe", "ignore"],
  });
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RESULT_PREFIX));
  if (result.status !== 0 || !line) return null;
  const decrypted = JSON.parse(line.slice(RESULT_PREFIX.length));
  return Array.isArray(decrypted) ? decrypted.length : null;
}

function keychainItemExists(service, account) {
  return (
    spawnSync("security", ["find-generic-password", "-s", service, "-a", account], {
      stdio: "ignore",
    }).status === 0
  );
}

export function keychainAccounts(identity) {
  return [identity, `${identity} Key`];
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (process.platform !== "darwin") {
    log("Only needed on macOS.");
    return 0;
  }
  const apply = argv.includes("--yes");
  const dbPath = path.join(userDataDir(env), "cowork-os.db");
  if (!existsSync(dbPath)) {
    log(`No CoWork OS database at ${dbPath}.`);
    return 1;
  }
  if (!existsSync(path.join(ROOT, "dist", "electron", "electron", "main.js"))) {
    log("Build the app first (npm run build:electron) so the identity check can run.");
    return 1;
  }

  const rows = loadEncryptedRows(dbPath);
  let removed = 0;
  let pending = 0;
  for (const identity of REMOVABLE_IDENTITIES) {
    const service = `${identity} Safe Storage`;
    const accounts = keychainAccounts(identity).filter((account) =>
      keychainItemExists(service, account),
    );
    if (accounts.length === 0) continue;

    const readable = rows.length === 0 ? 0 : countDecryptableRows(identity, rows);
    if (readable === null) {
      log(`${service}: could not verify it is unused; kept.`);
      continue;
    }
    if (readable > 0) {
      log(
        `${service}: still decrypts ${readable} stored item(s); launch CoWork OS to migrate them first. Kept.`,
      );
      continue;
    }

    for (const account of accounts) {
      if (!apply) {
        log(`Would remove "${service}" (account "${account}").`);
        pending += 1;
        continue;
      }
      const result = spawnSync(
        "security",
        ["delete-generic-password", "-s", service, "-a", account],
        { stdio: "ignore" },
      );
      if (result.status === 0) {
        log(`Removed "${service}" (account "${account}").`);
        removed += 1;
      } else {
        log(`Could not remove "${service}" (account "${account}").`);
      }
    }
  }

  log(`Never removed: ${PROTECTED_IDENTITIES.map((name) => `"${name} Safe Storage"`).join(", ")}.`);
  if (!apply)
    log(pending ? `${pending} item(s) can be removed; re-run with --yes.` : "Nothing to remove.");
  else log(`Removed ${removed} item(s).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
