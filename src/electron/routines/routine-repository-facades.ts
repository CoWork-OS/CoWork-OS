import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { RoutineStore } from "./routine-sql";
import { RoutineWorkflowStore } from "./workflow/repository";

/**
 * Async facade for the routine workflow store (async SQLite migration plan, DB6).
 * `new RoutineWorkflowRepository(db, now)` keeps its signature: it ensures the schema on
 * the host connection once, and every method runs one clocked services-domain unit, in
 * the database worker when `COWORK_DB_WORKER_SERVICES` routes the domain there.
 */
const ROUTINE_WORKFLOW_METHODS = [
  "createVersion",
  "getVersion",
  "getActiveVersion",
  "listVersions",
  "activateVersion",
  "createRun",
  "getRun",
  "listRuns",
  "listRecoverableRuns",
  "requeueProcessingEvents",
  "pruneExpiredData",
  "updateRun",
  "findRunByIdempotencyKey",
  "initializeSteps",
  "listSteps",
  "getStep",
  "findStep",
  "updateStep",
  "enqueueEvent",
  "claimNextEvent",
  "updateEvent",
  "listEvents",
  "recordEventSample",
  "listEventSamples",
  "deleteRoutineData",
] as const;
export type RoutineWorkflowRepository = AsyncStore<
  RoutineWorkflowStore,
  (typeof ROUTINE_WORKFLOW_METHODS)[number]
>;
export const RoutineWorkflowRepository = serviceRepositoryFacade<
  RoutineWorkflowStore,
  (typeof ROUTINE_WORKFLOW_METHODS)[number]
>("routineWorkflow_", ROUTINE_WORKFLOW_METHODS, {
  clocked: { onOpen: (db, now) => void new RoutineWorkflowStore(db, now) },
});

const ROUTINE_METHODS = [
  "listRoutineRows",
  "getRoutineRow",
  "persistRoutine",
  "deleteRoutine",
  "listRunRows",
  "runRowsForTask",
  "staleTimeoutRunRows",
  "activeRunRows",
  "runRowByWorkflowRun",
  "runRowByKey",
  "allRunRows",
  "upsertRunRow",
  "applyRunDedupePlan",
  "getStarterCursorJson",
  "setStarterCursorJson",
] as const;
/** The routine service's own rows (`RoutineStore`), through services-domain units. */
export type RoutineRepository = AsyncStore<RoutineStore, (typeof ROUTINE_METHODS)[number]>;
export const RoutineRepository = serviceRepositoryFacade<
  RoutineStore,
  (typeof ROUTINE_METHODS)[number]
>("routine_", ROUTINE_METHODS);
