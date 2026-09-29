import { invalidateTaskRowReads } from "../database/repositories";
import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { EvalStore } from "./EvalService";

const EVAL_METHODS = [
  "listSuites",
  "getCase",
  "getRun",
  "getBaselineMetrics",
  "createCaseFromTask",
  "runSuite",
] as const;

/**
 * Async facade for evals (async SQLite migration plan, DB6). `new EvalService(db)` keeps
 * its signature; every method runs one services-domain unit over `EvalStore`. Creating a
 * case links it on its source task, so the host drops its cached task rows afterwards.
 */
export type EvalService = AsyncStore<EvalStore, (typeof EVAL_METHODS)[number]>;
export const EvalService = serviceRepositoryFacade<EvalStore, (typeof EVAL_METHODS)[number]>(
  "eval_",
  EVAL_METHODS,
  {
    hooks: (facade, db) => {
      const createCaseFromTask = facade.createCaseFromTask;
      facade.createCaseFromTask = async (taskId: string) => {
        const evalCase = await createCaseFromTask(taskId);
        invalidateTaskRowReads(db);
        return evalCase;
      };
    },
  },
);
