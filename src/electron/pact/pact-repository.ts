import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import { PactStore } from "./pact-sql";
import { PACT_STORE_METHODS } from "./pact-units";
import { ensurePactSchema } from "./schema";

/** Async PACT repository: each method runs one `pact_*` services-domain unit. */
export type PactRepository = AsyncStore<PactStore, (typeof PACT_STORE_METHODS)[number]>;

export const PactRepository = serviceRepositoryFacade<
  PactStore,
  (typeof PACT_STORE_METHODS)[number]
>("pact_", PACT_STORE_METHODS, {
  // Tables are normally created by DatabaseManager; this covers connections opened elsewhere.
  clocked: { onOpen: (db) => ensurePactSchema(db) },
});
