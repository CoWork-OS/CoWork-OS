/**
 * Default wiring of the memory curator for the desktop app: the Memory Hub Review service
 * (IPC and browser host) and the Dreaming service used by every trigger; also the Hub's
 * Sources and Health service.
 */
import type Database from "better-sqlite3";
import { ChronicleSettingsManager } from "../chronicle/ChronicleSettingsManager";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { DreamingRepository } from "./DreamingRepository";
import { DreamingService, type DreamingServiceDeps } from "./DreamingService";
import { MemoryCurationRepository } from "./MemoryCurationRepository";
import { MemoryHealthService } from "./MemoryHealthService";
import { MemoryReviewService } from "./MemoryReviewService";
import { MemoryWriter } from "./MemoryWriter";
import { SupermemoryService } from "./SupermemoryService";
import { createMemoryStatementPort } from "./memory-statement-port";

/** Dreaming over the profile database, reading the curator settings from Memory features. */
export function createDreamingService(
  db: Database.Database,
  deps: DreamingServiceDeps = {},
): DreamingService {
  return new DreamingService(new DreamingRepository(db), {
    getSettings: () => MemoryFeaturesManager.loadSettings(),
    ...deps,
  });
}

export function createMemoryReviewService(
  db: Database.Database,
  options: {
    /** The workspace's id and path, or null when it does not exist. */
    resolveWorkspace: (workspaceId: string) => Promise<{ id: string; path: string } | null>;
    syncKitFiles?: (workspaceId: string) => Promise<void>;
  },
): MemoryReviewService {
  const dreaming = new DreamingRepository(db);
  return new MemoryReviewService({
    dreaming,
    curation: new MemoryCurationRepository(dreaming.statementPort),
    getWriter: () => MemoryWriter.get(),
    getSettings: () => MemoryFeaturesManager.loadSettings(),
    setLlmEnabled: (enabled) => {
      // Merged into the stored settings here, so a stale renderer copy never overwrites them.
      MemoryFeaturesManager.saveSettings({
        ...MemoryFeaturesManager.loadSettings(),
        dreamingLlmEnabled: enabled,
      });
    },
    runNow: async (workspaceId) => {
      const workspace = await options.resolveWorkspace(workspaceId);
      if (!workspace) return null;
      return createDreamingService(db).run({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        triggerSource: "manual",
      });
    },
    syncKitFiles: options.syncKitFiles,
  });
}

/** Memory Hub "Sources" and "Health": aggregate counts over the profile database. */
export function createMemoryHealthService(db: Database.Database): MemoryHealthService {
  return new MemoryHealthService({
    port: createMemoryStatementPort(db),
    getSettings: () => MemoryFeaturesManager.loadSettings(),
    getSupermemoryStatus: () => {
      const status = SupermemoryService.getConfigStatus();
      return { enabled: status.enabled, connected: status.isConfigured };
    },
    getChronicleEnabled: () => ChronicleSettingsManager.loadSettings().enabled === true,
  });
}
