import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverLocalControlPlane, discoverUserDataDirs } from "../local-control-plane-discovery";

const OLD_USER_DATA_DIR = process.env.COWORK_USER_DATA_DIR;

describe("local control-plane discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cli-discovery-"));
    process.env.COWORK_USER_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (OLD_USER_DATA_DIR === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = OLD_USER_DATA_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes the override user-data directory", () => {
    expect(discoverUserDataDirs()).toContain(path.resolve(tempDir));
  });

  it("discovers app-encrypted control-plane settings from the GUI database", () => {
    writeControlPlaneSettings(tempDir, {
      enabled: true,
      host: "127.0.0.1",
      port: 18888,
      token: "local-token",
    });

    expect(discoverLocalControlPlane()).toMatchObject({
      url: "ws://127.0.0.1:18888",
      token: "local-token",
    });
  });

  it("prefers the local descriptor written by a running GUI", () => {
    fs.writeFileSync(
      path.join(tempDir, "control-plane-local.json"),
      JSON.stringify({
        version: 1,
        url: "ws://127.0.0.1:19999",
        token: "descriptor-token",
        pid: process.pid,
      }),
    );

    expect(discoverLocalControlPlane()).toMatchObject({
      url: "ws://127.0.0.1:19999",
      token: "descriptor-token",
    });
  });

  it("reports OS keychain settings as a one-time login fallback", () => {
    writeSecureSettingsRow(tempDir, "os:not-decryptable-in-node", "bad-checksum");

    expect(discoverLocalControlPlane().error).toContain("OS keychain");
  });
});

function writeControlPlaneSettings(userDataDir: string, settings: object): void {
  const raw = JSON.stringify(settings);
  writeSecureSettingsRow(userDataDir, encryptAppSettings(userDataDir, raw), checksum(raw));
}

function writeSecureSettingsRow(
  userDataDir: string,
  encryptedData: string,
  rowChecksum: string,
): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, "cowork-os.db");
  execFileSync("sqlite3", [
    dbPath,
    "CREATE TABLE secure_settings (id TEXT PRIMARY KEY, category TEXT NOT NULL, encrypted_data TEXT NOT NULL, checksum TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
  ]);
  execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO secure_settings (id, category, encrypted_data, checksum, created_at, updated_at) VALUES ('id-1', 'controlplane', '${escapeSql(encryptedData)}', '${escapeSql(rowChecksum)}', 1, 1);`,
  ]);
}

function encryptAppSettings(userDataDir: string, data: string): string {
  const machineId = "test-machine-id";
  fs.writeFileSync(path.join(userDataDir, ".cowork-machine-id"), machineId, "utf8");
  const key = crypto.pbkdf2Sync("cowork-os-secure-settings-v1", machineId, 100000, 32, "sha512");
  const iv = Buffer.alloc(16, 1);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(data, "utf8", "base64");
  encrypted += cipher.final("base64");
  return `app:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted}`;
}

function checksum(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
