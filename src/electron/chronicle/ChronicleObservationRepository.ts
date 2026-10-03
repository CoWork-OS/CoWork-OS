import { MemorySettingsRepository } from "../database/repository-facades";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { DatabaseManager } from "../database/schema";

import { ChronicleSettingsManager } from "./ChronicleSettingsManager";
import type { ChroniclePersistedObservation, ChronicleResolvedContext } from "./types";

const logger = createLogger("ChronicleObservationRepository");
const CHRONICLE_DIR = path.join(".cowork", "chronicle");
const OBSERVATIONS_DIR = path.join(CHRONICLE_DIR, "observations");
const ASSETS_DIR = path.join(CHRONICLE_DIR, "assets");

/**
 * Persisted observation IDs are generated in `promote()` as
 * `chronicle-<taskId>-<frameId>` where both parts are UUID-like tokens. Only
 * that shape is accepted anywhere an ID is turned into a file name, so an ID
 * from IPC or from a JSON file cannot traverse out of the observations dir.
 */
const OBSERVATION_ID_PATTERN = /^chronicle-[A-Za-z0-9_-]{1,200}$/;
const ID_PART_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function isValidChronicleObservationId(value: unknown): value is string {
  return typeof value === "string" && OBSERVATION_ID_PATTERN.test(value);
}

/**
 * Optional write guard supplied by the caller (the agent tool registry passes
 * the task's access-profile evaluation). Returning false skips durable
 * promotion entirely.
 */
