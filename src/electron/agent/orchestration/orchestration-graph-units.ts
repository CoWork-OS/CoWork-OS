import type Database from "better-sqlite3";
import type { UnitCatalog } from "../../database/statements/statement-catalog";
import { storeUnit } from "../../database/statements/store-units";
import { OrchestrationGraphStore } from "./OrchestrationGraphRepository";

const make = (db: Database.Database) => new OrchestrationGraphStore(db);

/** Orchestration graph transaction units (async SQLite migration plan, DB6), in the services domain. */
export const ORCHESTRATION_GRAPH_UNITS = {
  orchestrationGraph_createRun: storeUnit(make, "createRun", { readonly: false }),
  orchestrationGraph_appendNodes: storeUnit(make, "appendNodes", { readonly: false }),
  orchestrationGraph_findSnapshotByRunId: storeUnit(make, "findSnapshotByRunId", {
    readonly: true,
  }),
  orchestrationGraph_findSnapshotByRootTaskId: storeUnit(make, "findSnapshotByRootTaskId", {
    readonly: true,
  }),
  orchestrationGraph_listSnapshotsByRootTaskId: storeUnit(make, "listSnapshotsByRootTaskId", {
    readonly: true,
  }),
  orchestrationGraph_listRunningSnapshots: storeUnit(make, "listRunningSnapshots", {
    readonly: true,
  }),
  orchestrationGraph_listNodesByRun: storeUnit(make, "listNodesByRun", { readonly: true }),
  orchestrationGraph_listEdgesByRun: storeUnit(make, "listEdgesByRun", { readonly: true }),
  orchestrationGraph_findNodeByHandle: storeUnit(make, "findNodeByHandle", { readonly: true }),
  orchestrationGraph_findNodeById: storeUnit(make, "findNodeById", { readonly: true }),
  orchestrationGraph_findNodeByTeamItemId: storeUnit(make, "findNodeByTeamItemId", {
    readonly: true,
  }),
  orchestrationGraph_findSnapshotByTeamRunId: storeUnit(make, "findSnapshotByTeamRunId", {
    readonly: true,
  }),
  orchestrationGraph_findNodeByAcpTaskId: storeUnit(make, "findNodeByAcpTaskId", {
    readonly: true,
  }),
  orchestrationGraph_updateRun: storeUnit(make, "updateRun", { readonly: false }),
  orchestrationGraph_updateNode: storeUnit(make, "updateNode", { readonly: false }),
  orchestrationGraph_createNodeEvent: storeUnit(make, "createNodeEvent", { readonly: false }),
  orchestrationGraph_listNodeNotifications: storeUnit(make, "listNodeNotifications", {
    readonly: true,
  }),
} satisfies UnitCatalog;
