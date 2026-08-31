import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LocalControlPlaneDiscoveryResult {
  url?: string;
  token?: string;
  source?: string;
  error?: string;
}

interface StoredControlPlaneSettings {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
}

interface SecureSettingsRow {
  encrypted_data: string;
  checksum: string;
}

const MACHINE_ID_FILE = ".cowork-machine-id";

export function discoverLocalControlPlane(profileName?: string): LocalControlPlaneDiscoveryResult {
  const dirs = discoverUserDataDirs(profileName);
  const errors: string[] = [];

  for (const dir of dirs) {
    const descriptor = readLocalConnectionDescriptor(dir);
    if (descriptor.token) return descriptor;
    if (descriptor.error) errors.push(descriptor.error);

    const legacy = readLegacySettings(dir);
    if (legacy.token) return legacy;
    if (legacy.error) errors.push(legacy.error);

    const db = readDatabaseSettings(dir);
    if (db.token) return db;
    if (db.error) errors.push(db.error);
  }

  return {
    error:
      errors.find((error) => error.includes("OS keychain")) ||
      errors[0] ||
      "No local GUI control-plane token was found.",
  };
}

function readLocalConnectionDescriptor(userDataDir: string): LocalControlPlaneDiscoveryResult {
  const filePath = path.join(userDataDir, "control-plane-local.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      url?: string;
      token?: string;
      pid?: number;
    };
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const url = typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : "";
    if (!token || !url) return { error: `Invalid local control-plane descriptor at ${filePath}` };
    if (typeof parsed.pid === "number" && parsed.pid > 0 && !isProcessRunning(parsed.pid)) {
      return { error: `Stale local control-plane descriptor at ${filePath}` };
    }
    return { url, token, source: filePath };
  } catch (error) {
    return {
      error: `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function discoverUserDataDirs(profileName?: string): string[] {
  const roots = process.env.COWORK_USER_DATA_DIR
    ? [process.env.COWORK_USER_DATA_DIR]
    : Array.from(
        new Set(
          [getPlatformElectronUserDataRoot(), path.join(os.homedir(), ".cowork")].filter(
            Boolean,
          ) as string[],
        ),
      );
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(root);
    const normalized = normalizeProfileId(
      profileName || process.env.COWORK_PROFILE || process.env.COWORK_PROFILE_ID || "",
    );
    if (normalized && normalized !== "default") {
      dirs.push(path.join(root, "profiles", normalized));
    }
    const profilesDir = path.join(root, "profiles");
    try {
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(profilesDir, entry.name));
      }
    } catch {
      // No profiles directory.
    }
  }
  return Array.from(new Set(dirs.map((dir) => path.resolve(dir))));
}

function readLegacySettings(userDataDir: string): LocalControlPlaneDiscoveryResult {
  const settingsPath = path.join(userDataDir, "control-plane-settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as StoredControlPlaneSettings;
    return normalizeSettings(settings, settingsPath);
  } catch (error) {
    return {
      error: `Failed to read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readDatabaseSettings(userDataDir: string): LocalControlPlaneDiscoveryResult {
  const dbPath = path.join(userDataDir, "cowork-os.db");
  if (!fs.existsSync(dbPath)) return {};

  let db: Any | undefined;
  try {
    // Loaded dynamically so `cowork --help` and tests do not need SQLite.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const openedDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    db = openedDb;
    const row = openedDb
      .prepare("SELECT encrypted_data, checksum FROM secure_settings WHERE category = ?")
      .get("controlplane") as SecureSettingsRow | undefined;
    if (!row) return {};
    const decrypted = decryptSecureSettings(row, userDataDir);
    const settings = JSON.parse(decrypted) as StoredControlPlaneSettings;
    return normalizeSettings(settings, dbPath);
  } catch (error) {
    const cliFallback = readDatabaseSettingsWithSqliteCli(dbPath, userDataDir);
    if (cliFallback.token || cliFallback.error) return cliFallback;
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read local GUI control-plane settings at ${dbPath}: ${message}` };
  } finally {
    try {
      db?.close?.();
    } catch {
      // Best-effort close.
    }
  }
}

function readDatabaseSettingsWithSqliteCli(
  dbPath: string,
  userDataDir: string,
): LocalControlPlaneDiscoveryResult {
  try {
    const output = execFileSync(
      "sqlite3",
      [
        "-separator",
        "\t",
        dbPath,
        "SELECT encrypted_data, checksum FROM secure_settings WHERE category = 'controlplane' LIMIT 1;",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!output) return {};
    const [encryptedData, checksum] = output.split("\t");
    if (!encryptedData || !checksum) return { error: `Invalid sqlite3 output for ${dbPath}` };
    const decrypted = decryptSecureSettings(
      { encrypted_data: encryptedData, checksum },
      userDataDir,
    );
    return normalizeSettings(JSON.parse(decrypted) as StoredControlPlaneSettings, dbPath);
  } catch (error) {
    return {
      error: `Failed sqlite3 fallback for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function normalizeSettings(
  settings: StoredControlPlaneSettings,
  source: string,
): LocalControlPlaneDiscoveryResult {
  const token = typeof settings.token === "string" ? settings.token.trim() : "";
  if (!token) return { error: `No control-plane token in ${source}` };
  if (settings.enabled === false) {
    return { error: `Control plane is disabled in ${source}` };
  }
  const host =
    typeof settings.host === "string" && settings.host.trim() ? settings.host.trim() : "127.0.0.1";
  const port =
    typeof settings.port === "number" && Number.isFinite(settings.port) ? settings.port : 18789;
  return {
    url: `ws://${host}:${port}`,
    token,
    source,
  };
}

function decryptSecureSettings(row: SecureSettingsRow, userDataDir: string): string {
  const encryptedData = row.encrypted_data;
  if (encryptedData.startsWith("app:")) {
    const parts = encryptedData.slice(4).split(":");
    if (parts.length !== 3) throw new Error("Invalid app-encrypted settings format");
    const [ivBase64, authTagBase64, encrypted] = parts;
    const key = deriveAppKey(userDataDir);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");
    verifyChecksum(decrypted, row.checksum);
    return decrypted;
  }
  if (encryptedData.startsWith("os:")) {
    throw new Error(
      "settings are encrypted with the Electron OS keychain. Open CoWork OS settings and copy the Control Plane token once, or run `cowork login --token <token>`.",
    );
  }
  verifyChecksum(encryptedData, row.checksum);
  return encryptedData;
}

function verifyChecksum(data: string, expected: string): void {
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error("settings checksum mismatch");
}

function deriveAppKey(userDataDir: string): Buffer {
  const appSalt = "cowork-os-secure-settings-v1";
  const machineId = readMachineIdentifier(userDataDir);
  return crypto.pbkdf2Sync(appSalt, machineId, 100000, 32, "sha512");
}

function readMachineIdentifier(userDataDir: string): string {
  const machineIdPath = path.join(userDataDir, MACHINE_ID_FILE);
  try {
    if (fs.existsSync(machineIdPath)) {
      const value = fs.readFileSync(machineIdPath, "utf8").trim();
      if (value) return value;
    }
  } catch {
    // Use path-derived fallback below.
  }
  return [userDataDir, machineIdPath, "cowork-os-secure-settings-fallback-v2"].join(":");
}

function getPlatformElectronUserDataRoot(): string | undefined {
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "cowork-os");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "cowork-os");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "cowork-os");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeProfileId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  return normalized.replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 64);
}

type Any = Record<string, any>;
