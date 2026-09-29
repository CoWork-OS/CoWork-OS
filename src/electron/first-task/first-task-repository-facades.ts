import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { FirstTaskStore } from "./first-task-sql";

const FIRST_TASK_METHODS = [
  "getSetup",
  "setSetupChoice",
  "markModelReady",
  "findAttempt",
  "attemptTaskIds",
  "createSampleAttempt",
  "clearCheck",
  "recordCheck",
  "markInspected",
  "requestRevision",
  "cancelRevision",
  "readRealWork",
  "recordRealWorkInspection",
  "recordRealWorkUseful",
] as const;

/** Async facade for the first-task flow (async SQLite migration plan, DB6): one services-domain unit per method. */
export type FirstTaskRepository = AsyncStore<FirstTaskStore, (typeof FIRST_TASK_METHODS)[number]>;
export const FirstTaskRepository = serviceRepositoryFacade<
  FirstTaskStore,
  (typeof FIRST_TASK_METHODS)[number]
>("firstTask_", FIRST_TASK_METHODS);
