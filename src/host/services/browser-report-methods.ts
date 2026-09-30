import type Database from "better-sqlite3";
import { z } from "zod";
import { WorkspaceRepository } from "../../electron/database/repository-facades";
import { getReportingReader } from "../../electron/database/async/runtime";
import { reportsStatements } from "../../electron/reports/reports-statement-port";
import { UsageInsightsService } from "../../electron/reports/UsageInsightsService";
import type { Workspace } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

const WORKSPACE_ID = z.string().trim().min(1).max(128);
const PERIOD_DAYS = z.number().finite().optional();

export interface BrowserReportDefinitionsOptions {
  db: Database.Database;
  resolveWorkspace?: (workspaceId: string) => Promise<Workspace | null>;
}

/** Read-only reports using the same reporting service and async reader as desktop IPC. */
export function createBrowserReportDefinitions({
  db,
  resolveWorkspace,
}: BrowserReportDefinitionsOptions): BrowserDesktopDefinitions {
  const workspaces = new WorkspaceRepository(db);

  const requireReportScope = async (workspaceId: string): Promise<string | null> => {
    if (workspaceId === "__all__") {
      if (resolveWorkspace) {
        const rows = await workspaces.findAll();
        for (const workspace of rows) {
          const scoped = await resolveWorkspace(workspace.id);
          if (!scoped?.permissions.read) {
            throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
          }
        }
      }
      return null;
    }
    if (resolveWorkspace) {
      const scoped = await resolveWorkspace(workspaceId);
      if (!scoped?.permissions.read) {
        throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
      }
    }
    return workspaceId;
  };

  return {
    getUsageInsights: {
      capability: "tasks.read",
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => {
        const workspaceId = WORKSPACE_ID.safeParse(args[0]);
        const periodDays = PERIOD_DAYS.safeParse(args[1]);
        if (!workspaceId.success || !periodDays.success) {
          throw new WebApplicationError("INVALID_REQUEST", "Invalid report request.", 400);
        }
        return [workspaceId.data, periodDays.data];
      },
      handler: async ([rawWorkspaceId, rawPeriodDays]) => {
        const workspaceId = await requireReportScope(rawWorkspaceId as string);
        const periodDays = Math.min(
          Math.max(Math.round((rawPeriodDays as number | undefined) ?? 7), 1),
          365,
        );
        const service = new UsageInsightsService(db);
        const reader = await getReportingReader();
        return reader
          ? service.generateInReader(reader, workspaceId, periodDays)
          : service.generate(workspaceId, periodDays);
      },
    },
    getUsageInsightsEarliest: {
      capability: "tasks.read",
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const workspaceId = WORKSPACE_ID.safeParse(args[0]);
        if (!workspaceId.success) {
          throw new WebApplicationError("INVALID_REQUEST", "Invalid report request.", 400);
        }
        return [workspaceId.data];
      },
      handler: async ([rawWorkspaceId]) => {
        const workspaceId = await requireReportScope(rawWorkspaceId as string);
        return reportsStatements(db).unit("usage_getEarliestActivityMs", [workspaceId]);
      },
    },
  };
}
