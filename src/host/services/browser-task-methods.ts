import type { Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";
import {
  TaskAdmissionConflictError,
  TaskAdmissionReceiptUnavailableError,
  type TaskAdmissionStatus,
} from "../../electron/control-plane/task-admission-service";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

interface CreateTaskRequest {
  title: string;
  prompt: string;
  workspaceId: string;
}

export interface BrowserTaskCommands {
  createTaskIdempotent(params: {
    operationKey: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: { accessProfileId: typeof BUILTIN_ACCESS_PROFILE_IDS.askForApproval };
    source: "api";
    requestIdentity: CreateTaskRequest;
    autoStart: false;
  }): Promise<{ task: Task; replayed: boolean }>;
  startAdmittedTask(operationKey: string, taskId: string): Promise<void>;
  getTaskAdmission(operationKey: string): Promise<TaskAdmissionStatus>;
}

export interface BrowserTaskSources {
  commands: Pick<
    BrowserTaskCommands,
    "createTaskIdempotent" | "startAdmittedTask" | "getTaskAdmission"
  >;
  getWorkspace: (id: string) => Promise<Workspace | null>;
}

/** A narrow task surface that admits work through the existing durable queue. */
export function createBrowserTaskMethods(
  sources: BrowserTaskSources,
): Record<string, WebRpcMethod> {
  return {
    "task.create": {
      capability: "tasks.create",
      mutation: true,
      validateParams: parseCreateTaskRequest,
      handler: async (context, params) => {
        const request = params as CreateTaskRequest;
        const workspace = await sources.getWorkspace(request.workspaceId);
        if (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
          throw new WebApplicationError("INVALID_REQUEST", "Workspace is unavailable.", 400);
        }
        const key = scopedOperationKey(context);
        let admitted: { task: Task; replayed: boolean };
        try {
          admitted = await sources.commands.createTaskIdempotent({
            operationKey: key,
            ...request,
            // Browser admission has no profile editor. Preserve the shared
            // composer's displayed approval boundary even if the host's
            // default profile is broader.
            agentConfig: { accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval },
            source: "api",
            requestIdentity: request,
            autoStart: false,
          });
        } catch (error) {
          if (error instanceof TaskAdmissionConflictError) {
            throw new WebApplicationError(
              "CONFLICT",
              "This task request key was already used.",
              409,
            );
          }
          if (error instanceof TaskAdmissionReceiptUnavailableError) {
            throw new WebApplicationError(
              "OUTCOME_UNKNOWN",
              "Task admission exists, but its task is unavailable.",
              503,
              true,
            );
          }
          throw error;
        }
        try {
          await sources.commands.startAdmittedTask(key, admitted.task.id);
        } catch {
          throw new WebApplicationError(
            "OUTCOME_UNKNOWN",
            "The task was admitted, but its start has not been confirmed. Retry with the same request key.",
            503,
            true,
          );
        }
        return {
          taskId: admitted.task.id,
          task: publicTask(admitted.task),
          replayed: admitted.replayed,
        };
      },
    },
    "task.admission.get": {
      capability: "tasks.create",
      validateParams: parseAdmissionLookup,
      handler: async (context, params) => {
        const key = scopedOperationKey(context, (params as { operationKey: string }).operationKey);
        const status = await sources.commands.getTaskAdmission(key);
        return status.found
          ? {
              found: true,
              taskId: status.taskId,
              task: status.task ? publicTask(status.task) : null,
            }
          : { found: false };
      },
    },
  };
}

function parseCreateTaskRequest(value: unknown): CreateTaskRequest {
  if (!isRecord(value)) throw invalidRequest();
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  if (
    !title ||
    title.length > 200 ||
    !prompt ||
    prompt.length > 64_000 ||
    !workspaceId ||
    workspaceId.length > 128
  ) {
    throw invalidRequest();
  }
  return { title, prompt, workspaceId };
}

function parseAdmissionLookup(value: unknown): { operationKey: string } {
  if (!isRecord(value) || !isValidOperationKey(value.operationKey)) throw invalidRequest();
  return { operationKey: value.operationKey };
}

function scopedOperationKey(context: WebRequestContext, key = context.operationKey): string {
  if (!isValidOperationKey(key)) throw invalidRequest();
  return `web:${context.audience}:${key}`;
}

function isValidOperationKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function publicTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid browser task request.", 400);
}
