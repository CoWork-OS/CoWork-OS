import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { CoreEvalCaseStore } from "./CoreEvalCaseRepository";
import type { CoreFailureClusterStore } from "./CoreFailureClusterRepository";
import type { CoreHarnessExperimentStore } from "./CoreHarnessExperimentRepository";
import type { CoreLearningsStore } from "./CoreLearningsRepository";
import type { CoreMemoryDistillRunStore } from "./CoreMemoryDistillRunRepository";
import type { CoreRegressionGateStore } from "./CoreRegressionGateRepository";
import type { CoreFailureRecordStore } from "./CoreFailureRecordRepository";
import type { CoreMemoryCandidateStore } from "./CoreMemoryCandidateRepository";
import type { CoreTraceStore } from "./CoreTraceRepository";
import type { CoreMemoryScopeStateStore } from "./CoreMemoryScopeStateRepository";
import type { CoreMemoryCleanupStore } from "./CoreMemoryCleanupRepository";

/**
 * Async facades for the Core learning stores (async SQLite migration plan, DB6). `new XRepository(db)`
 * keeps its signature; every method runs one services-domain unit over the synchronous
 * `XStore`, in the database worker when `COWORK_DB_WORKER_SERVICES` routes the domain there
 * and on the host connection otherwise.
 */

const CORE_EVAL_CASE_METHODS = [
  "create",
  "findById",
  "findByClusterId",
  "list",
  "update",
  "recordRun",
] as const;
export type CoreEvalCaseRepository = AsyncStore<
  CoreEvalCaseStore,
  (typeof CORE_EVAL_CASE_METHODS)[number]
>;
export const CoreEvalCaseRepository = serviceRepositoryFacade<
  CoreEvalCaseStore,
  (typeof CORE_EVAL_CASE_METHODS)[number]
>("coreEvalCase_", CORE_EVAL_CASE_METHODS);

const CORE_FAILURE_CLUSTER_METHODS = [
  "create",
  "findById",
  "findByFingerprint",
  "list",
  "update",
  "addMember",
  "listMemberIds",
] as const;
export type CoreFailureClusterRepository = AsyncStore<
  CoreFailureClusterStore,
  (typeof CORE_FAILURE_CLUSTER_METHODS)[number]
>;
export const CoreFailureClusterRepository = serviceRepositoryFacade<
  CoreFailureClusterStore,
  (typeof CORE_FAILURE_CLUSTER_METHODS)[number]
>("coreFailureCluster_", CORE_FAILURE_CLUSTER_METHODS);

const CORE_HARNESS_EXPERIMENT_METHODS = [
  "createExperiment",
  "findExperimentById",
  "listExperiments",
  "updateExperiment",
  "createRun",
  "updateRun",
  "findRunById",
  "listRunsForExperiment",
] as const;
export type CoreHarnessExperimentRepository = AsyncStore<
  CoreHarnessExperimentStore,
  (typeof CORE_HARNESS_EXPERIMENT_METHODS)[number]
>;
export const CoreHarnessExperimentRepository = serviceRepositoryFacade<
  CoreHarnessExperimentStore,
  (typeof CORE_HARNESS_EXPERIMENT_METHODS)[number]
>("coreHarnessExperiment_", CORE_HARNESS_EXPERIMENT_METHODS);

const CORE_LEARNINGS_METHODS = ["append", "appendIfNovel", "list"] as const;
export type CoreLearningsRepository = AsyncStore<
  CoreLearningsStore,
  (typeof CORE_LEARNINGS_METHODS)[number]
>;
export const CoreLearningsRepository = serviceRepositoryFacade<
  CoreLearningsStore,
  (typeof CORE_LEARNINGS_METHODS)[number]
>("coreLearnings_", CORE_LEARNINGS_METHODS);

const CORE_MEMORY_DISTILL_RUN_METHODS = ["create", "update", "findById", "list"] as const;
export type CoreMemoryDistillRunRepository = AsyncStore<
  CoreMemoryDistillRunStore,
  (typeof CORE_MEMORY_DISTILL_RUN_METHODS)[number]
