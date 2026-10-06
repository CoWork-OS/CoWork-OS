/**
 * Default wiring of the memory services for the desktop app: the Memory Hub Review service
 * (IPC and browser host), commitment expiry (Heartbeat), and the Hub's Sources and Health
 * service.
 */
import type Database from "better-sqlite3";
import { ChronicleSettingsManager } from "../chronicle/ChronicleSettingsManager";
import {
  CommitmentExpiryService,
  type CommitmentExpiryDeps,
} from "./CommitmentExpiryService";
import { MemoryCurationRepository } from "./MemoryCurationRepository";
import { MemoryHealthService } from "./MemoryHealthService";
import { MemoryReviewService } from "./MemoryReviewService";
import { MemoryWriter } from "./MemoryWriter";
import { SupermemoryService } from "./SupermemoryService";
import { createMemoryStatementPort } from "./memory-statement-port";
import { MemoryRepoService } from "./repo/MemoryRepoService";
import { memoryRepoStatus } from "./repo/memory-repo-bootstrap";
import {
  buildMemoryRepoDreamsReport,
  loadMemoryRepoDreamSettings,
} from "./repo/memory-repo-dream-report";

/** Commitment expiry over the profile database. */
export function createCommitmentExpiryService(
  db: Database.Database,
  deps: Omit<CommitmentExpiryDeps, "curation"> = {},
): CommitmentExpiryService {
  return new CommitmentExpiryService({
    curation: new MemoryCurationRepository(createMemoryStatementPort(db)),
    ...deps,
  });
}

export function createMemoryReviewService(db: Database.Database): MemoryReviewService {
  return new MemoryReviewService({
    curation: new MemoryCurationRepository(createMemoryStatementPort(db)),
    getWriter: () => MemoryWriter.get(),
  });
}

/** Memory Hub "Sources" and "Health": aggregate counts over the profile database. */
export function createMemoryHealthService(db: Database.Database): MemoryHealthService {
  return new MemoryHealthService({
    port: createMemoryStatementPort(db),
    getSupermemoryStatus: () => {
      const status = SupermemoryService.getConfigStatus();
      return { enabled: status.enabled, connected: status.isConfigured };
    },
    getChronicleEnabled: () => ChronicleSettingsManager.loadSettings().enabled === true,
    getMemoryRepoStatus: () => memoryRepoStatus(),
    getMemoryRepoDreams: () =>
      buildMemoryRepoDreamsReport({
        service: MemoryRepoService.get(),
        settings: loadMemoryRepoDreamSettings(),
      }),
  });
}
