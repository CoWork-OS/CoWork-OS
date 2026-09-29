import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import {
  ImprovementCandidateStore,
  ImprovementRunStore,
  ImprovementCampaignStore,
  ImprovementVariantRunStore,
  ImprovementJudgeVerdictStore,
  ImprovementHistoryStore,
} from "./ImprovementRepositories";

const improvementCandidate = (db: Database.Database) => new ImprovementCandidateStore(db);
const improvementRun = (db: Database.Database) => new ImprovementRunStore(db);
const improvementCampaign = (db: Database.Database) => new ImprovementCampaignStore(db);
const improvementVariantRun = (db: Database.Database) => new ImprovementVariantRunStore(db);
const improvementJudgeVerdict = (db: Database.Database) => new ImprovementJudgeVerdictStore(db);
const improvementHistory = (db: Database.Database) => new ImprovementHistoryStore(db);

/** Improvement loop transaction units (async SQLite migration plan, DB6), in the services domain. */
export const IMPROVEMENT_UNITS = {
  improvementCandidate_create: storeUnit(improvementCandidate, "create", { readonly: false }),
  improvementCandidate_update: storeUnit(improvementCandidate, "update", { readonly: false }),
  improvementCandidate_findById: storeUnit(improvementCandidate, "findById", { readonly: true }),
  improvementCandidate_findByFingerprint: storeUnit(improvementCandidate, "findByFingerprint", {
    readonly: true,
  }),
  improvementCandidate_delete: storeUnit(improvementCandidate, "delete", { readonly: false }),
  improvementCandidate_list: storeUnit(improvementCandidate, "list", { readonly: true }),
  improvementCandidate_getTopRunnableCandidate: storeUnit(
    improvementCandidate,
    "getTopRunnableCandidate",
    { readonly: true },
  ),
  improvementRun_create: storeUnit(improvementRun, "create", { readonly: false }),
  improvementRun_update: storeUnit(improvementRun, "update", { readonly: false }),
  improvementRun_findById: storeUnit(improvementRun, "findById", { readonly: true }),
  improvementRun_findByTaskId: storeUnit(improvementRun, "findByTaskId", { readonly: true }),
  improvementRun_reassignCandidate: storeUnit(improvementRun, "reassignCandidate", {
    readonly: false,
  }),
  improvementRun_list: storeUnit(improvementRun, "list", { readonly: true }),
  improvementRun_countActive: storeUnit(improvementRun, "countActive", { readonly: true }),
  improvementCampaign_create: storeUnit(improvementCampaign, "create", { readonly: false }),
  improvementCampaign_update: storeUnit(improvementCampaign, "update", { readonly: false }),
  improvementCampaign_findById: storeUnit(improvementCampaign, "findById", { readonly: true }),
  improvementCampaign_findByWinnerVariantId: storeUnit(
    improvementCampaign,
    "findByWinnerVariantId",
    { readonly: true },
  ),
  improvementCampaign_findByTaskId: storeUnit(improvementCampaign, "findByTaskId", {
    readonly: true,
  }),
  improvementCampaign_list: storeUnit(improvementCampaign, "list", { readonly: true }),
  improvementCampaign_countActive: storeUnit(improvementCampaign, "countActive", {
    readonly: true,
  }),
  improvementVariantRun_create: storeUnit(improvementVariantRun, "create", { readonly: false }),
  improvementVariantRun_update: storeUnit(improvementVariantRun, "update", { readonly: false }),
  improvementVariantRun_findById: storeUnit(improvementVariantRun, "findById", { readonly: true }),
  improvementVariantRun_findByTaskId: storeUnit(improvementVariantRun, "findByTaskId", {
    readonly: true,
  }),
  improvementVariantRun_list: storeUnit(improvementVariantRun, "list", { readonly: true }),
  improvementVariantRun_listByCampaignId: storeUnit(improvementVariantRun, "listByCampaignId", {
    readonly: true,
  }),
  improvementJudgeVerdict_upsert: storeUnit(improvementJudgeVerdict, "upsert", { readonly: false }),
  improvementJudgeVerdict_findByCampaignId: storeUnit(improvementJudgeVerdict, "findByCampaignId", {
    readonly: true,
  }),
  improvementHistory_clearHistory: storeUnit(improvementHistory, "clearHistory", {
    readonly: false,
  }),
  improvementHistory_mergeCandidates: storeUnit(improvementHistory, "mergeCandidates", {
    readonly: false,
  }),
  improvementHistory_recentSignalRows: storeUnit(improvementHistory, "recentSignalRows", {
    readonly: true,
  }),
} satisfies UnitCatalog;
