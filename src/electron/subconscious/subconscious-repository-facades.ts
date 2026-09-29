import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { SubconsciousStore } from "./subconscious-sql";
import type {
  SubconsciousBacklogStore,
  SubconsciousCritiqueStore,
  SubconsciousDecisionStore,
  SubconsciousDispatchStore,
  SubconsciousHypothesisStore,
  SubconsciousRunStore,
  SubconsciousTargetStore,
} from "./SubconsciousRepositories";

/**
 * Async facades for the Subconscious stores (async SQLite migration plan, DB6). `new XRepository(db)`
 * keeps its signature; every method runs one services-domain unit over the synchronous
 * `XStore`, in the database worker when `COWORK_DB_WORKER_SERVICES` routes the domain there
 * and on the host connection otherwise.
 */

const SUBCONSCIOUS_TARGET_METHODS = ["upsert", "update", "findByKey", "list"] as const;
export type SubconsciousTargetRepository = AsyncStore<
  SubconsciousTargetStore,
  (typeof SUBCONSCIOUS_TARGET_METHODS)[number]
>;
export const SubconsciousTargetRepository = serviceRepositoryFacade<
  SubconsciousTargetStore,
  (typeof SUBCONSCIOUS_TARGET_METHODS)[number]
>("subconsciousTarget_", SUBCONSCIOUS_TARGET_METHODS);

const SUBCONSCIOUS_RUN_METHODS = [
  "create",
  "update",
  "findById",
  "findLatestByFingerprint",
  "list",
] as const;
export type SubconsciousRunRepository = AsyncStore<
  SubconsciousRunStore,
  (typeof SUBCONSCIOUS_RUN_METHODS)[number]
>;
export const SubconsciousRunRepository = serviceRepositoryFacade<
  SubconsciousRunStore,
  (typeof SUBCONSCIOUS_RUN_METHODS)[number]
>("subconsciousRun_", SUBCONSCIOUS_RUN_METHODS);

const SUBCONSCIOUS_HYPOTHESIS_METHODS = ["replaceForRun", "listByRun"] as const;
export type SubconsciousHypothesisRepository = AsyncStore<
  SubconsciousHypothesisStore,
  (typeof SUBCONSCIOUS_HYPOTHESIS_METHODS)[number]
>;
export const SubconsciousHypothesisRepository = serviceRepositoryFacade<
  SubconsciousHypothesisStore,
  (typeof SUBCONSCIOUS_HYPOTHESIS_METHODS)[number]
>("subconsciousHypothesis_", SUBCONSCIOUS_HYPOTHESIS_METHODS);

const SUBCONSCIOUS_CRITIQUE_METHODS = ["replaceForRun", "listByRun"] as const;
export type SubconsciousCritiqueRepository = AsyncStore<
  SubconsciousCritiqueStore,
  (typeof SUBCONSCIOUS_CRITIQUE_METHODS)[number]
>;
export const SubconsciousCritiqueRepository = serviceRepositoryFacade<
  SubconsciousCritiqueStore,
  (typeof SUBCONSCIOUS_CRITIQUE_METHODS)[number]
>("subconsciousCritique_", SUBCONSCIOUS_CRITIQUE_METHODS);

const SUBCONSCIOUS_DECISION_METHODS = ["upsert", "findByRun", "findLatestByTarget"] as const;
export type SubconsciousDecisionRepository = AsyncStore<
  SubconsciousDecisionStore,
  (typeof SUBCONSCIOUS_DECISION_METHODS)[number]
>;
export const SubconsciousDecisionRepository = serviceRepositoryFacade<
  SubconsciousDecisionStore,
  (typeof SUBCONSCIOUS_DECISION_METHODS)[number]
>("subconsciousDecision_", SUBCONSCIOUS_DECISION_METHODS);

const SUBCONSCIOUS_BACKLOG_METHODS = [
  "create",
  "createOrRefreshOpen",
  "listByTarget",
  "countOpenByTarget",
  "deleteLegacyNoiseByTarget",
  "dedupeOpenByTarget",
  "update",
] as const;
export type SubconsciousBacklogRepository = AsyncStore<
  SubconsciousBacklogStore,
  (typeof SUBCONSCIOUS_BACKLOG_METHODS)[number]
>;
export const SubconsciousBacklogRepository = serviceRepositoryFacade<
  SubconsciousBacklogStore,
  (typeof SUBCONSCIOUS_BACKLOG_METHODS)[number]
>("subconsciousBacklog_", SUBCONSCIOUS_BACKLOG_METHODS);

const SUBCONSCIOUS_DISPATCH_METHODS = ["create", "listByTarget"] as const;
export type SubconsciousDispatchRepository = AsyncStore<
  SubconsciousDispatchStore,
  (typeof SUBCONSCIOUS_DISPATCH_METHODS)[number]
>;
export const SubconsciousDispatchRepository = serviceRepositoryFacade<
  SubconsciousDispatchStore,
  (typeof SUBCONSCIOUS_DISPATCH_METHODS)[number]
>("subconsciousDispatch_", SUBCONSCIOUS_DISPATCH_METHODS);

const SUBCONSCIOUS_METHODS = [
  "evidenceRows",
  "rekeyTarget",
  "clearTargetData",
  "clearHistoryData",
  "normalizeLegacyOutcomeVocabulary",
] as const;
/** The loop's own SQL (`SubconsciousStore`), through services-domain units. */
export type SubconsciousRepository = AsyncStore<
  SubconsciousStore,
  (typeof SUBCONSCIOUS_METHODS)[number]
>;
export const SubconsciousRepository = serviceRepositoryFacade<
  SubconsciousStore,
  (typeof SUBCONSCIOUS_METHODS)[number]
>("subconscious_", SUBCONSCIOUS_METHODS);
