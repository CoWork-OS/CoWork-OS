import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { CouncilConfigStore, CouncilMemoStore, CouncilRunStore } from "./council-sql";

const COUNCILCONFIG_METHODS = [
  "allIds",
  "listByWorkspace",
  "findById",
  "findByManagedCronJobId",
  "create",
  "update",
  "delete",
] as const;

/** Async facade over `CouncilConfigStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type CouncilConfigRepository = AsyncStore<
  CouncilConfigStore,
  (typeof COUNCILCONFIG_METHODS)[number]
>;
export const CouncilConfigRepository = serviceRepositoryFacade<
  CouncilConfigStore,
  (typeof COUNCILCONFIG_METHODS)[number]
>("councilConfig_", COUNCILCONFIG_METHODS);

const COUNCILRUN_METHODS = [
  "create",
  "listByCouncil",
  "findById",
  "findByTaskId",
  "bindTask",
  "complete",
] as const;

/** Async facade over `CouncilRunStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type CouncilRunRepository = AsyncStore<CouncilRunStore, (typeof COUNCILRUN_METHODS)[number]>;
export const CouncilRunRepository = serviceRepositoryFacade<
  CouncilRunStore,
  (typeof COUNCILRUN_METHODS)[number]
>("councilRun_", COUNCILRUN_METHODS);

const COUNCILMEMO_METHODS = ["create", "getLatestForCouncil", "findById"] as const;

/** Async facade over `CouncilMemoStore` (async SQLite migration plan, DB6): one services-domain unit per method. */
export type CouncilMemoRepository = AsyncStore<
  CouncilMemoStore,
  (typeof COUNCILMEMO_METHODS)[number]
>;
export const CouncilMemoRepository = serviceRepositoryFacade<
  CouncilMemoStore,
  (typeof COUNCILMEMO_METHODS)[number]
>("councilMemo_", COUNCILMEMO_METHODS);