export type ChronicleWriteGuard = (absolutePath: string) => boolean;

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrNull(target: string): string | null {
  try {
    return fsSync.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Resolve a Chronicle subdirectory and confirm it really lives inside the
 * workspace (a symlinked `.cowork/chronicle` must not redirect reads, writes
 * or deletes elsewhere). Returns the canonical directory or null.
 */
function resolveConfinedDir(workspacePath: string, relativeDir: string): string | null {
  const workspaceReal = realpathOrNull(workspacePath);
  const dirReal = realpathOrNull(path.join(workspacePath, relativeDir));
  if (!workspaceReal || !dirReal) return null;
  if (!isPathWithin(workspaceReal, dirReal) || dirReal === workspaceReal) return null;
  return dirReal;
}

/**
 * True only when `imagePath` is a direct child of the workspace's Chronicle
 * assets directory (after resolving symlinks on the parent) and is named after
 * the owning record. `imagePath` comes from JSON on disk that the agent can
 * edit, so it is never trusted for file operations without this check.
 */
export function isConfinedChronicleAssetPath(
  workspacePath: string,
  imagePath: unknown,
  recordId: string,
): boolean {
  if (typeof imagePath !== "string" || !imagePath || !isValidChronicleObservationId(recordId)) {
    return false;
  }
  if (!path.isAbsolute(imagePath)) return false;
  const assetsReal = resolveConfinedDir(workspacePath, ASSETS_DIR);
  if (!assetsReal) return false;
  const resolved = path.resolve(imagePath);
  const parentReal = realpathOrNull(path.dirname(resolved));
  if (!parentReal || parentReal !== assetsReal) return false;
  const base = path.basename(resolved);
  const ext = path.extname(base).toLowerCase();
  return base === `${recordId}${ext}` && ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Replace a file without following a pre-existing symlink at the target (a
 * planted link in the assets/observations dir must not redirect the write).
 */
async function replaceFileNoFollow(target: string, data: string): Promise<void> {
  await fs.rm(target, { force: true });
  await fs.writeFile(target, data, { encoding: "utf8", flag: "wx" });
}

function sanitizeRecord(raw: unknown, fileName: string): ChroniclePersistedObservation | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as ChroniclePersistedObservation;
  if (!isValidChronicleObservationId(record.id)) return null;
  // The file name must match the record ID so a planted record cannot alias another.
  if (path.basename(fileName) !== `${record.id}.json`) return null;
  if (typeof record.capturedAt !== "number" || !Number.isFinite(record.capturedAt)) return null;
  if (typeof record.imagePath !== "string") return null;
  return record;
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreObservation(record: ChroniclePersistedObservation, query: string): number {
  const haystack = normalizeText(
    `${record.query} ${record.appName} ${record.windowTitle} ${record.localTextSnippet}`,
  );
  const terms = normalizeText(query)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (terms.length === 0) return record.confidence;
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return matches / terms.length + record.confidence * 0.5;
}

async function ensureWorkspaceDirs(workspacePath: string): Promise<{
  observationsDir: string;
  assetsDir: string;
}> {
  const observationsDir = path.join(workspacePath, OBSERVATIONS_DIR);
  const assetsDir = path.join(workspacePath, ASSETS_DIR);
  await fs.mkdir(observationsDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
  return { observationsDir, assetsDir };
}

async function readObservationFile(
  filePath: string,
): Promise<ChroniclePersistedObservation | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return sanitizeRecord(JSON.parse(raw), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    logger.warn(`Failed to read Chronicle observation ${path.basename(filePath)}:`, error);
    return null;
  }
}

function readObservationFileSync(filePath: string): ChroniclePersistedObservation | null {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    return sanitizeRecord(JSON.parse(raw), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    logger.warn(`Failed to read Chronicle observation ${path.basename(filePath)}:`, error);
    return null;
  }
}

async function shouldPersistDurably(workspaceId: string): Promise<boolean> {
  const chronicleSettings = ChronicleSettingsManager.loadSettings();
  if (!chronicleSettings.respectWorkspaceMemory) {
    return true;
  }
  try {
    const repo = new MemorySettingsRepository(DatabaseManager.getInstance().getDatabase());
    const memorySettings = await repo.getOrCreate(workspaceId);
    return (
      memorySettings.enabled &&
      memorySettings.autoCapture &&
      memorySettings.privacyMode !== "disabled"
    );
  } catch (error) {
    // Fail closed: if the workspace memory settings cannot be read we cannot
    // tell whether memory is disabled, so do not persist screen content.
    logger.debug("Chronicle durability check failed; skipping promotion:", error);
    return false;
  }
}

async function listObservationFiles(workspacePath: string): Promise<string[]> {
  const observationsDir = resolveConfinedDir(workspacePath, OBSERVATIONS_DIR);
  if (!observationsDir) return [];
  try {
    const entries = await fs.readdir(observationsDir);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(observationsDir, entry));
  } catch {
    return [];
  }
}

function listObservationFilesSync(workspacePath: string): string[] {
  const observationsDir = resolveConfinedDir(workspacePath, OBSERVATIONS_DIR);
  if (!observationsDir) return [];
  try {
    return fsSync
      .readdirSync(observationsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(observationsDir, entry));
  } catch {
    return [];
  }
}

export class ChronicleObservationRepository {
  static isValidObservationId(value: unknown): value is string {
    return isValidChronicleObservationId(value);
  }

  static async promote(
    workspacePath: string,
    input: {
      workspaceId: string;
      taskId: string;
      query: string;
      observation: ChronicleResolvedContext;
      destinationHints?: string[];
      /** Access-profile write check; when it denies, nothing is persisted. */
      canWrite?: ChronicleWriteGuard;
    },
  ): Promise<ChroniclePersistedObservation | null> {
    if (
      !ID_PART_PATTERN.test(String(input.taskId || "")) ||
      !ID_PART_PATTERN.test(String(input.observation.observationId || ""))
    ) {
      logger.debug("Skipping Chronicle promotion: unexpected task/observation id shape");
      return null;
    }
    const id = `chronicle-${input.taskId}-${input.observation.observationId}`;
    const rawExt = path.extname(input.observation.imagePath).toLowerCase();
    const imageExt = ALLOWED_IMAGE_EXTENSIONS.has(rawExt) ? rawExt : ".png";
    const plannedJsonPath = path.join(workspacePath, OBSERVATIONS_DIR, `${id}.json`);
    const plannedImagePath = path.join(workspacePath, ASSETS_DIR, `${id}${imageExt}`);
    if (input.canWrite && !(input.canWrite(plannedJsonPath) && input.canWrite(plannedImagePath))) {
      logger.debug("Skipping Chronicle promotion: workspace write denied by access profile");
      return null;
    }
    if (!(await shouldPersistDurably(input.workspaceId))) {
      return null;
    }
    await ensureWorkspaceDirs(workspacePath);
    const observationsDir = resolveConfinedDir(workspacePath, OBSERVATIONS_DIR);
    const assetsDir = resolveConfinedDir(workspacePath, ASSETS_DIR);
    if (!observationsDir || !assetsDir) {
      logger.warn("Skipping Chronicle promotion: chronicle directories resolve outside workspace");
      return null;
    }
    const dirs = { observationsDir, assetsDir };
    const persistedImagePath = path.join(dirs.assetsDir, `${id}${imageExt}`);
    await fs.rm(persistedImagePath, { force: true });
    await fs.copyFile(
      input.observation.imagePath,
      persistedImagePath,
      fsSync.constants.COPYFILE_EXCL,
    );
    const existing = await readObservationFile(path.join(dirs.observationsDir, `${id}.json`));

    const record: ChroniclePersistedObservation = {
      id,
      promotedAt: existing?.promotedAt || Date.now(),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      query: input.query,
      destinationHints: [...new Set(input.destinationHints || [])].slice(0, 6),
      memoryId: existing?.memoryId,
      memoryGeneratedAt: existing?.memoryGeneratedAt,
      ...input.observation,
      imagePath: persistedImagePath,
    };

    await replaceFileNoFollow(
      path.join(dirs.observationsDir, `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  static async list(workspacePath: string, limit = 50): Promise<ChroniclePersistedObservation[]> {
    const files = await listObservationFiles(workspacePath);
    const records = await Promise.all(files.map((filePath) => readObservationFile(filePath)));
    return records
      .filter((record): record is ChroniclePersistedObservation => record !== null)
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, Math.max(1, limit));
  }

  static listSync(workspacePath: string, limit = 50): ChroniclePersistedObservation[] {
    return listObservationFilesSync(workspacePath)
      .map((filePath) => readObservationFileSync(filePath))
      .filter((record): record is ChroniclePersistedObservation => record !== null)
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, Math.max(1, limit));
  }

  static listByTaskSync(workspacePath: string, taskId: string): ChroniclePersistedObservation[] {
    return this.listSync(workspacePath, 200).filter((record) => record.taskId === taskId);
  }

  static async search(
    workspacePath: string,
    query: string,
    limit = 20,
  ): Promise<ChroniclePersistedObservation[]> {
    const records = await this.list(workspacePath, Math.max(limit * 4, 50));
    return records
      .sort(
        (a, b) =>
          scoreObservation(b, query) - scoreObservation(a, query) || b.capturedAt - a.capturedAt,
      )
      .slice(0, Math.max(1, limit));
  }

  static searchSync(
    workspacePath: string,
    query: string,
    limit = 20,
  ): ChroniclePersistedObservation[] {
    return this.listSync(workspacePath, Math.max(limit * 4, 50))
      .sort(
        (a, b) =>
          scoreObservation(b, query) - scoreObservation(a, query) || b.capturedAt - a.capturedAt,
      )
      .slice(0, Math.max(1, limit));
  }

  static async attachMemoryLink(
    workspacePath: string,
    observationId: string,
    memoryId: string,
    memoryGeneratedAt = Date.now(),
  ): Promise<boolean> {
    if (!isValidChronicleObservationId(observationId)) return false;
    const observationsDir = resolveConfinedDir(workspacePath, OBSERVATIONS_DIR);
    if (!observationsDir) return false;
    const filePath = path.join(observationsDir, `${observationId}.json`);
    const record = await readObservationFile(filePath);
    if (!record) return false;
    const updated: ChroniclePersistedObservation = {
      ...record,
      memoryId,
      memoryGeneratedAt,
    };
    await replaceFileNoFollow(filePath, `${JSON.stringify(updated, null, 2)}\n`);
    return true;
  }

  static async deleteObservation(workspacePath: string, observationId: string): Promise<boolean> {
    if (!isValidChronicleObservationId(observationId)) return false;
    const observationsDir = resolveConfinedDir(workspacePath, OBSERVATIONS_DIR);
    if (!observationsDir) return false;
    const filePath = path.join(observationsDir, `${observationId}.json`);
    const record = await readObservationFile(filePath);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    if (record && isConfinedChronicleAssetPath(workspacePath, record.imagePath, record.id)) {
      await fs.rm(record.imagePath, { force: true }).catch(() => undefined);
    } else if (record?.imagePath) {
      logger.warn(`Refusing to delete Chronicle image outside the assets dir for ${record.id}`);
    }
    return Boolean(record);
  }

  /**
   * Remove every persisted observation and asset in the workspace. File names
   * come from `readdir` of the confined Chronicle directories, never from
   * `imagePath` inside the JSON, so a planted record cannot redirect deletion.
   */
  static async clearWorkspace(workspacePath: string): Promise<void> {
    const targets: string[] = [];
    for (const relativeDir of [OBSERVATIONS_DIR, ASSETS_DIR]) {
      const dir = resolveConfinedDir(workspacePath, relativeDir);
      if (!dir) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const stem = entry.name.slice(0, entry.name.length - ext.length);
        if (!isValidChronicleObservationId(stem)) continue;
        if (
          relativeDir === OBSERVATIONS_DIR ? ext !== ".json" : !ALLOWED_IMAGE_EXTENSIONS.has(ext)
        ) {
          continue;
        }
        targets.push(path.join(dir, entry.name));
      }
    }
    await Promise.all(targets.map((target) => fs.rm(target, { force: true }))).catch(
      () => undefined,
    );
  }
}
