import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { ManagedStore } from "./managed-sql";
import {
  ManagedAgentStore,
  ManagedAgentVersionStore,
  ManagedEnvironmentStore,
  ManagedSessionEventStore,
  ManagedSessionStore,
} from "./repositories";

/**
 * Managed agent transaction units (async SQLite migration plan, DB6): one per public method of
 * the synchronous stores, in the services domain. Generated from the classes; a method is
 * a write when it, or a method it calls, writes or opens a transaction.
 */
export const MANAGED_UNITS = {
  managedAgent_create: storeUnit((db: Database.Database) => new ManagedAgentStore(db), "create", {
    readonly: false,
  }),
  managedAgent_update: storeUnit((db: Database.Database) => new ManagedAgentStore(db), "update", {
    readonly: false,
  }),
  managedAgent_findById: storeUnit(
    (db: Database.Database) => new ManagedAgentStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  managedAgent_list: storeUnit((db: Database.Database) => new ManagedAgentStore(db), "list", {
    readonly: true,
  }),
  managedAgentVersion_create: storeUnit(
    (db: Database.Database) => new ManagedAgentVersionStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  managedAgentVersion_find: storeUnit(
    (db: Database.Database) => new ManagedAgentVersionStore(db),
    "find",
    {
      readonly: true,
    },
  ),
  managedAgentVersion_list: storeUnit(
    (db: Database.Database) => new ManagedAgentVersionStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  managedAgentVersion_updateMetadata: storeUnit(
    (db: Database.Database) => new ManagedAgentVersionStore(db),
    "updateMetadata",
    {
      readonly: false,
    },
  ),
  managedEnvironment_create: storeUnit(
    (db: Database.Database) => new ManagedEnvironmentStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  managedEnvironment_update: storeUnit(
    (db: Database.Database) => new ManagedEnvironmentStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  managedEnvironment_findById: storeUnit(
    (db: Database.Database) => new ManagedEnvironmentStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  managedEnvironment_list: storeUnit(
    (db: Database.Database) => new ManagedEnvironmentStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  managedSession_create: storeUnit(
    (db: Database.Database) => new ManagedSessionStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  managedSession_update: storeUnit(
    (db: Database.Database) => new ManagedSessionStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  managedSession_findById: storeUnit(
    (db: Database.Database) => new ManagedSessionStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  managedSession_findByBackingTaskId: storeUnit(
    (db: Database.Database) => new ManagedSessionStore(db),
    "findByBackingTaskId",
    {
      readonly: true,
    },
  ),
  managedSession_list: storeUnit((db: Database.Database) => new ManagedSessionStore(db), "list", {
    readonly: true,
  }),
  managedSessionEvent_create: storeUnit(
    (db: Database.Database) => new ManagedSessionEventStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  managedSessionEvent_findById: storeUnit(
    (db: Database.Database) => new ManagedSessionEventStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  managedSessionEvent_listBySessionId: storeUnit(
    (db: Database.Database) => new ManagedSessionEventStore(db),
    "listBySessionId",
    {
      readonly: true,
    },
  ),
  managedSessionEvent_hasSourceTaskEvent: storeUnit(
    (db: Database.Database) => new ManagedSessionEventStore(db),
    "hasSourceTaskEvent",
    {
      readonly: true,
    },
  ),
  managed_seedMembership: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "seedMembership",
    {
      readonly: false,
    },
  ),
  managed_workspaceRole: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "workspaceRole",
    {
      readonly: false,
    },
  ),
  managed_listMembershipRows: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "listMembershipRows",
    {
      readonly: true,
    },
  ),
  managed_upsertMembership: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "upsertMembership",
    {
      readonly: false,
    },
  ),
  managed_listAuditRows: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "listAuditRows",
    {
      readonly: true,
    },
  ),
  managed_insertAudit: storeUnit((db: Database.Database) => new ManagedStore(db), "insertAudit", {
    readonly: false,
  }),
  managed_listRoutineRows: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "listRoutineRows",
    {
      readonly: true,
    },
  ),
  managed_setRoutineEnabled: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "setRoutineEnabled",
    {
      readonly: false,
    },
  ),
  managed_routineRunRowsWithDefinition: storeUnit(
    (db: Database.Database) => new ManagedStore(db),
    "routineRunRowsWithDefinition",
    {
      readonly: true,
    },
  ),
} satisfies UnitCatalog;
