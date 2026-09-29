import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { ControlPlaneStore } from "./control-plane-sql";

/**
 * Control-plane transaction units (async SQLite migration plan, DB6): one per pure
 * `ControlPlaneStore` method. Methods that need the storage layer's host-side hooks or
 * the file system are not listed; the facade runs them on the host.
 */

const store = (db: Database.Database) => new ControlPlaneStore(db);

export const CONTROL_PLANE_READS = [
  "listCompanies",
  "getCompany",
  "getDefaultCompany",
  "listGoals",
  "getGoal",
  "listProjects",
  "getProject",
  "listProjectWorkspaces",
  "listIssues",
  "getIssue",
  "listIssueComments",
  "listAssignedIssues",
  "listRuns",
  "getRun",
  "getRunEvents",
  "summarizeCosts",
  "summarizeCostsByAgent",
  "summarizeCostsByProject",
] as const;

export const CONTROL_PLANE_WRITES = [
  "createGoal",
  "updateGoal",
  "createProject",
  "updateProject",
  "linkProjectWorkspace",
  "unlinkProjectWorkspace",
  "setPrimaryProjectWorkspace",
  "createIssue",
  "updateIssue",
  "createIssueComment",
  "releaseIssue",
  "checkoutIssueRows",
  "attachTaskRows",
  "recordRunEvent",
  "syncRunForTask",
] as const;

type Method = (typeof CONTROL_PLANE_READS)[number] | (typeof CONTROL_PLANE_WRITES)[number];

const reads = new Set<string>(CONTROL_PLANE_READS);
/** Cost summaries scan a scope's whole usage history: report-style reads. */
const reports = new Set<string>([
  "summarizeCosts",
  "summarizeCostsByAgent",
  "summarizeCostsByProject",
]);
export const CONTROL_PLANE_UNITS = Object.fromEntries(
  [...CONTROL_PLANE_READS, ...CONTROL_PLANE_WRITES].map((method: Method) => [
    `controlPlane_${method}`,
    storeUnit(store, method, { readonly: reads.has(method), report: reports.has(method) }),
  ]),
) as UnitCatalog;
