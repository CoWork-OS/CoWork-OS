import type Database from "better-sqlite3";
import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import {
  findMailboxContactPersonEntityId,
  type ContactIdentityStore,
  type MailboxContactInput,
} from "./ContactIdentityService";

const CONTACT_IDENTITY_METHODS = [
  "resolveMailboxContact",
  "getIdentity",
  "listIdentities",
  "findIdentityByCompanyHint",
  "listCandidates",
  "searchLinkTargets",
  "linkManualHandle",
  "getReplyTargets",
  "confirmCandidate",
  "rejectCandidate",
  "unlinkHandle",
  "getCoverageStats",
  "getChannelPreferenceSummary",
  "getTimeline",
] as const;

/**
 * Async facade for contact identities (async SQLite migration plan, DB6). `new
 * ContactIdentityService(db)` keeps its signature; every method runs one services-domain
 * unit over `ContactIdentityStore`. `resolveMailboxContact` first searches the host's
 * knowledge graph for the contact's person entity, then resolves in one unit.
 */
export type ContactIdentityService = Omit<
  AsyncStore<ContactIdentityStore, (typeof CONTACT_IDENTITY_METHODS)[number]>,
  "resolveMailboxContact"
> & {
  resolveMailboxContact(
    input: MailboxContactInput,
  ): ReturnType<AsyncStore<ContactIdentityStore, "resolveMailboxContact">["resolveMailboxContact"]>;
};
export const ContactIdentityService = serviceRepositoryFacade<
  ContactIdentityStore,
  (typeof CONTACT_IDENTITY_METHODS)[number]
>("contactIdentity_", CONTACT_IDENTITY_METHODS, {
  hooks: (facade) => {
    const resolve = facade.resolveMailboxContact;
    facade.resolveMailboxContact = async (input: MailboxContactInput) =>
      resolve(input, await findMailboxContactPersonEntityId(input));
  },
}) as unknown as new (db: Database.Database) => ContactIdentityService;
