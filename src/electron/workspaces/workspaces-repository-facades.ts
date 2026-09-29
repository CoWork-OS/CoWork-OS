import type Database from "better-sqlite3";
import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import { normalizeRequired, SessionMembershipStore } from "./SessionMembershipService";
import type { WorkContextStore } from "./WorkContextService";

const WORK_CONTEXT_METHODS = [
  "list",
  "get",
  "findByTaskId",
  "create",
  "update",
  "addMember",
  "ensureForTask",
  "ensureForManagedSession",
  "attachForkedTask",
] as const;

/** Async facade for work contexts (async SQLite migration plan, DB6). */
export type WorkContextService = AsyncStore<
  WorkContextStore,
  (typeof WORK_CONTEXT_METHODS)[number]
>;
export const WorkContextService = serviceRepositoryFacade<
  WorkContextStore,
  (typeof WORK_CONTEXT_METHODS)[number]
>("workContext_", WORK_CONTEXT_METHODS);

const SESSION_MEMBERSHIP_METHODS = [
  "principalDetails",
  "ensureOwner",
  "getSnapshot",
  "getSnapshotForTask",
  "listAccessibleContexts",
  "createInvite",
  "acceptInvite",
  "updateMember",
  "touchPresence",
  "listAudit",
  "authorizeContextAction",
  "authorizeTaskAction",
  "recordTaskAction",
  "authorizeManagedSessionAction",
] as const;

type MembershipUnits = AsyncStore<
  SessionMembershipStore,
  (typeof SESSION_MEMBERSHIP_METHODS)[number]
>;

const SessionMembershipUnits = serviceRepositoryFacade<
  SessionMembershipStore,
  (typeof SESSION_MEMBERSHIP_METHODS)[number]
>("sessionMembership_", SESSION_MEMBERSHIP_METHODS);

type LocalPrincipal = ReturnType<SessionMembershipStore["getLocalPrincipal"]>;

/**
 * Session membership and authorization (async SQLite migration plan, DB6). Every data
 * operation runs one services-domain unit over `SessionMembershipStore`. The host keeps
 * what only it holds: which principal each renderer client acts as, and the local
 * principal (one row, read once on the host connection and cached), so
 * `principalForClient` and `getLocalPrincipal` stay synchronous.
 */
export class SessionMembershipService {
  private readonly clientPrincipals = new Map<number, string>();
  private localPrincipal: LocalPrincipal | null = null;

  constructor(private readonly db: Database.Database) {
    // The unit facade is a plain object, so its methods are copied onto this instance.
    Object.assign(this, new SessionMembershipUnits(db));
  }

  getLocalPrincipal(displayName?: string): LocalPrincipal {
    this.localPrincipal ??= new SessionMembershipStore(this.db).getLocalPrincipal(displayName);
    return this.localPrincipal;
  }

  registerClientPrincipal(clientId: number, principalId: string): void {
    this.clientPrincipals.set(clientId, normalizeRequired(principalId, "principalId", 160));
  }

  principalForClient(clientId: number): string {
    return this.clientPrincipals.get(clientId) || this.getLocalPrincipal().principalId;
  }

  async principalDetailsForClient(
    clientId: number,
  ): ReturnType<MembershipUnits["principalDetails"]> {
    return this.principalDetails(this.principalForClient(clientId));
  }
}

// The unit methods are assigned per instance in the constructor.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- typed unit methods
export interface SessionMembershipService extends MembershipUnits {}