>;
export const CoreMemoryDistillRunRepository = serviceRepositoryFacade<
  CoreMemoryDistillRunStore,
  (typeof CORE_MEMORY_DISTILL_RUN_METHODS)[number]
>("coreMemoryDistillRun_", CORE_MEMORY_DISTILL_RUN_METHODS);

const CORE_REGRESSION_GATE_METHODS = ["create", "findById", "findByExperimentRunId"] as const;
export type CoreRegressionGateRepository = AsyncStore<
  CoreRegressionGateStore,
  (typeof CORE_REGRESSION_GATE_METHODS)[number]
>;
export const CoreRegressionGateRepository = serviceRepositoryFacade<
  CoreRegressionGateStore,
  (typeof CORE_REGRESSION_GATE_METHODS)[number]
>("coreRegressionGate_", CORE_REGRESSION_GATE_METHODS);

const CORE_FAILURE_RECORD_METHODS = [
  "create",
  "findById",
  "findByTraceId",
  "list",
  "update",
] as const;
export type CoreFailureRecordRepository = AsyncStore<
  CoreFailureRecordStore,
  (typeof CORE_FAILURE_RECORD_METHODS)[number]
>;
export const CoreFailureRecordRepository = serviceRepositoryFacade<
  CoreFailureRecordStore,
  (typeof CORE_FAILURE_RECORD_METHODS)[number]
>("coreFailureRecord_", CORE_FAILURE_RECORD_METHODS);

const CORE_MEMORY_CANDIDATE_METHODS = [
  "create",
  "bulkCreate",
  "upsertByFingerprint",
  "markLifecycle",
  "findAppliedDuplicate",
  "findById",
  "list",
  "listForTrace",
  "review",
] as const;
export type CoreMemoryCandidateRepository = AsyncStore<
  CoreMemoryCandidateStore,
  (typeof CORE_MEMORY_CANDIDATE_METHODS)[number]
>;
export const CoreMemoryCandidateRepository = serviceRepositoryFacade<
  CoreMemoryCandidateStore,
  (typeof CORE_MEMORY_CANDIDATE_METHODS)[number]
>("coreMemoryCandidate_", CORE_MEMORY_CANDIDATE_METHODS);

const CORE_TRACE_METHODS = [
  "create",
  "update",
  "findById",
  "list",
  "listByProfile",
  "findOpenTrace",
  "appendEvent",
  "listEvents",
] as const;
export type CoreTraceRepository = AsyncStore<CoreTraceStore, (typeof CORE_TRACE_METHODS)[number]>;
export const CoreTraceRepository = serviceRepositoryFacade<
  CoreTraceStore,
  (typeof CORE_TRACE_METHODS)[number]
>("coreTrace_", CORE_TRACE_METHODS);

const CORE_MEMORY_SCOPE_STATE_METHODS = [
  "get",
  "upsert",
  "touchTrace",
  "touchDistill",
  "touchPrune",
] as const;
export type CoreMemoryScopeStateRepository = AsyncStore<
  CoreMemoryScopeStateStore,
  (typeof CORE_MEMORY_SCOPE_STATE_METHODS)[number]
>;
export const CoreMemoryScopeStateRepository = serviceRepositoryFacade<
  CoreMemoryScopeStateStore,
  (typeof CORE_MEMORY_SCOPE_STATE_METHODS)[number]
>("coreMemoryScopeState_", CORE_MEMORY_SCOPE_STATE_METHODS);

const CORE_MEMORY_CLEANUP_METHODS = ["run"] as const;
/** One-time duplicate cleanup for core memory candidates, learnings and trace memories. */
export type CoreMemoryCleanupRepository = AsyncStore<
  CoreMemoryCleanupStore,
  (typeof CORE_MEMORY_CLEANUP_METHODS)[number]
>;
export const CoreMemoryCleanupRepository = serviceRepositoryFacade<
  CoreMemoryCleanupStore,
  (typeof CORE_MEMORY_CLEANUP_METHODS)[number]
>("coreMemoryCleanup_", CORE_MEMORY_CLEANUP_METHODS);
