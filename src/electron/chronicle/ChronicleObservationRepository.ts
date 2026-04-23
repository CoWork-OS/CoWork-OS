import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { DatabaseManager } from "../database/schema";
import { MemorySettingsRepository } from "../database/repositories";
import { ChronicleSettingsManager } from "./ChronicleSettingsManager";
import type { ChroniclePersistedObservation, ChronicleResolvedContext } from "./types";

const logger = createLogger("ChronicleObservationRepository");
const CHRONICLE_DIR = path.join(".cowork", "chronicle");
const OBSERVATIONS_DIR = path.join(CHRONICLE_DIR, "observations");
const ASSETS_DIR = path.join(CHRONICLE_DIR, "assets");

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

async function readObservationFile(filePath: string): Promise<ChroniclePersistedObservation | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as ChroniclePersistedObservation;
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
    return JSON.parse(raw) as ChroniclePersistedObservation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    logger.warn(`Failed to read Chronicle observation ${path.basename(filePath)}:`, error);
    return null;
  }
}

function shouldPersistDurably(workspaceId: string): boolean {
  const chronicleSettings = ChronicleSettingsManager.loadSettings();
  if (!chronicleSettings.respectWorkspaceMemory) {
    return true;
  }
  try {
    const repo = new MemorySettingsRepository(DatabaseManager.getInstance().getDatabase());
    const memorySettings = repo.getOrCreate(workspaceId);
    return (
      memorySettings.enabled &&
      memorySettings.autoCapture &&
      memorySettings.privacyMode !== "disabled"
    );
  } catch {
    return true;
  }
}

async function listObservationFiles(workspacePath: string): Promise<string[]> {
  const observationsDir = path.join(workspacePath, OBSERVATIONS_DIR);
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
  const observationsDir = path.join(workspacePath, OBSERVATIONS_DIR);
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
  static async promote(
    workspacePath: string,
    input: {
      workspaceId: string;
      taskId: string;
      query: string;
      observation: ChronicleResolvedContext;
      destinationHints?: string[];
    },
  ): Promise<ChroniclePersistedObservation | null> {
    if (!shouldPersistDurably(input.workspaceId)) {
      return null;
    }
    const dirs = await ensureWorkspaceDirs(workspacePath);
    const id = `chronicle-${input.taskId}-${input.observation.observationId}`;
    const imageExt = path.extname(input.observation.imagePath) || ".png";
    const persistedImagePath = path.join(dirs.assetsDir, `${id}${imageExt}`);
    await fs.copyFile(input.observation.imagePath, persistedImagePath);
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

    await fs.writeFile(
      path.join(dirs.observationsDir, `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
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
    const filePath = path.join(workspacePath, OBSERVATIONS_DIR, `${observationId}.json`);
    const record = await readObservationFile(filePath);
    if (!record) return false;
    const updated: ChroniclePersistedObservation = {
      ...record,
      memoryId,
      memoryGeneratedAt,
    };
    await fs.writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    return true;
  }

  static async deleteObservation(workspacePath: string, observationId: string): Promise<boolean> {
    const filePath = path.join(workspacePath, OBSERVATIONS_DIR, `${observationId}.json`);
    const record = await readObservationFile(filePath);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    if (record?.imagePath) {
      await fs.rm(record.imagePath, { force: true }).catch(() => undefined);
    }
    return Boolean(record);
  }

  static async clearWorkspace(workspacePath: string): Promise<void> {
    const records = await this.list(workspacePath, 10_000);
    await Promise.all(
      records.map((record) =>
        Promise.all([
          fs.rm(path.join(workspacePath, OBSERVATIONS_DIR, `${record.id}.json`), { force: true }),
          fs.rm(record.imagePath, { force: true }),
        ]),
      ),
    ).catch(() => undefined);
  }
}
