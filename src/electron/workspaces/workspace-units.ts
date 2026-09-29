import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { SessionMembershipStore } from "./SessionMembershipService";
import { WorkContextStore } from "./WorkContextService";

/**
 * Work context and session membership transaction units (async SQLite migration plan,
 * DB6), in the services domain. Every membership method is a write unit: reads may create
 * the local principal or a context's owner, and authorization shares a unit with the
 * write it guards.
 */
export const WORKSPACE_UNITS = {
  workContext_list: storeUnit((db: Database.Database) => new WorkContextStore(db), "list", {
    readonly: true,
  }),
  workContext_get: storeUnit((db: Database.Database) => new WorkContextStore(db), "get", {
    readonly: true,
  }),
  workContext_findByTaskId: storeUnit(
    (db: Database.Database) => new WorkContextStore(db),
    "findByTaskId",
    {
      readonly: true,
    },
  ),
  workContext_create: storeUnit((db: Database.Database) => new WorkContextStore(db), "create", {
    readonly: false,
  }),
  workContext_update: storeUnit((db: Database.Database) => new WorkContextStore(db), "update", {
    readonly: false,
  }),
  workContext_addMember: storeUnit(
    (db: Database.Database) => new WorkContextStore(db),
    "addMember",
    {
      readonly: false,
    },
  ),
  workContext_ensureForTask: storeUnit(
    (db: Database.Database) => new WorkContextStore(db),
    "ensureForTask",
    {
      readonly: false,
    },
  ),
  workContext_ensureForManagedSession: storeUnit(
    (db: Database.Database) => new WorkContextStore(db),
    "ensureForManagedSession",
    {
      readonly: false,
    },
  ),
  workContext_attachForkedTask: storeUnit(
    (db: Database.Database) => new WorkContextStore(db),
    "attachForkedTask",
    {
      readonly: false,
    },
  ),
  sessionMembership_getLocalPrincipal: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "getLocalPrincipal",
    {
      readonly: false,
    },
  ),
  sessionMembership_principalDetails: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "principalDetails",
    {
      readonly: false,
    },
  ),
  sessionMembership_ensureOwner: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "ensureOwner",
    {
      readonly: false,
    },
  ),
  sessionMembership_getSnapshot: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "getSnapshot",
    {
      readonly: false,
    },
  ),
  sessionMembership_getSnapshotForTask: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "getSnapshotForTask",
    {
      readonly: false,
    },
  ),
  sessionMembership_listAccessibleContexts: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "listAccessibleContexts",
    {
      readonly: false,
    },
  ),
  sessionMembership_createInvite: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "createInvite",
    {
      readonly: false,
    },
  ),
  sessionMembership_acceptInvite: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "acceptInvite",
    {
      readonly: false,
    },
  ),
  sessionMembership_updateMember: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "updateMember",
    {
      readonly: false,
    },
  ),
  sessionMembership_touchPresence: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "touchPresence",
    {
      readonly: false,
    },
  ),
  sessionMembership_listAudit: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "listAudit",
    {
      readonly: false,
    },
  ),
  sessionMembership_authorizeContextAction: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "authorizeContextAction",
    {
      readonly: false,
    },
  ),
  sessionMembership_authorizeTaskAction: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "authorizeTaskAction",
    {
      readonly: false,
    },
  ),
  sessionMembership_recordTaskAction: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "recordTaskAction",
    {
      readonly: false,
    },
  ),
  sessionMembership_authorizeManagedSessionAction: storeUnit(
    (db: Database.Database) => new SessionMembershipStore(db),
    "authorizeManagedSessionAction",
    {
      readonly: false,
    },
  ),
} satisfies UnitCatalog;
