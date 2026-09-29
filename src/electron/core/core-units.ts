import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { CoreEvalCaseStore } from "./CoreEvalCaseRepository";
import { CoreFailureClusterStore } from "./CoreFailureClusterRepository";
import { CoreHarnessExperimentStore } from "./CoreHarnessExperimentRepository";
import { CoreLearningsStore } from "./CoreLearningsRepository";
import { CoreMemoryDistillRunStore } from "./CoreMemoryDistillRunRepository";
import { CoreRegressionGateStore } from "./CoreRegressionGateRepository";
import { CoreFailureRecordStore } from "./CoreFailureRecordRepository";
import { CoreMemoryCandidateStore } from "./CoreMemoryCandidateRepository";
import { CoreTraceStore } from "./CoreTraceRepository";
import { CoreMemoryScopeStateStore } from "./CoreMemoryScopeStateRepository";

/**
 * Core learning transaction units (async SQLite migration plan, DB6): one per public method of
 * the synchronous stores, in the services domain. Generated from the classes; a method is
 * a write when it, or a method it calls, writes or opens a transaction.
 */
export const CORE_UNITS = {
  coreEvalCase_create: storeUnit((db: Database.Database) => new CoreEvalCaseStore(db), "create", {
    readonly: false,
  }),
  coreEvalCase_findById: storeUnit(
    (db: Database.Database) => new CoreEvalCaseStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreEvalCase_findByClusterId: storeUnit(
    (db: Database.Database) => new CoreEvalCaseStore(db),
    "findByClusterId",
    {
      readonly: true,
    },
  ),
  coreEvalCase_list: storeUnit((db: Database.Database) => new CoreEvalCaseStore(db), "list", {
    readonly: true,
  }),
  coreEvalCase_update: storeUnit((db: Database.Database) => new CoreEvalCaseStore(db), "update", {
    readonly: false,
  }),
  coreEvalCase_recordRun: storeUnit(
    (db: Database.Database) => new CoreEvalCaseStore(db),
    "recordRun",
    {
      readonly: false,
    },
  ),
  coreFailureCluster_create: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  coreFailureCluster_findById: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreFailureCluster_findByFingerprint: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "findByFingerprint",
    {
      readonly: true,
    },
  ),
  coreFailureCluster_list: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  coreFailureCluster_update: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  coreFailureCluster_addMember: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "addMember",
    {
      readonly: false,
    },
  ),
  coreFailureCluster_listMemberIds: storeUnit(
    (db: Database.Database) => new CoreFailureClusterStore(db),
    "listMemberIds",
    {
      readonly: true,
    },
  ),
  coreHarnessExperiment_createExperiment: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "createExperiment",
    {
      readonly: false,
    },
  ),
  coreHarnessExperiment_findExperimentById: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "findExperimentById",
    {
      readonly: true,
    },
  ),
  coreHarnessExperiment_listExperiments: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "listExperiments",
    {
      readonly: true,
    },
  ),
  coreHarnessExperiment_updateExperiment: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "updateExperiment",
    {
      readonly: false,
    },
  ),
  coreHarnessExperiment_createRun: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "createRun",
    {
      readonly: false,
    },
  ),
  coreHarnessExperiment_updateRun: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "updateRun",
    {
      readonly: false,
    },
  ),
  coreHarnessExperiment_findRunById: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "findRunById",
    {
      readonly: true,
    },
  ),
  coreHarnessExperiment_listRunsForExperiment: storeUnit(
    (db: Database.Database) => new CoreHarnessExperimentStore(db),
    "listRunsForExperiment",
    {
      readonly: true,
    },
  ),
  coreLearnings_append: storeUnit((db: Database.Database) => new CoreLearningsStore(db), "append", {
    readonly: false,
  }),
  coreLearnings_list: storeUnit((db: Database.Database) => new CoreLearningsStore(db), "list", {
    readonly: true,
  }),
  coreMemoryDistillRun_create: storeUnit(
    (db: Database.Database) => new CoreMemoryDistillRunStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  coreMemoryDistillRun_update: storeUnit(
    (db: Database.Database) => new CoreMemoryDistillRunStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  coreMemoryDistillRun_findById: storeUnit(
    (db: Database.Database) => new CoreMemoryDistillRunStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreMemoryDistillRun_list: storeUnit(
    (db: Database.Database) => new CoreMemoryDistillRunStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  coreRegressionGate_create: storeUnit(
    (db: Database.Database) => new CoreRegressionGateStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  coreRegressionGate_findById: storeUnit(
    (db: Database.Database) => new CoreRegressionGateStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreRegressionGate_findByExperimentRunId: storeUnit(
    (db: Database.Database) => new CoreRegressionGateStore(db),
    "findByExperimentRunId",
    {
      readonly: true,
    },
  ),
  coreFailureRecord_create: storeUnit(
    (db: Database.Database) => new CoreFailureRecordStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  coreFailureRecord_findById: storeUnit(
    (db: Database.Database) => new CoreFailureRecordStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreFailureRecord_findByTraceId: storeUnit(
    (db: Database.Database) => new CoreFailureRecordStore(db),
    "findByTraceId",
    {
      readonly: true,
    },
  ),
  coreFailureRecord_list: storeUnit(
    (db: Database.Database) => new CoreFailureRecordStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  coreFailureRecord_update: storeUnit(
    (db: Database.Database) => new CoreFailureRecordStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  coreMemoryCandidate_create: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  coreMemoryCandidate_bulkCreate: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "bulkCreate",
    {
      readonly: false,
    },
  ),
  coreMemoryCandidate_findById: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  coreMemoryCandidate_list: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  coreMemoryCandidate_listForTrace: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "listForTrace",
    {
      readonly: true,
    },
  ),
  coreMemoryCandidate_review: storeUnit(
    (db: Database.Database) => new CoreMemoryCandidateStore(db),
    "review",
    {
      readonly: false,
    },
  ),
  coreTrace_create: storeUnit((db: Database.Database) => new CoreTraceStore(db), "create", {
    readonly: false,
  }),
  coreTrace_update: storeUnit((db: Database.Database) => new CoreTraceStore(db), "update", {
    readonly: false,
  }),
  coreTrace_findById: storeUnit((db: Database.Database) => new CoreTraceStore(db), "findById", {
    readonly: true,
  }),
  coreTrace_list: storeUnit((db: Database.Database) => new CoreTraceStore(db), "list", {
    readonly: true,
  }),
  coreTrace_listByProfile: storeUnit(
    (db: Database.Database) => new CoreTraceStore(db),
    "listByProfile",
    {
      readonly: true,
    },
  ),
  coreTrace_findOpenTrace: storeUnit(
    (db: Database.Database) => new CoreTraceStore(db),
    "findOpenTrace",
    {
      readonly: true,
    },
  ),
  coreTrace_appendEvent: storeUnit(
    (db: Database.Database) => new CoreTraceStore(db),
    "appendEvent",
    {
      readonly: false,
    },
  ),
  coreTrace_listEvents: storeUnit((db: Database.Database) => new CoreTraceStore(db), "listEvents", {
    readonly: true,
  }),
  coreMemoryScopeState_get: storeUnit(
    (db: Database.Database) => new CoreMemoryScopeStateStore(db),
    "get",
    {
      readonly: true,
    },
  ),
  coreMemoryScopeState_upsert: storeUnit(
    (db: Database.Database) => new CoreMemoryScopeStateStore(db),
    "upsert",
    {
      readonly: false,
    },
  ),
  coreMemoryScopeState_touchTrace: storeUnit(
    (db: Database.Database) => new CoreMemoryScopeStateStore(db),
    "touchTrace",
    {
      readonly: false,
    },
  ),
  coreMemoryScopeState_touchDistill: storeUnit(
    (db: Database.Database) => new CoreMemoryScopeStateStore(db),
    "touchDistill",
    {
      readonly: false,
    },
  ),
  coreMemoryScopeState_touchPrune: storeUnit(
    (db: Database.Database) => new CoreMemoryScopeStateStore(db),
    "touchPrune",
    {
      readonly: false,
    },
  ),
} satisfies UnitCatalog;
