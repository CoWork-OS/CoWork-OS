import fs from "fs";
import path from "path";
import { app, nativeImage, type NativeImage } from "electron";
import {
  MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG,
  LEGACY_MAC_SAFE_STORAGE_APP_NAME,
} from "./utils/mac-safe-storage-identity";

export const APP_DISPLAY_NAME = "CoWork OS";
export const APP_BUNDLE_ID = "com.cowork-os.app";
export { LEGACY_MAC_SAFE_STORAGE_APP_NAME, MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG };

export function getApplicationInternalName(argv: string[] = process.argv): string {
  const migrationWorkerIndex = argv.indexOf(MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG);
  if (migrationWorkerIndex < 0) return APP_DISPLAY_NAME;

  const requestedLegacyName = argv[migrationWorkerIndex + 1]?.trim();
  return requestedLegacyName || LEGACY_MAC_SAFE_STORAGE_APP_NAME;
}

function iconCandidates(): string[] {
  if (process.platform === "win32") {
    return ["build/icon.ico", "build/icon.png"];
  }
  return ["build/icon.png", "build/icon.icns"];
}

function appResourceRoots(): string[] {
  const roots = [app.getAppPath()];
  if (process.resourcesPath) {
    roots.push(process.resourcesPath);
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function applyApplicationIdentity(): void {
  // macOS safeStorage uses Electron's internal app name for its Keychain
  // service. Development and packaged builds share the same user-data store,
  // so they must also use the same name to read the same encrypted settings.
  app.setName(getApplicationInternalName());
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_BUNDLE_ID);
  }
}

export function getDesktopIconPath(): string | undefined {
  for (const root of appResourceRoots()) {
    for (const candidate of iconCandidates()) {
      const resolved = path.join(root, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }
  return undefined;
}

export function getDesktopIconImage(): NativeImage | undefined {
  const iconPath = getDesktopIconPath();
  if (!iconPath) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}
