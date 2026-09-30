import type Database from "better-sqlite3";
import { z } from "zod";
import { TaskRepository, WorkspaceRepository } from "../../electron/database/repository-facades";
import { ActivityRepository } from "../../electron/activity/activity-repository-facades";
import { ControlPlaneCoreService } from "../../electron/control-plane/ControlPlaneCoreService";
import { MissionControlIntelligenceService } from "../../electron/mission-control/mission-control-repository-facades";
import { ProactiveSuggestionsService } from "../../electron/agent/ProactiveSuggestionsService";
import type { AgentDaemon } from "../../electron/agent/daemon";
import type { Task, Workspace } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

const id = z.string().min(1).max(200);
const scope = z
  .object({ workspaceId: id.nullish(), companyId: id.nullish(), agentRoleId: id.nullish() })
  .strict();
const optionalArgs = <const T extends readonly z.ZodType[]>(schemas: T) =>
  z
    .array(z.unknown())
    .max(schemas.length)
    .transform(
      (args) =>
        schemas.map((schema, i) => schema.parse(args[i])) as {
          -readonly [K in keyof T]: z.output<T[K]>;
        },
    );

export function createBrowserPlanningDefinitions(options: {
  db: Database.Database;
  agentDaemon?: AgentDaemon;
  resolveWorkspace: (id: string) => Promise<Workspace | null>;
}): BrowserDesktopDefinitions {
  const core = new ControlPlaneCoreService(options.db);
  const intelligence = new MissionControlIntelligenceService(options.db);
  const activities = new ActivityRepository(options.db);
  const tasks = new TaskRepository(options.db);
  const workspaces = new WorkspaceRepository(options.db);
  const globalReads = new Set([
    "listCompanies",
    "listCompanyGoals",
    "listCompanyProjects",
    "listCompanyIssues",
    "listIssueComments",
    "listCompanyRuns",
    "listRunEvents",
    "getMissionControlItemEvidence",
  ]);
  const requireGlobalRead = async () => {
    for (const workspace of await workspaces.findAll()) {
      if (workspace.isTemp) continue;
      if (!(await options.resolveWorkspace(workspace.id))?.permissions.read)
        throw new WebApplicationError(
          "FORBIDDEN",
          "This overview includes a workspace that is unavailable to this browser.",
          403,
        );
    }
  };
  const definitions: BrowserDesktopDefinitions = {};
  const add = <T extends unknown[]>(
    name: string,
    schema: z.ZodType<T>,
    handler: (args: T) => unknown,
    mutation = false,
  ) => {
    definitions[name] = {
      capability: mutation ? "tasks.create" : "reports.read",
      mutation,
      validate: (args) => schema.parse(args) as unknown[],
      handler: async (args) => {
        if (globalReads.has(name)) await requireGlobalRead();
        return handler(args as T);
      },
    };
  };
  const requireWorkspace = async (workspaceId: string, write = false) => {
    const workspace = await options.resolveWorkspace(workspaceId);
    if (!workspace?.permissions.read || (write && !workspace.permissions.write)) {
      throw new WebApplicationError(
        "FORBIDDEN",
        "This workspace is unavailable for that action.",
        403,
      );
    }
    return workspace;
  };
  const checkScope = async (request: z.infer<typeof scope> | undefined) => {
    if (request?.workspaceId) await requireWorkspace(request.workspaceId);
    else await requireGlobalRead();
    return request ?? {};
  };
  add("listCompanies", z.tuple([]), () => core.listCompanies());
  add("listCompanyGoals", z.tuple([id]), ([companyId]) => core.listGoals(companyId));
  add("listCompanyProjects", z.tuple([id]), ([companyId]) => core.listProjects({ companyId }));
  add(
    "listCompanyIssues",
    optionalArgs([id, z.number().int().min(1).max(500).optional()]),
    ([companyId, limit]) => core.listIssues({ companyId, limit }),
  );
  add("listIssueComments", z.tuple([id]), ([issueId]) => core.listIssueComments(issueId));
  add(
    "listCompanyRuns",
    optionalArgs([id, id.optional(), z.number().int().min(1).max(100).optional()]),
    ([companyId, issueId, limit]) => core.listRuns({ companyId, issueId, limit }),
  );
  add("listRunEvents", z.tuple([id]), ([runId]) => core.getRunEvents(runId));
  add("getMissionControlBrief", optionalArgs([scope.optional()]), async ([request]) =>
    intelligence.getBrief(await checkScope(request)),
  );
  add(
    "listMissionControlItems",
    optionalArgs([
      scope
        .extend({
          categories: z
            .array(z.enum(["attention", "work", "reviews", "learnings", "awareness", "evidence"]))
            .max(6)
            .optional(),
          severities: z
            .array(z.enum(["action_needed", "monitor_only", "successful", "failed"]))
            .max(4)
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
        .optional(),
    ]),
    async ([request]) => {
      await checkScope(request);
      return intelligence.listItems(request ?? {});
    },
  );
  add("getMissionControlItemEvidence", z.tuple([id]), ([itemId]) =>
    intelligence.getEvidence(itemId),
  );
  add(
    "refreshMissionControl",
    optionalArgs([scope.optional()]),
    async ([request]) => intelligence.refresh(await checkScope(request)),
    true,
  );
  add("getQueueStatus", z.tuple([]), () => {
    if (!options.agentDaemon)
      throw new WebApplicationError("UNSUPPORTED_CAPABILITY", "The task runtime is unavailable.");
    return options.agentDaemon.getQueueStatus();
  });
  add(
    "listActivities",
    z.tuple([
      z
        .object({
          workspaceId: id,
          taskId: id.optional(),
          agentRoleId: id.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).max(10000).optional(),
          isRead: z.boolean().optional(),
          isPinned: z.boolean().optional(),
        })
        .strict(),
    ]),
    async ([request]) => {
      await requireWorkspace(request.workspaceId);
      return activities.list(request);
    },
  );
  const updateTask = async (
    taskId: string,
    operation: (taskId: string) => Promise<Task | undefined>,
  ) => {
    const task = await tasks.findById(taskId);
    if (!task) throw new WebApplicationError("INVALID_REQUEST", "This task no longer exists.");
    await requireWorkspace(task.workspaceId, true);
    return operation(taskId);
  };
  add(
    "moveTaskToColumn",
    z.tuple([id, z.enum(["backlog", "todo", "in_progress", "review", "done"])]),
    ([taskId, boardColumn]) => updateTask(taskId, (id) => tasks.moveToColumn(id, boardColumn)),
    true,
  );
  add(
    "setTaskPriority",
    z.tuple([id, z.number().int().min(0).max(4)]),
    ([taskId, priority]) => updateTask(taskId, (id) => tasks.setPriority(id, priority)),
    true,
  );
  add(
    "setTaskDueDate",
    z.tuple([id, z.number().int().positive().nullable()]),
    ([taskId, dueDate]) => updateTask(taskId, (id) => tasks.setDueDate(id, dueDate)),
    true,
  );
  add(
    "setTaskEstimate",
    z.tuple([id, z.number().int().min(1).max(100000).nullable()]),
    ([taskId, estimatedMinutes]) =>
      updateTask(taskId, (id) => tasks.setEstimate(id, estimatedMinutes)),
    true,
  );
  add("listSuggestions", z.tuple([id]), async ([workspaceId]) => {
    await requireWorkspace(workspaceId);
    return ProactiveSuggestionsService.listActive(workspaceId);
  });
  const workspaceIds = z.array(id).max(100);
  add("listSuggestionsForWorkspaces", z.tuple([workspaceIds]), async ([ids]) => {
    const unique = [...new Set<string>(ids)];
    await Promise.all(unique.map((workspaceId) => requireWorkspace(workspaceId)));
    if (!unique.length) return [];
    const suggestions = await ProactiveSuggestionsService.listActive(unique[0], undefined, unique);
    return unique.map((workspaceId) => ({
      workspaceId,
      suggestions: suggestions.filter((item) => item.workspaceId === workspaceId),
    }));
  });
  add(
    "refreshSuggestions",
    z.tuple([id]),
    async ([workspaceId]) => {
      await requireWorkspace(workspaceId, true);
      await ProactiveSuggestionsService.generateAll(workspaceId);
      return { success: true };
    },
    true,
  );
  add(
    "refreshSuggestionsForWorkspaces",
    z.tuple([workspaceIds]),
    async ([ids]) => {
      const uniqueIds = [...new Set<string>(ids)];
      for (const workspaceId of uniqueIds) await requireWorkspace(workspaceId, true);
      for (const workspaceId of uniqueIds)
        await ProactiveSuggestionsService.generateAll(workspaceId);
      return { success: true };
    },
    true,
  );
  add(
    "dismissSuggestion",
    z.tuple([id, id]),
    async ([workspaceId, suggestionId]) => {
      await requireWorkspace(workspaceId, true);
      return { success: await ProactiveSuggestionsService.dismiss(workspaceId, suggestionId) };
    },
    true,
  );
  add(
    "snoozeSuggestion",
    z.tuple([id, id, z.number().int().positive()]),
    async ([workspaceId, suggestionId, until]) => {
      await requireWorkspace(workspaceId, true);
      return {
        success: await ProactiveSuggestionsService.snooze(workspaceId, suggestionId, until),
      };
    },
    true,
  );
  add(
    "editSuggestion",
    z.tuple([id, id, z.string().trim().min(1).max(4000)]),
    async ([workspaceId, suggestionId, prompt]) => {
      await requireWorkspace(workspaceId, true);
      return {
        success: await ProactiveSuggestionsService.recordEditedAction(
          workspaceId,
          suggestionId,
          prompt,
        ),
      };
    },
    true,
  );
  add(
    "actOnSuggestion",
    z.tuple([id, id]),
    async ([workspaceId, suggestionId]) => {
      await requireWorkspace(workspaceId, true);
      return { actionPrompt: await ProactiveSuggestionsService.actOn(workspaceId, suggestionId) };
    },
    true,
  );
  return definitions;
}
