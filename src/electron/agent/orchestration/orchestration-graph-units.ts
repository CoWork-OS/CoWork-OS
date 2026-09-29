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
  orchestrationGraph_markNodeReady: storeUnit(make, "markNodeReady", { readonly: false }),
  orchestrationGraph_claimReadyNode: storeUnit(make, "claimReadyNode", { readonly: false }),
  orchestrationGraph_updateNodeForDispatchClaim: storeUnit(make, "updateNodeForDispatchClaim", {
    readonly: false,
  }),
  orchestrationGraph_markRunCancelled: storeUnit(make, "markRunCancelled", { readonly: false }),
  orchestrationGraph_cancelRunningRunsForRootTask: storeUnit(make, "cancelRunningRunsForRootTask", {
    readonly: false,
  }),
  orchestrationGraph_finishRunIfRunning: storeUnit(make, "finishRunIfRunning", { readonly: false }),
  orchestrationGraph_cancelUnstartedNode: storeUnit(make, "cancelUnstartedNode", {
    readonly: false,
  }),
  orchestrationGraph_resolveInterruptedCancellation: storeUnit(
    make,
    "resolveInterruptedCancellation",
    { readonly: false },
  ),
  orchestrationGraph_beginNodeCancellation: storeUnit(make, "beginNodeCancellation", {
    readonly: false,
  }),
  orchestrationGraph_updateNodeForCancellation: storeUnit(make, "updateNodeForCancellation", {
    readonly: false,
  }),
  orchestrationGraph_listCancelledSnapshots: storeUnit(make, "listCancelledSnapshots", {
    readonly: true,
  }),
  orchestrationGraph_isTeamWorkItemTask: storeUnit(make, "isTeamWorkItemTask", { readonly: true }),
} satisfies UnitCatalog;
