import { DatabaseManager } from "../database/schema";
import { MemoryService } from "../memory/MemoryService";
import type { Memory } from "../database/repositories";
import { createLogger } from "../utils/logger";
import { chronicleObservationToMemoryContent } from "./ChronicleProvenance";
import { ChronicleObservationRepository } from "./ChronicleObservationRepository";
import { ChronicleSettingsManager } from "./ChronicleSettingsManager";
import type { ChroniclePersistedObservation, ChronicleSettings } from "./types";

const logger = createLogger("ChronicleMemoryService");
/** Chronicle memories are always local-only (see docs/chronicle.md). */
export const CHRONICLE_MEMORIES_PRIVATE = true;

export class ChronicleMemoryService {
  private static instance: ChronicleMemoryService | null = null;
  private settings = ChronicleSettingsManager.loadSettings();
  private lastGeneratedAt: number | null = null;
  private generationCache = new Map<string, number>();

  static getInstance(): ChronicleMemoryService {
    if (!this.instance) {
      this.instance = new ChronicleMemoryService();
    }
    return this.instance;
  }

  applySettings(next: ChronicleSettings): void {
    this.settings = { ...next };
  }

  getLastGeneratedAt(): number | null {
    return this.lastGeneratedAt;
  }

  async notePromotedObservation(
    workspacePath: string,
    observation: ChroniclePersistedObservation,
  ): Promise<Memory | null> {
    if (observation.memoryId) {
      return null;
    }
    if (!this.shouldGenerate(observation.id)) {
      return null;
    }
    if (!this.settings.backgroundGenerationEnabled) {
      return null;
    }
    try {
      DatabaseManager.getInstance();
    } catch {
      return null;
    }

    const memoryContent = chronicleObservationToMemoryContent(observation);
    // Screen-derived text stays local: capture as private so it is never
    // mirrored to external memory providers (Supermemory).
    const memory = await MemoryService.capture(
      observation.workspaceId,
      observation.taskId,
      "screen_context",
      memoryContent,
      CHRONICLE_MEMORIES_PRIVATE,
      {
        origin: "chronicle",
        signalFamily: "chronicle",
        priority: "normal",
      },
    );
    if (!memory) {
      return null;
    }
    this.lastGeneratedAt = Date.now();
    this.generationCache.set(observation.id, this.lastGeneratedAt);
    await ChronicleObservationRepository.attachMemoryLink(
      workspacePath,
      observation.id,
      memory.id,
      this.lastGeneratedAt,
    ).catch((error) => {
      logger.debug("Failed to attach Chronicle memory link:", error);
    });
    return memory;
  }

  private shouldGenerate(observationId: string): boolean {
    if (!this.settings.enabled || this.settings.paused || !this.settings.consentAcceptedAt) {
      return false;
    }
    return !this.generationCache.has(observationId);
  }
}
