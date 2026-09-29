import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { clockedStoreUnit, storeUnit } from "../database/statements/store-units";
import { RoutineStore } from "./routine-sql";
import { RoutineWorkflowStore } from "./workflow/repository";

const workflowStore = (db: Database.Database, now: () => number) =>
  new RoutineWorkflowStore(db, now, { ensureSchema: false });

/**
 * Routine transaction units (async SQLite migration plan, DB6), in the services domain.
 * The workflow store reads a clock, so its units are clocked: the caller's reading comes
 * first. Generated from the class; a method is a write when it, or a method it calls,
 * writes or opens a transaction.
 */
export const ROUTINE_UNITS = {
  routineWorkflow_createVersion: clockedStoreUnit(workflowStore, "createVersion", {
    readonly: false,
  }),
  routineWorkflow_getVersion: clockedStoreUnit(workflowStore, "getVersion", { readonly: true }),
  routineWorkflow_getActiveVersion: clockedStoreUnit(workflowStore, "getActiveVersion", {
    readonly: true,
  }),
  routineWorkflow_listVersions: clockedStoreUnit(workflowStore, "listVersions", { readonly: true }),
  routineWorkflow_activateVersion: clockedStoreUnit(workflowStore, "activateVersion", {
    readonly: false,
  }),
  routineWorkflow_createRun: clockedStoreUnit(workflowStore, "createRun", { readonly: false }),
  routineWorkflow_getRun: clockedStoreUnit(workflowStore, "getRun", { readonly: true }),
  routineWorkflow_listRuns: clockedStoreUnit(workflowStore, "listRuns", { readonly: true }),
  routineWorkflow_listRecoverableRuns: clockedStoreUnit(workflowStore, "listRecoverableRuns", {
    readonly: true,
  }),
  routineWorkflow_requeueProcessingEvents: clockedStoreUnit(
    workflowStore,
    "requeueProcessingEvents",
    { readonly: false },
  ),
  routineWorkflow_pruneExpiredData: clockedStoreUnit(workflowStore, "pruneExpiredData", {
    readonly: false,
  }),
  routineWorkflow_updateRun: clockedStoreUnit(workflowStore, "updateRun", { readonly: false }),
  routineWorkflow_findRunByIdempotencyKey: clockedStoreUnit(
    workflowStore,
    "findRunByIdempotencyKey",
    { readonly: true },
  ),
  routineWorkflow_initializeSteps: clockedStoreUnit(workflowStore, "initializeSteps", {
    readonly: false,
  }),
  routineWorkflow_listSteps: clockedStoreUnit(workflowStore, "listSteps", { readonly: true }),
  routineWorkflow_getStep: clockedStoreUnit(workflowStore, "getStep", { readonly: true }),
  routineWorkflow_findStep: clockedStoreUnit(workflowStore, "findStep", { readonly: true }),
  routineWorkflow_updateStep: clockedStoreUnit(workflowStore, "updateStep", { readonly: false }),
  routineWorkflow_enqueueEvent: clockedStoreUnit(workflowStore, "enqueueEvent", {
    readonly: false,
  }),
  routineWorkflow_claimNextEvent: clockedStoreUnit(workflowStore, "claimNextEvent", {
    readonly: false,
  }),
  routineWorkflow_updateEvent: clockedStoreUnit(workflowStore, "updateEvent", { readonly: false }),
  routineWorkflow_listEvents: clockedStoreUnit(workflowStore, "listEvents", { readonly: true }),
  routineWorkflow_recordEventSample: clockedStoreUnit(workflowStore, "recordEventSample", {
    readonly: false,
  }),
  routineWorkflow_listEventSamples: clockedStoreUnit(workflowStore, "listEventSamples", {
    readonly: true,
  }),
  routineWorkflow_deleteRoutineData: clockedStoreUnit(workflowStore, "deleteRoutineData", {
    readonly: false,
  }),
  routine_getStarterCursorJson: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "getStarterCursorJson",
    { readonly: true },
  ),
  routine_setStarterCursorJson: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "setStarterCursorJson",
    { readonly: false },
  ),
  routine_listRoutineRows: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "listRoutineRows",
    {
      readonly: true,
    },
  ),
  routine_getRoutineRow: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "getRoutineRow",
    {
      readonly: true,
    },
  ),
  routine_persistRoutine: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "persistRoutine",
    {
      readonly: false,
    },
  ),
  routine_deleteRoutine: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "deleteRoutine",
    {
      readonly: false,
    },
  ),
  routine_listRunRows: storeUnit((db: Database.Database) => new RoutineStore(db), "listRunRows", {
    readonly: true,
  }),
  routine_runRowsForTask: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "runRowsForTask",
    {
      readonly: true,
    },
  ),
  routine_staleTimeoutRunRows: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "staleTimeoutRunRows",
    {
      readonly: true,
    },
  ),
  routine_activeRunRows: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "activeRunRows",
    {
      readonly: true,
    },
  ),
  routine_runRowByWorkflowRun: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "runRowByWorkflowRun",
    {
      readonly: true,
    },
  ),
  routine_runRowByKey: storeUnit((db: Database.Database) => new RoutineStore(db), "runRowByKey", {
    readonly: true,
  }),
  routine_allRunRows: storeUnit((db: Database.Database) => new RoutineStore(db), "allRunRows", {
    readonly: true,
  }),
  routine_upsertRunRow: storeUnit((db: Database.Database) => new RoutineStore(db), "upsertRunRow", {
    readonly: false,
  }),
  routine_applyRunDedupePlan: storeUnit(
    (db: Database.Database) => new RoutineStore(db),
    "applyRunDedupePlan",
    {
      readonly: false,
    },
  ),
} satisfies UnitCatalog;
