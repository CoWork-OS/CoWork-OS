/**
 * Cron Store - File-based persistence for scheduled tasks
 * Uses atomic writes with temporary files for data safety
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUserDataDir } from "../utils/user-data-dir";
import type { CronStoreFile } from "./types";

// Lazy-evaluated paths (app.getPath() is not available until app is ready)
let _cronDir: string | null = null;
let _cronStorePath: string | null = null;

export function getCronDir(): string {
  if (!_cronDir) {
    _cronDir = path.join(getUserDataDir(), "cron");
  }
  return _cronDir;
}

export function getCronStorePath(): string {
  if (!_cronStorePath) {
    _cronStorePath = path.join(getCronDir(), "jobs.json");
  }
  return _cronStorePath;
}

// Legacy exports - use getter functions instead
export const DEFAULT_CRON_DIR = "" as string;
export const DEFAULT_CRON_STORE_PATH = "" as string;

/**
 * Resolve the cron store path, supporting ~ expansion
 */
export function resolveCronStorePath(storePath?: string): string {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(raw.replace("~", os.homedir()));
    }
    return path.resolve(raw);
  }
  return getCronStorePath();
}

/**
 * Load cron jobs from the store file
 * Returns empty jobs array if file doesn't exist or is invalid
 */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CronStoreFile> | null;
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const outbox = Array.isArray(parsed?.outbox) ? parsed.outbox : [];

    // Validate and filter jobs
    const validJobs = jobs.filter((job): job is CronStoreFile["jobs"][number] => {
      return (
        job &&
        typeof job === "object" &&
        typeof job.id === "string" &&
        typeof job.name === "string" &&
        typeof job.enabled === "boolean" &&
        typeof job.workspaceId === "string" &&
        typeof job.taskPrompt === "string" &&
        job.schedule &&
        typeof job.schedule === "object"
      );
    });

    return {
      version: 1,
      jobs: validJobs,
      outbox: outbox.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as Any).id === "string" &&
          typeof (entry as Any).jobId === "string" &&
          typeof (entry as Any).channelType === "string" &&
          typeof (entry as Any).channelId === "string" &&
          typeof (entry as Any).state === "string",
      ) as CronStoreFile["outbox"],
    };
  } catch  {
    // File doesn't exist or is invalid - return empty store
    return { version: 1, jobs: [], outbox: [] };
  }
}

/**
 * Load cron store synchronously (for initialization)
 */
export function loadCronStoreSync(storePath: string): CronStoreFile {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CronStoreFile> | null;
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const outbox = Array.isArray(parsed?.outbox) ? parsed.outbox : [];

    // Validate and filter jobs
    const validJobs = jobs.filter((job): job is CronStoreFile["jobs"][number] => {
      return (
        job &&
        typeof job === "object" &&
        typeof job.id === "string" &&
        typeof job.name === "string" &&
        typeof job.enabled === "boolean" &&
        typeof job.workspaceId === "string" &&
        typeof job.taskPrompt === "string" &&
        job.schedule &&
        typeof job.schedule === "object"
      );
    });

    return {
      version: 1,
      jobs: validJobs,
      outbox: outbox.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as Any).id === "string" &&
          typeof (entry as Any).jobId === "string" &&
          typeof (entry as Any).channelType === "string" &&
          typeof (entry as Any).channelId === "string" &&
          typeof (entry as Any).state === "string",
      ) as CronStoreFile["outbox"],
    };
  } catch {
    return { version: 1, jobs: [], outbox: [] };
  }
}

/**
 * Save cron jobs to the store file
 * Uses atomic writes to prevent data corruption
 */
export async function saveCronStore(storePath: string, store: CronStoreFile): Promise<void> {
  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  // Generate temp file path with process ID and random suffix
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");

  // Atomic rename
  await fs.promises.rename(tmp, storePath);

  // Best-effort backup
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // Ignore backup errors
  }
}

/**
 * Save cron store synchronously
 */
export function saveCronStoreSync(storePath: string, store: CronStoreFile): void {
  // Ensure directory exists
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  // Generate temp file path
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(tmp, json, "utf-8");

  // Atomic rename
  fs.renameSync(tmp, storePath);

  // Best-effort backup
  try {
    fs.copyFileSync(storePath, `${storePath}.bak`);
  } catch {
    // Ignore backup errors
  }
}
