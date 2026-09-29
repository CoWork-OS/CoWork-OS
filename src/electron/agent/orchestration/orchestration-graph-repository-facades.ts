import { serviceRepositoryFacade } from "../../database/service-statements";
import type { AsyncStore } from "../../database/statements/store-units";
import type { OrchestrationGraphStore } from "./OrchestrationGraphRepository";

const ORCHESTRATIONGRAPHREPOSITORY_METHODS = [
  "createRun",
  "appendNodes",
  "findSnapshotByRunId",
  "findSnapshotByRootTaskId",
  "listSnapshotsByRootTaskId",
  "listRunningSnapshots",
  "listNodesByRun",
  "listEdgesByRun",
  "findNodeByHandle",
  "findNodeById",
  "findNodeByTeamItemId",
  "findSnapshotByTeamRunId",
  "findNodeByAcpTaskId",
  "updateRun",
  "updateNode",
  "createNodeEvent",
  "listNodeNotifications",
  "markNodeReady",
  "claimReadyNode",
  "updateNodeForDispatchClaim",
  "markRunCancelled",
  "cancelRunningRunsForRootTask",
  "finishRunIfRunning",
  "cancelUnstartedNode",
  "resolveInterruptedCancellation",
  "beginNodeCancellation",
  "updateNodeForCancellation",
  "listCancelledSnapshots",
  "isTeamWorkItemTask",
] as const;

/**
 * Async facade for orchestration graphs (async SQLite migration plan, DB6). new
 * OrchestrationGraphRepository(db) keeps its signature; every method runs one services-
 * domain unit over OrchestrationGraphStore.
 */
export type OrchestrationGraphRepository = AsyncStore<
  OrchestrationGraphStore,
  (typeof ORCHESTRATIONGRAPHREPOSITORY_METHODS)[number]
>;
export const OrchestrationGraphRepository = serviceRepositoryFacade<
  OrchestrationGraphStore,
  (typeof ORCHESTRATIONGRAPHREPOSITORY_METHODS)[number]
>("orchestrationGraph_", ORCHESTRATIONGRAPHREPOSITORY_METHODS);
