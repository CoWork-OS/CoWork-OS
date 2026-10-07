import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { TeamsConversationReferenceStore } from "./TeamsConversationReferenceStore";
const make = (db: Database.Database) => new TeamsConversationReferenceStore(db);
export const TEAMS_REFERENCE_UNITS = {
  teamsReference_initialize: storeUnit(make, "initialize", { readonly: false }),
  teamsReference_policy: storeUnit(make, "policy", { readonly: true }),
  teamsReference_put: storeUnit(make, "put", { readonly: false }),
  teamsReference_get: storeUnit(make, "get", { readonly: true }),
};
