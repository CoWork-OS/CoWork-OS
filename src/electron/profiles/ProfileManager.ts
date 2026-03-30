import * as fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import { app } from "electron";
import { createLogger } from "../utils/logger";
import {
  getActiveProfileId,
  getProfileUserDataDir,
  getUserDataRootDir,
} from "../utils/user-data-dir";
import type { AppProfileSummary, ProfileExportResult } from "../../shared/types";

const logger = createLogger("ProfileManager");
const PROFILE_META_FILE = ".cowork-profile.json";
const PROFILE_EXPORT_FILE = "cowork-profile-export.json";

type ProfileMetadata = {
  id: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
};

async function readProfileMetadata(profileDir: string): Promise<ProfileMetadata | null> {
  try {
    const raw = await fs.readFile(path.join(profileDir, PROFILE_META_FILE), "utf8");
    const parsed = JSON.parse(raw) as ProfileMetadata;
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeProfileMetadata(
  profileDir: string,
  metadata: ProfileMetadata,
): Promise<ProfileMetadata> {
  const nextMetadata: ProfileMetadata = {
    id: metadata.id,
    label: metadata.label?.trim() || metadata.id,
    createdAt: metadata.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await fs.writeFile(
    path.join(profileDir, PROFILE_META_FILE),
    JSON.stringify(nextMetadata, null, 2),
    "utf8",
  );
  return nextMetadata;
}

function toSummary(
  profileId: string,
  profileDir: string,
  metadata?: ProfileMetadata | null,
): AppProfileSummary {
  const stat = fsSync.existsSync(profileDir) ? fsSync.statSync(profileDir) : null;
  return {
    id: profileId,
    label: metadata?.label?.trim() || profileId,
    userDataDir: profileDir,
    isActive: profileId === getActiveProfileId(),
    isDefault: profileId === "default",
    createdAt: metadata?.createdAt ?? stat?.birthtimeMs ?? stat?.ctimeMs ?? Date.now(),
    updatedAt: metadata?.updatedAt ?? stat?.mtimeMs ?? stat?.ctimeMs ?? Date.now(),
  };
}

function getProfilesRootDir(): string {
  return path.join(getUserDataRootDir(), "profiles");
}

function stripProfileArgs(argv: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--profile=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

export class ProfileManager {
  static async listProfiles(): Promise<AppProfileSummary[]> {
    const summaries: AppProfileSummary[] = [];
    const activeProfileId = getActiveProfileId();
    summaries.push(await this.ensureProfile("default"));

    const profilesRoot = getProfilesRootDir();
    try {
      const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const profileId = entry.name;
        if (profileId === "default") continue;
        const profileDir = path.join(profilesRoot, profileId);
        const metadata = await readProfileMetadata(profileDir);
        summaries.push(toSummary(profileId, profileDir, metadata));
      }
    } catch {
      // Profiles directory does not exist yet.
    }

    return summaries.sort((a, b) => {
      if (a.id === activeProfileId) return -1;
      if (b.id === activeProfileId) return 1;
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.label.localeCompare(b.label);
    });
  }

  static async ensureProfile(profileIdOrLabel: string): Promise<AppProfileSummary> {
    const trimmed = String(profileIdOrLabel || "").trim();
    if (!trimmed) {
      throw new Error("Profile name is required.");
    }
    const profileId =
      trimmed === "default"
        ? "default"
        : path.basename(getProfileUserDataDir(trimmed)).split(path.sep).pop() || "default";
    const profileDir = getProfileUserDataDir(profileId);
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const existing = await readProfileMetadata(profileDir);
    const metadata = await writeProfileMetadata(profileDir, {
      id: profileId,
      label: existing?.label?.trim() || trimmed,
      createdAt: existing?.createdAt,
    });
    return toSummary(profileId, profileDir, metadata);
  }

  static async exportProfile(profileId: string, destinationRoot: string): Promise<ProfileExportResult> {
    const summary = await this.ensureProfile(profileId);
    const destinationDir = path.resolve(destinationRoot);
    await fs.mkdir(destinationDir, { recursive: true, mode: 0o700 });

    const baseName = `cowork-profile-${summary.id}`;
    let bundlePath = path.join(destinationDir, baseName);
    let suffix = 1;
    while (fsSync.existsSync(bundlePath)) {
      bundlePath = path.join(destinationDir, `${baseName}-${suffix}`);
      suffix += 1;
    }

    await fs.cp(summary.userDataDir, bundlePath, {
      recursive: true,
      errorOnExist: true,
      filter: (source) => {
        if (!summary.isDefault) return true;
        return path.resolve(source) !== path.resolve(path.join(summary.userDataDir, "profiles"));
      },
    });
    await fs.writeFile(
      path.join(bundlePath, PROFILE_EXPORT_FILE),
      JSON.stringify(
        {
          exportedAt: Date.now(),
          profile: summary,
        },
        null,
        2,
      ),
      "utf8",
    );

    return { profile: summary, bundlePath };
  }

  static async importProfile(sourcePath: string, requestedName?: string): Promise<AppProfileSummary> {
    const importRoot = path.resolve(sourcePath);
    const stat = await fs.stat(importRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error("Import source must be a profile export folder.");
    }

    const exportManifestPath = path.join(importRoot, PROFILE_EXPORT_FILE);
    let importedLabel = "";
    let importedId = "";
    if (fsSync.existsSync(exportManifestPath)) {
      try {
        const manifestRaw = await fs.readFile(exportManifestPath, "utf8");
        const manifest = JSON.parse(manifestRaw) as {
          profile?: { id?: string; label?: string };
        };
        importedLabel = String(manifest?.profile?.label || "").trim();
        importedId = String(manifest?.profile?.id || "").trim();
      } catch {
        // Ignore malformed manifest and fall back to folder name.
      }
    }

    const targetHint = requestedName?.trim() || importedLabel || importedId || path.basename(importRoot);
    const summary = await this.ensureProfile(targetHint);
    const existingEntries = await fs.readdir(summary.userDataDir).catch(() => []);
    const allowedEmptyEntries = new Set([PROFILE_META_FILE]);
    const hasExistingData = existingEntries.some((entry) => !allowedEmptyEntries.has(entry));
    if (hasExistingData) {
      throw new Error(`Profile "${summary.id}" already has data. Choose a different name.`);
    }

    const importedEntries = await fs.readdir(importRoot, { withFileTypes: true });
    for (const entry of importedEntries) {
      if (entry.name === PROFILE_EXPORT_FILE) continue;
      const from = path.join(importRoot, entry.name);
      const to = path.join(summary.userDataDir, entry.name);
      await fs.cp(from, to, { recursive: true, errorOnExist: true });
    }

    await writeProfileMetadata(summary.userDataDir, {
      id: summary.id,
      label: importedLabel || requestedName?.trim() || summary.label,
      createdAt: summary.createdAt,
    });
    return toSummary(summary.id, summary.userDataDir, await readProfileMetadata(summary.userDataDir));
  }

  static async switchProfile(profileId: string): Promise<{ success: true; relaunching: true }> {
    const summary = await this.ensureProfile(profileId);
    const nextArgs = stripProfileArgs(process.argv.slice(1));
    if (!summary.isDefault) {
      nextArgs.push("--profile", summary.id);
    } else {
      nextArgs.push("--profile", "default");
    }
    logger.info(`Switching to profile "${summary.id}" and relaunching app.`);
    app.relaunch({ args: nextArgs });
    app.exit(0);
    return { success: true, relaunching: true };
  }
}
