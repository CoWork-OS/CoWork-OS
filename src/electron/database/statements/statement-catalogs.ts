import { MAILBOX_STATEMENTS } from "../../mailbox/mailbox-statements";
import { MAILBOX_UNITS } from "../../mailbox/mailbox-units";
import { MEMORY_STATEMENTS } from "../../memory/memory-statements";
import { MEMORY_UNITS } from "../../memory/memory-units";
import { CONTROL_PLANE_UNITS } from "../../control-plane/control-plane-units";
import { CONTROL_PLANE_STATEMENTS } from "../../control-plane/control-plane-statements";
import { REPORTS_UNITS } from "../../reports/reports-units";
import { STORAGE_UNITS } from "../storage-units";
import { SERVICE_UNITS } from "../service-units";
import type { StatementCatalog, UnitCatalog } from "./statement-catalog";

/** Statement catalogs by domain, as the database worker loads them (DB6). */
export const STATEMENT_CATALOGS: Readonly<Record<string, StatementCatalog>> = {
  mailbox: MAILBOX_STATEMENTS,
  memory: MEMORY_STATEMENTS,
  controlPlane: CONTROL_PLANE_STATEMENTS,
  reports: {},
  storage: {},
  services: {},
};

/** Transaction units by domain (DB6); a domain without units lists none. */
export const STATEMENT_UNITS: Readonly<Record<string, UnitCatalog>> = {
  mailbox: MAILBOX_UNITS,
  memory: MEMORY_UNITS,
  controlPlane: CONTROL_PLANE_UNITS,
  reports: REPORTS_UNITS,
  storage: STORAGE_UNITS,
  services: SERVICE_UNITS,
};

export type StatementDomain = keyof typeof STATEMENT_CATALOGS;

/** Opt-in flag per domain; each also requires `COWORK_DB_WORKER=1`. */
export const STATEMENT_DOMAIN_FLAGS: Readonly<Record<string, string>> = {
  mailbox: "COWORK_DB_WORKER_MAILBOX",
  memory: "COWORK_DB_WORKER_MEMORY",
  controlPlane: "COWORK_DB_WORKER_CONTROL_PLANE",
  reports: "COWORK_DB_WORKER_REPORTS",
  storage: "COWORK_DB_WORKER_STORAGE",
  services: "COWORK_DB_WORKER_SERVICES",
};
