import type { Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { WebApplicationError, type WebRpcMethod } from "../web/WebApplication";

export interface BrowserDesktopReadSources {
  listWorkspaces: () => Promise<Workspace[]>;
  resolveWorkspace: (id: string) => Promise<Workspace | null>;
  getTask: (id: string) => Promise<Task | null>;
}

/** The shared renderer needs a few complete, policy-scoped host records. */
export function createBrowserDesktopReadMethods(
  sources: BrowserDesktopReadSources,
): Record<string, WebRpcMethod> {
  return {
    "desktop.workspace.list": {
      capability: "workspaces.read",
      handler: async () => {
        const raw = await sources.listWorkspaces();
        const resolved = await Promise.all(
          raw
            .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id))
            .map((workspace) => sources.resolveWorkspace(workspace.id)),
        );
        return {
          workspaces: resolved
            .filter((workspace): workspace is Workspace => Boolean(workspace?.permissions.read))
            .map(toBrowserWorkspace),
        };
      },
    },
    "desktop.task.get": {
      capability: "tasks.read",
      validateParams: parseTaskId,
      handler: async (_context, params) => {
        const task = await sources.getTask((params as { taskId: string }).taskId);
        if (!task) return { task: null };
        const workspace = await sources.resolveWorkspace(task.workspaceId);
        if (!workspace?.permissions.read || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
          throw new WebApplicationError("FORBIDDEN", "Task is unavailable.", 403);
        }
        return { task: toBrowserTask(task) };
      },
    },
  };
}

function parseTaskId(value: unknown): { taskId: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).taskId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test((value as { taskId: string }).taskId)
  ) {
    throw new WebApplicationError("INVALID_REQUEST", "Invalid task identifier.", 400);
  }
  return { taskId: (value as { taskId: string }).taskId };
}

function toBrowserWorkspace(workspace: Workspace): Workspace {
  const permissions = workspace.permissions;
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
    permissions: {
      read: permissions.read === true,
      write: permissions.write === true,
      delete: permissions.delete === true,
      network: permissions.network === true,
      shell: permissions.shell === true,
      accessProfileId: permissions.accessProfileId,
      accessProfileUnavailable: permissions.accessProfileUnavailable,
      accessProfileScoped: permissions.accessProfileScoped,
      accessFilesystemScoped: permissions.accessFilesystemScoped,
    },
  };
}

function toBrowserTask(task: Task): Task {
  if (typeof task.prompt !== "string" || task.prompt.length > 256 * 1024) {
    throw new WebApplicationError(
      "INVALID_REQUEST",
      "Task prompt is too large for this view.",
      413,
    );
  }
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    error: task.error,
    resultSummary: task.resultSummary,
    source: task.source,
    pinned: task.pinned,
    parentTaskId: task.parentTaskId,
    agentType: task.agentType,
    assignedAgentRoleId: task.assignedAgentRoleId,
    boardColumn: task.boardColumn,
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
    sessionId: task.sessionId,
    sessionArchived: task.sessionArchived,
    terminalStatus: task.terminalStatus,
    failureClass: task.failureClass,
    verificationVerdict: task.verificationVerdict,
    semanticSummary: task.semanticSummary,
    bestKnownOutcome: task.bestKnownOutcome,
    // The shared task composer must show the task's actual access boundary.
    // Expose only the profile identifier, not the full agent configuration.
    agentConfig: task.agentConfig?.accessProfileId
      ? { accessProfileId: task.agentConfig.accessProfileId }
      : undefined,
  };
}
