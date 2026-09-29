import type Database from "better-sqlite3";
import { serviceRepositoryFacade, serviceStatements } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type {
  ImprovementCandidateStore,
  ImprovementRunStore,
  ImprovementCampaignStore,
  ImprovementVariantRunStore,
  ImprovementJudgeVerdictStore,
  ImprovementHistoryStore,
} from "./ImprovementRepositories";

const IMPROVEMENTCANDIDATE_METHODS = [
  "create",
  "update",
  "findById",
  "findByFingerprint",
  "delete",
  "list",
  "getTopRunnableCandidate",
] as const;

/** Async facade over `ImprovementCandidateStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type ImprovementCandidateRepository = AsyncStore<
  ImprovementCandidateStore,
  (typeof IMPROVEMENTCANDIDATE_METHODS)[number]
>;
export const ImprovementCandidateRepository = serviceRepositoryFacade<
  ImprovementCandidateStore,
  (typeof IMPROVEMENTCANDIDATE_METHODS)[number]
>("improvementCandidate_", IMPROVEMENTCANDIDATE_METHODS);

const IMPROVEMENTRUN_METHODS = [
  "create",
  "update",
  "findById",
  "findByTaskId",
  "reassignCandidate",
  "list",
  "countActive",
] as const;

/** Async facade over `ImprovementRunStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type ImprovementRunRepository = AsyncStore<
  ImprovementRunStore,
  (typeof IMPROVEMENTRUN_METHODS)[number]
>;
export const ImprovementRunRepository = serviceRepositoryFacade<
  ImprovementRunStore,
  (typeof IMPROVEMENTRUN_METHODS)[number]
>("improvementRun_", IMPROVEMENTRUN_METHODS);

const IMPROVEMENTCAMPAIGN_METHODS = [
  "create",
  "update",
  "findById",
  "findByWinnerVariantId",
  "findByTaskId",
  "list",
  "countActive",
] as const;

/** Async facade over `ImprovementCampaignStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type ImprovementCampaignRepository = AsyncStore<
  ImprovementCampaignStore,
  (typeof IMPROVEMENTCAMPAIGN_METHODS)[number]
>;
export const ImprovementCampaignRepository = serviceRepositoryFacade<
  ImprovementCampaignStore,
  (typeof IMPROVEMENTCAMPAIGN_METHODS)[number]
>("improvementCampaign_", IMPROVEMENTCAMPAIGN_METHODS);

const IMPROVEMENTVARIANTRUN_METHODS = [
  "create",
  "update",
  "findById",
  "findByTaskId",
  "list",
  "listByCampaignId",
] as const;

/** Async facade over `ImprovementVariantRunStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type ImprovementVariantRunRepository = AsyncStore<
  ImprovementVariantRunStore,
  (typeof IMPROVEMENTVARIANTRUN_METHODS)[number]
>;
export const ImprovementVariantRunRepository = serviceRepositoryFacade<
  ImprovementVariantRunStore,
  (typeof IMPROVEMENTVARIANTRUN_METHODS)[number]
>("improvementVariantRun_", IMPROVEMENTVARIANTRUN_METHODS);

const IMPROVEMENTJUDGEVERDICT_METHODS = ["upsert", "findByCampaignId"] as const;

/** Async facade over `ImprovementJudgeVerdictStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type ImprovementJudgeVerdictRepository = AsyncStore<
  ImprovementJudgeVerdictStore,
  (typeof IMPROVEMENTJUDGEVERDICT_METHODS)[number]
>;
export const ImprovementJudgeVerdictRepository = serviceRepositoryFacade<
  ImprovementJudgeVerdictStore,
  (typeof IMPROVEMENTJUDGEVERDICT_METHODS)[number]
>("improvementJudgeVerdict_", IMPROVEMENTJUDGEVERDICT_METHODS);

/** Count and delete every improvement row in one unit (DB6). */
export function clearImprovementHistoryData(
  db: Database.Database,
): Promise<ReturnType<ImprovementHistoryStore["clearHistory"]>> {
  return serviceStatements(db).unit("improvementHistory_clearHistory", []);
}

/** Recent task ids and failure/feedback events candidates are rebuilt from, in one unit (DB6). */
export function improvementRecentSignalRows(
  db: Database.Database,
  since: number,
): Promise<ReturnType<ImprovementHistoryStore["recentSignalRows"]>> {
  return serviceStatements(db).unit("improvementHistory_recentSignalRows", [since]);
}

/** Merge a duplicate candidate into a survivor in one unit (DB6). */
export function mergeImprovementCandidates(
  db: Database.Database,
  duplicateId: string,
  survivorId: string,
  updates: Parameters<ImprovementHistoryStore["mergeCandidates"]>[2],
): Promise<void> {
  return serviceStatements(db).unit("improvementHistory_mergeCandidates", [
    duplicateId,
    survivorId,
    updates,
  ]);
}
