import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { MissionControlIntelligenceStore } from "./MissionControlIntelligenceService";

const MISSIONCONTROLINTELLIGENCESERVICE_METHODS = [
  "refresh",
  "listItems",
  "getEvidence",
  "getBrief",
  "recordHeartbeatEvent",
] as const;

/**
 * Async facade for Mission Control (async SQLite migration plan, DB6). new
 * MissionControlIntelligenceService(db) keeps its signature; every method runs one
 * services-domain unit over MissionControlIntelligenceStore.
 */
export type MissionControlIntelligenceService = AsyncStore<
  MissionControlIntelligenceStore,
  (typeof MISSIONCONTROLINTELLIGENCESERVICE_METHODS)[number]
>;
export const MissionControlIntelligenceService = serviceRepositoryFacade<
  MissionControlIntelligenceStore,
  (typeof MISSIONCONTROLINTELLIGENCESERVICE_METHODS)[number]
>("missionControl_", MISSIONCONTROLINTELLIGENCESERVICE_METHODS);
