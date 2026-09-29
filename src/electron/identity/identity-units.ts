import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { ContactIdentityStore } from "./ContactIdentityService";

/**
 * Contact identity transaction units (async SQLite migration plan, DB6), in the services
 * domain: one per public method of `ContactIdentityStore`.
 */
export const IDENTITY_UNITS = {
  contactIdentity_resolveMailboxContact: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "resolveMailboxContact",
    {
      readonly: false,
    },
  ),
  contactIdentity_getIdentity: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "getIdentity",
    {
      readonly: true,
    },
  ),
  contactIdentity_listIdentities: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "listIdentities",
    {
      readonly: true,
    },
  ),
  contactIdentity_findIdentityByCompanyHint: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "findIdentityByCompanyHint",
    {
      readonly: true,
    },
  ),
  contactIdentity_listCandidates: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "listCandidates",
    {
      readonly: true,
    },
  ),
  contactIdentity_searchLinkTargets: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "searchLinkTargets",
    {
      readonly: true,
    },
  ),
  contactIdentity_linkManualHandle: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "linkManualHandle",
    {
      readonly: false,
    },
  ),
  contactIdentity_getReplyTargets: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "getReplyTargets",
    {
      readonly: true,
    },
  ),
  contactIdentity_confirmCandidate: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "confirmCandidate",
    {
      readonly: false,
    },
  ),
  contactIdentity_rejectCandidate: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "rejectCandidate",
    {
      readonly: false,
    },
  ),
  contactIdentity_unlinkHandle: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "unlinkHandle",
    {
      readonly: false,
    },
  ),
  contactIdentity_getCoverageStats: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "getCoverageStats",
    {
      readonly: true,
    },
  ),
  contactIdentity_getChannelPreferenceSummary: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "getChannelPreferenceSummary",
    {
      readonly: true,
    },
  ),
  contactIdentity_getTimeline: storeUnit(
    (db: Database.Database) => new ContactIdentityStore(db),
    "getTimeline",
    {
      readonly: true,
    },
  ),
} satisfies UnitCatalog;
