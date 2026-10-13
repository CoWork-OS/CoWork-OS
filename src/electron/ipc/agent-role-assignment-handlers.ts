/**
 * Assigning a session to an agent (`agentRole:assignToTask`, used by Mission Control).
 *
 * The assignment decides which agent's "May do alone" limit the session works under: the
 * daemon stamps the assigned role's limit on the session at its next start and removes it
 * when the new role has none (AgentDaemon.applyAgentRoleOverrides). So the renderer's ids
 * are validated, the caller must be allowed to manage the session, the same bar as stopping
 * or resuming it, and every reassignment is written to the session's audit log with the
 * access-limit change it makes.
 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type AgentRole, type Task } from "../../shared/types";
import type { AgentRoleRepository } from "../agents/agent-repository-facades";
import type { ActivityRepository } from "../activity/activity-repository-facades";
import type { TaskRepository } from "../database/repository-facades";
import type { SessionMembershipService } from "../workspaces/workspaces-repository-facades";
import { validateInput, UUIDSchema } from "../utils/validation";

export type AccessLimitChange = "unchanged" | "added" | "lifted" | "changed";

export interface AgentReassignmentAccessLimit {
  /** The session's own agent limit before the reassignment, if any. */
  previous?: string;
  /** The session's own agent limit after it, if any. */
  next?: string;
  change: AccessLimitChange;
}

function trimmedLimit(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The session's own agent limit before and after a reassignment, as the daemon applies it:
 * an assigned role's limit is stamped from the role and removed when the role has none; with
 * no role (unassigned, or a role that no longer exists) the stamped limit stays. Limits the
 * session inherited from the one that started it are never changed by a role, so they are
 * not part of this.
 */
export function describeAgentReassignmentAccessLimit(
  task: Pick<Task, "agentConfig">,
  previousRole: Pick<AgentRole, "accessProfileId"> | undefined,
  nextRole: Pick<AgentRole, "accessProfileId"> | undefined,
): AgentReassignmentAccessLimit {
  const stamped = trimmedLimit(task.agentConfig?.accessCeilingProfileId);
  const previous = previousRole ? trimmedLimit(previousRole.accessProfileId) : stamped;
  const next = nextRole ? trimmedLimit(nextRole.accessProfileId) : stamped;
  const change: AccessLimitChange =
    previous === next ? "unchanged" : !previous ? "added" : !next ? "lifted" : "changed";
  return { ...(previous ? { previous } : {}), ...(next ? { next } : {}), change };
}

export interface AgentRoleAssignmentDeps {
  /** Throws unless the caller holds `capability` on the session. */
  authorizeTask: (
    event: IpcMainInvokeEvent,
    taskId: string,
    capability: "manage",
  ) => Promise<{ actor: { principalId: string } }>;
  sessionMembershipService: Pick<SessionMembershipService, "recordTaskAction">;
  taskRepo: Pick<TaskRepository, "findById" | "update">;
  agentRoleRepo: Pick<AgentRoleRepository, "findById">;
  activityRepo: Pick<ActivityRepository, "create">;
  getMainWindow: () => BrowserWindow | null;
}

/** The handler, independent of Electron's registration (tests call it directly). */
export function createAgentRoleAssignmentHandler(deps: AgentRoleAssignmentDeps) {
  return async (
    event: IpcMainInvokeEvent,
    rawTaskId: unknown,
    rawAgentRoleId: unknown,
  ): Promise<{ success: true }> => {
    const taskId = validateInput(UUIDSchema, rawTaskId, "task ID");
    // Only an explicit null unassigns; anything else must be a role id.
    const agentRoleId =
      rawAgentRoleId === null ? null : validateInput(UUIDSchema, rawAgentRoleId, "agent role ID");
    const authorization = await deps.authorizeTask(event, taskId, "manage");

    const nextRole = agentRoleId ? await deps.agentRoleRepo.findById(agentRoleId) : undefined;
    if (agentRoleId && !nextRole) throw new Error("Agent role not found");
    const task = await deps.taskRepo.findById(taskId);
    if (!task) throw new Error("Task not found");
    const previousRoleId = task.assignedAgentRoleId;
    const previousRole = previousRoleId
      ? await deps.agentRoleRepo.findById(previousRoleId)
      : undefined;
    const accessLimit = describeAgentReassignmentAccessLimit(task, previousRole, nextRole);

    await deps.taskRepo.update(taskId, { assignedAgentRoleId: agentRoleId ?? undefined });

    await deps.sessionMembershipService.recordTaskAction(
      taskId,
      "manage",
      agentRoleId ? "task_agent_assigned" : "task_agent_unassigned",
      agentRoleId ?? previousRoleId ?? taskId,
      {
        previousAgentRoleId: previousRoleId ?? null,
        agentRoleId,
        accessLimitChange: accessLimit.change,
        previousAccessLimit: accessLimit.previous ?? null,
        accessLimit: accessLimit.next ?? null,
      },
      authorization.actor.principalId,
    );

    const activity = await deps.activityRepo.create({
      workspaceId: task.workspaceId,
      taskId,
      ...(agentRoleId ? { agentRoleId } : {}),
      actorType: "system",
      activityType: agentRoleId ? "agent_assigned" : "info",
      title: nextRole ? `Assigned to ${nextRole.displayName || "agent"}` : "Task unassigned",
      description: task.title,
    });
    deps.getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
      type: "created",
      activity,
    });
    return { success: true };
  };
}
