import fs from "fs";
import path from "path";
import { getUserDataDir } from "../utils/user-data-dir";

export interface SessionRetentionSettings {
  autoPrune?: {
    enabled?: boolean;
    olderThan?: string;
    includeArchived?: boolean;
    minIntervalHours?: number;
    vacuum?: boolean;
    lastRunAt?: number;
  };
}

const SETTINGS_FILE = "session-retention-settings.json";

export function loadSessionRetentionSettings(): SessionRetentionSettings {
  try {
    const text = fs.readFileSync(sessionRetentionSettingsPath(), "utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SessionRetentionSettings) : {};
  } catch {
    return {};
  }
}

export function saveSessionRetentionSettings(settings: SessionRetentionSettings): void {
  const file = sessionRetentionSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function sessionRetentionSettingsPath(): string {
  return path.join(getUserDataDir(), SETTINGS_FILE);
}
