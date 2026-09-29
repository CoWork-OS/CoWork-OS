import type Database from "better-sqlite3";
import type { SERVICE_UNITS } from "./service-units";
import { StatementPort } from "./statements/statement-port";
import { storeFacade, type AsyncStore } from "./statements/store-units";

/** The services domain's statement port and facades (async SQLite migration plan, DB6). */

export type ServiceStatementPort = StatementPort<never, typeof SERVICE_UNITS>;

const ports = new WeakMap<Database.Database, ServiceStatementPort>();

export function serviceStatements(db: Database.Database): ServiceStatementPort {
  let port = ports.get(db);
  if (!port) {
    port = new StatementPort(db, "services", {});
    ports.set(db, port);
  }
  return port;
}

/**
 * An async facade class over a store's services-domain units. Without a connection (some
 * repositories keep rows in memory for tests) the facade runs a store built by
 * `memoryStore` directly.
 */
export function serviceRepositoryFacade<S, K extends keyof S & string>(
  prefix: string,
  methods: readonly K[],
  options: {
    memoryStore?: () => S;
    /**
     * For stores whose units are clocked (`clockedStoreUnit`): each call passes the
     * facade's clock reading first. `onOpen` runs once on the host connection, for
     * example to ensure the store's schema before any unit runs.
     */
    clocked?: { onOpen?: (db: Database.Database, now: () => number) => void };
    /** Host-side work around some methods, for state or services only the host holds. */
    hooks?: (facade: AsyncStore<S, K>, db: Database.Database) => void;
  } = {},
): new (db?: Database.Database, now?: () => number) => AsyncStore<S, K> {
  return class {
    constructor(db?: Database.Database, now: () => number = () => Date.now()) {
      if (!db) {
        if (!options.memoryStore) throw new Error(`${prefix} repository needs a database`);
        const store = options.memoryStore();
        return storeFacade<S, K & never>(prefix, methods as never, async (name, args) =>
          (store[name.slice(prefix.length) as K] as (...values: unknown[]) => unknown)(...args),
        );
      }
      const sql = serviceStatements(db);
      if (options.clocked) {
        options.clocked.onOpen?.(db, now);
        return storeFacade<S, K & never>(prefix, methods as never, (name, args) =>
          sql.unit(name as never, [now(), ...args] as never),
        );
      }
      const facade = storeFacade<S, K & never>(prefix, methods as never, (name, args) =>
        sql.unit(name as never, args as never),
      ) as AsyncStore<S, K>;
      options.hooks?.(facade, db);
      return facade;
    }
  } as unknown as new (db?: Database.Database, now?: () => number) => AsyncStore<S, K>;
}
