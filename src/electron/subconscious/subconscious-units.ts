import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { SubconsciousStore } from "./subconscious-sql";
import {
  SubconsciousBacklogStore,
  SubconsciousCritiqueStore,
  SubconsciousDecisionStore,
  SubconsciousDispatchStore,
  SubconsciousHypothesisStore,
  SubconsciousRunStore,
  SubconsciousTargetStore,
} from "./SubconsciousRepositories";

/**
 * Subconscious transaction units (async SQLite migration plan, DB6): one per public method of
 * the synchronous stores, in the services domain. Generated from the classes; a method is
 * a write when it, or a method it calls, writes or opens a transaction.
 */
export const SUBCONSCIOUS_UNITS = {
  subconsciousTarget_upsert: storeUnit(
    (db: Database.Database) => new SubconsciousTargetStore(db),
    "upsert",
    {
      readonly: false,
    },
  ),
  subconsciousTarget_update: storeUnit(
    (db: Database.Database) => new SubconsciousTargetStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  subconsciousTarget_findByKey: storeUnit(
    (db: Database.Database) => new SubconsciousTargetStore(db),
    "findByKey",
    {
      readonly: true,
    },
  ),
  subconsciousTarget_list: storeUnit(
    (db: Database.Database) => new SubconsciousTargetStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  subconsciousRun_create: storeUnit(
    (db: Database.Database) => new SubconsciousRunStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  subconsciousRun_update: storeUnit(
    (db: Database.Database) => new SubconsciousRunStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  subconsciousRun_findById: storeUnit(
    (db: Database.Database) => new SubconsciousRunStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  subconsciousRun_findLatestByFingerprint: storeUnit(
    (db: Database.Database) => new SubconsciousRunStore(db),
    "findLatestByFingerprint",
    {
      readonly: true,
    },
  ),
  subconsciousRun_list: storeUnit((db: Database.Database) => new SubconsciousRunStore(db), "list", {
    readonly: true,
  }),
  subconsciousHypothesis_replaceForRun: storeUnit(
    (db: Database.Database) => new SubconsciousHypothesisStore(db),
    "replaceForRun",
    {
      readonly: false,
    },
  ),
  subconsciousHypothesis_listByRun: storeUnit(
    (db: Database.Database) => new SubconsciousHypothesisStore(db),
    "listByRun",
    {
      readonly: true,
    },
  ),
  subconsciousCritique_replaceForRun: storeUnit(
    (db: Database.Database) => new SubconsciousCritiqueStore(db),
    "replaceForRun",
    {
      readonly: false,
    },
  ),
  subconsciousCritique_listByRun: storeUnit(
    (db: Database.Database) => new SubconsciousCritiqueStore(db),
    "listByRun",
    {
      readonly: true,
    },
  ),
  subconsciousDecision_upsert: storeUnit(
    (db: Database.Database) => new SubconsciousDecisionStore(db),
    "upsert",
    {
      readonly: false,
    },
  ),
  subconsciousDecision_findByRun: storeUnit(
    (db: Database.Database) => new SubconsciousDecisionStore(db),
    "findByRun",
    {
      readonly: true,
    },
  ),
  subconsciousDecision_findLatestByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousDecisionStore(db),
    "findLatestByTarget",
    {
      readonly: true,
    },
  ),
  subconsciousBacklog_create: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  subconsciousBacklog_createOrRefreshOpen: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "createOrRefreshOpen",
    {
      readonly: false,
    },
  ),
  subconsciousBacklog_listByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "listByTarget",
    {
      readonly: true,
    },
  ),
  subconsciousBacklog_countOpenByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "countOpenByTarget",
    {
      readonly: true,
    },
  ),
  subconsciousBacklog_deleteLegacyNoiseByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "deleteLegacyNoiseByTarget",
    {
      readonly: false,
    },
  ),
  subconsciousBacklog_dedupeOpenByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "dedupeOpenByTarget",
    {
      readonly: false,
    },
  ),
  subconsciousBacklog_update: storeUnit(
    (db: Database.Database) => new SubconsciousBacklogStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  subconsciousDispatch_create: storeUnit(
    (db: Database.Database) => new SubconsciousDispatchStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  subconsciousDispatch_listByTarget: storeUnit(
    (db: Database.Database) => new SubconsciousDispatchStore(db),
    "listByTarget",
    {
      readonly: true,
    },
  ),
  // The loop's own SQL; the evidence read is a reporting unit.
  subconscious_evidenceRows: storeUnit(
    (db: Database.Database) => new SubconsciousStore(db),
    "evidenceRows",
    {
      readonly: true,
      report: true,
    },
  ),
  subconscious_rekeyTarget: storeUnit(
    (db: Database.Database) => new SubconsciousStore(db),
    "rekeyTarget",
    {
      readonly: false,
    },
  ),
  subconscious_clearTargetData: storeUnit(
    (db: Database.Database) => new SubconsciousStore(db),
    "clearTargetData",
    {
      readonly: false,
    },
  ),
  subconscious_clearHistoryData: storeUnit(
    (db: Database.Database) => new SubconsciousStore(db),
    "clearHistoryData",
    {
      readonly: false,
    },
  ),
  subconscious_normalizeLegacyOutcomeVocabulary: storeUnit(
    (db: Database.Database) => new SubconsciousStore(db),
    "normalizeLegacyOutcomeVocabulary",
    {
      readonly: false,
    },
  ),
} satisfies UnitCatalog;
