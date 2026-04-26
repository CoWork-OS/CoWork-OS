import os from "os";
import path from "path";

const PROFILE_DIR_NAME = "profiles";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_ELECTRON_USER_DATA_DIR_NAME = "cowork-os";

export function getStableElectronUserDataRoot(appDataPath: string): string {
  return path.join(appDataPath, DEFAULT_ELECTRON_USER_DATA_DIR_NAME);
}

function expandPath(input: string): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  return path.resolve(expanded);
}

function getArgFlagValue(flag: string): string | undefined {
  const argv = process.argv || [];
  const idx = argv.indexOf(flag);
  return (
    (idx !== -1 && typeof argv[idx + 1] === "string" ? argv[idx + 1] : undefined) ??
    argv.find((a) => typeof a === "string" && a.startsWith(flag + "="))?.slice(flag.length + 1)
  );
}

function getElectronDefaultUserDataRoot(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const app = electron?.app;
    if (app?.getPath) {
      const appDataPath =
        typeof app.getPath === "function" ? String(app.getPath("appData") || "") : "";
      if (appDataPath) {
        return getStableElectronUserDataRoot(appDataPath);
      }
      return app.getPath("userData");
    }
  } catch {
    // Not running under Electron.
  }

  return null;
}

function normalizeProfileId(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  const compact = normalized.replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 64);
  return compact || DEFAULT_PROFILE_ID;
}

export function getActiveProfileId(): string {
  const raw =
    getArgFlagValue("--profile") ??
    process.env.COWORK_PROFILE ??
    process.env.COWORK_PROFILE_ID ??
    "";
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_PROFILE_ID;
  }
  return normalizeProfileId(raw);
}

export function getProfileUserDataDir(profileId: string): string {
  const root = getUserDataRootDir();
  const normalizedProfileId = normalizeProfileId(profileId);
  if (normalizedProfileId === DEFAULT_PROFILE_ID) {
    return root;
  }
  return path.join(root, PROFILE_DIR_NAME, normalizedProfileId);
}

export function hasNonDefaultProfile(): boolean {
  return getActiveProfileId() !== DEFAULT_PROFILE_ID;
}

export function getUserDataRootDir(): string {
  const override = process.env.COWORK_USER_DATA_DIR;
  if (typeof override === "string" && override.trim().length > 0) {
    return expandPath(override);
  }

  // CLI override (useful for local testing and future non-Electron daemons).
  // Accepts both `--user-data-dir /path` and `--user-data-dir=/path`.
  const rawFromArgv = getArgFlagValue("--user-data-dir");
  if (typeof rawFromArgv === "string" && rawFromArgv.trim().length > 0) {
    return expandPath(rawFromArgv);
  }

  const electronDefault = getElectronDefaultUserDataRoot();
  if (electronDefault) {
    return path.resolve(electronDefault);
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return path.join(home, ".cowork");
}

/**
 * Resolve the userData directory for persistence (DB + settings).
 *
 * In Electron runtime, this will usually be the app's default userData path.
 * In headless/server deployments we also support `COWORK_USER_DATA_DIR` as an override.
 * As a convenience, `--user-data-dir <path>` is also supported (works in both Electron and Node entrypoints).
 * For multi-profile execution, `COWORK_PROFILE` or `--profile <id>` scopes data under `profiles/<id>`.
 *
 * This helper intentionally avoids a static `import { app } from 'electron'` so it can be reused
 * by future non-Electron daemon entrypoints.
 */
export function getUserDataDir(): string {
  return getProfileUserDataDir(getActiveProfileId());
}
