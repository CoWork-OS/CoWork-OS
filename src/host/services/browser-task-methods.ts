import { AgentConfigSchema } from "../../electron/utils/validation";
import type { AgentConfig, Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { LLM_PROVIDER_TYPES } from "../../shared/types";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  resolveAccessProfileDefinitionWithStatus,
} from "../../shared/access-profiles";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import type { QueuedAttachmentBytes } from "../../electron/agent/runtime/queued-attachment-store";
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
import {
  parseBrowserTaskMediaDescriptors,
  releaseBrowserTaskMedia,
  resolveBrowserTaskMedia,
  type BrowserTaskMediaDescriptor,
  type BrowserTaskMediaReader,
} from "./browser-task-media";

type SafeAgentConfig = Pick<
  AgentConfig,
  | "accessProfileId"
  | "interactionMode"
  | "executionMode"
  | "taskDomain"
  | "chronicleMode"
  | "providerType"
  | "modelKey"
  | "llmProfile"
  | "llmProfileForced"
  | "permissionMode"
  | "shellAccess"
  | "integrationMentions"
  | "humanInputPolicy"
  | "allowUserInput"
  | "autonomousMode"
  | "collaborativeMode"
  | "verificationAgent"
  | "videoGenerationMode"
  | "multitaskMode"
  | "multitaskLaneCount"
  | "multitaskAssignmentMode"
  | "multiLlmMode"
  | "multiLlmConfig"
  | "researchWorkflow"
  | "qualityPasses"
>;

interface CreateTaskRequest {
  title: string;
  prompt: string;
  workspaceId: string;
  agentConfig: SafeAgentConfig;
  assignedAgentRoleId?: string;
  generateTitle?: true;
  images?: BrowserTaskMediaDescriptor[];
}

export interface BrowserTaskCommands {
  createTaskIdempotent(params: {
    operationKey: string;
    title: string;
    prompt: string;
    workspaceId: string;
    agentConfig: SafeAgentConfig;
    taskOverrides?: Partial<Task>;
    source: "api";
    requestIdentity: CreateTaskRequest;
    capturedAttachments?: QueuedAttachmentBytes[];
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
  mediaReader?: BrowserTaskMediaReader;
  /** Browser tasks may target active agent roles only. */
  isActiveAgentRole?: (id: string) => Promise<boolean> | boolean;
}

/** A narrow task surface that admits work through the existing durable queue. */
export function createBrowserTaskMethods(
  sources: BrowserTaskSources,
): Record<string, WebRpcMethod> {
  return {
    "task.create": {
      capability: "tasks.create",
      mutation: true,
      validateParams: parseBrowserCreateTaskRequest,
      handler: async (context, params) => {
        const request = params as CreateTaskRequest;
        const workspace = await sources.getWorkspace(request.workspaceId);
        if (!workspace || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
          throw new WebApplicationError("INVALID_REQUEST", "Workspace is unavailable.", 400);
        }
        if (request.assignedAgentRoleId) {
          const roleIsActive = await sources.isActiveAgentRole?.(request.assignedAgentRoleId);
          if (roleIsActive !== true) {
            throw new WebApplicationError("INVALID_REQUEST", "Agent role is unavailable.", 400);
          }
        }
        let capturedAttachments: Awaited<ReturnType<typeof resolveBrowserTaskMedia>> = [];
        if (request.images !== undefined) {
          if (request.images.length > 0 && !sources.mediaReader) throw invalidRequest();
          if (sources.mediaReader) {
            try {
              capturedAttachments = await resolveBrowserTaskMedia(
                sources.mediaReader,
                context,
                workspace.id,
                request.images,
              );
            } catch (error) {
              if (error instanceof WebApplicationError) throw error;
              throw new WebApplicationError(
                "INVALID_REQUEST",
                error instanceof Error ? error.message : "Visual attachment is invalid.",
                400,
              );
            }
          }
        }
        const taskRequest = { ...request };
        delete taskRequest.images;
        const requestIdentity = {
          ...taskRequest,
          ...(capturedAttachments.length > 0
            ? {
                images: capturedAttachments.map((attachment) => ({
                  relativePath: attachment.relativePath,
                  mimeType: attachment.mimeType,
                  filename: attachment.filename,
                  sizeBytes: attachment.sizeBytes,
                  sha256: attachment.sha256,
                  identity: attachment.identity,
                })),
              }
            : request.images !== undefined
              ? { images: [] }
              : {}),
        };
        const key = scopedOperationKey(context);
        try {
          let admitted: { task: Task; replayed: boolean };
          try {
            admitted = await sources.commands.createTaskIdempotent({
              operationKey: key,
              ...taskRequest,
              taskOverrides: request.assignedAgentRoleId
                ? { assignedAgentRoleId: request.assignedAgentRoleId }
                : undefined,
              source: "api",
              requestIdentity,
              ...(capturedAttachments.length > 0 ? { capturedAttachments } : {}),
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
        } finally {
          releaseBrowserTaskMedia(capturedAttachments);
        }
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

export function parseBrowserCreateTaskRequest(value: unknown): CreateTaskRequest {
  if (!isRecord(value)) throw invalidRequest();
  const allowed = new Set([
    "title",
    "prompt",
    "workspaceId",
    "agentConfig",
    "assignedAgentRoleId",
    "generateTitle",
    "images",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidRequest();
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
  if (value.generateTitle !== undefined && value.generateTitle !== true) throw invalidRequest();
  const images = parseBrowserTaskMediaDescriptors(value.images);

  const assignedAgentRoleId = value.assignedAgentRoleId;
  if (
    assignedAgentRoleId !== undefined &&
    (typeof assignedAgentRoleId !== "string" || !isUuid(assignedAgentRoleId))
  ) {
    throw invalidRequest();
  }

  const agentConfig = parseSafeAgentConfig(value.agentConfig);
  return {
    title,
    prompt,
    workspaceId,
    agentConfig,
    ...(assignedAgentRoleId ? { assignedAgentRoleId } : {}),
    ...(value.generateTitle === true ? { generateTitle: true } : {}),
    ...(images !== undefined ? { images } : {}),
  };
}

const BrowserTaskOptionsSchema = AgentConfigSchema.pick({
  permissionMode: true,
  shellAccess: true,
  integrationMentions: true,
  humanInputPolicy: true,
  allowUserInput: true,
  autonomousMode: true,
  collaborativeMode: true,
  verificationAgent: true,
  videoGenerationMode: true,
  multitaskMode: true,
  multitaskLaneCount: true,
  multitaskAssignmentMode: true,
  multiLlmMode: true,
  multiLlmConfig: true,
  researchWorkflow: true,
  qualityPasses: true,
}).strict();

function parseSafeAgentConfig(value: unknown): SafeAgentConfig {
  const record = value === undefined ? {} : value;
  if (!isRecord(record)) throw invalidRequest();
  const allowed = new Set([
    "accessProfileId",
    "interactionMode",
    "executionMode",
    "taskDomain",
    "chronicleMode",
    "providerType",
    "modelKey",
    "llmProfile",
    "llmProfileForced",
    "permissionMode",
    "shellAccess",
    "integrationMentions",
    "humanInputPolicy",
    "allowUserInput",
    "autonomousMode",
    "collaborativeMode",
    "verificationAgent",
    "videoGenerationMode",
    "multitaskMode",
    "multitaskLaneCount",
    "multitaskAssignmentMode",
    "multiLlmMode",
    "multiLlmConfig",
    "researchWorkflow",
    "qualityPasses",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw invalidRequest();

  const config: SafeAgentConfig = {
    accessProfileId: resolveAccessProfileId(record.accessProfileId),
  };

  if (record.interactionMode !== undefined) {
    if (!isRecord(record.interactionMode)) throw invalidRequest();
    const interaction = record.interactionMode;
    if (interaction.mode === "chat" && Object.keys(interaction).length === 1) {
      config.interactionMode = { mode: "chat" };
    } else if (
      interaction.mode === "smart" &&
      (interaction.executionOverride === undefined ||
        isExecutionModeOverride(interaction.executionOverride)) &&
      Object.keys(interaction).every((key) => key === "mode" || key === "executionOverride")
    ) {
      config.interactionMode = {
        mode: "smart",
        ...(interaction.executionOverride
          ? { executionOverride: interaction.executionOverride }
          : {}),
      };
    } else {
      throw invalidRequest();
    }
  }

  if (record.executionMode !== undefined) {
    if (!isExecutionMode(record.executionMode)) throw invalidRequest();
    config.executionMode = record.executionMode;
  }
  if (record.taskDomain !== undefined) {
    if (!isTaskDomain(record.taskDomain)) throw invalidRequest();
    config.taskDomain = record.taskDomain;
  }
  if (record.chronicleMode !== undefined) {
    if (!isChronicleMode(record.chronicleMode)) throw invalidRequest();
    config.chronicleMode = record.chronicleMode;
  }
  if (record.providerType !== undefined) {
    if (
      typeof record.providerType !== "string" ||
      !(LLM_PROVIDER_TYPES as readonly string[]).includes(record.providerType)
    ) {
      throw invalidRequest();
    }
    config.providerType = record.providerType as AgentConfig["providerType"];
  }
  if (record.modelKey !== undefined) {
    if (!isValidModelKey(record.modelKey)) throw invalidRequest();
    config.modelKey = record.modelKey;
  }
  if (record.llmProfile !== undefined) {
    if (record.llmProfile !== "strong" && record.llmProfile !== "cheap") throw invalidRequest();
    config.llmProfile = record.llmProfile;
  }
  if (record.llmProfileForced !== undefined) {
    if (typeof record.llmProfileForced !== "boolean") throw invalidRequest();
    config.llmProfileForced = record.llmProfileForced;
  }

  const additional = BrowserTaskOptionsSchema.safeParse(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key in BrowserTaskOptionsSchema.shape),
    ),
  );
  if (!additional.success) throw invalidRequest();
  return { ...config, ...additional.data };
}

function resolveAccessProfileId(value: unknown): SafeAgentConfig["accessProfileId"] {
  const profileId =
    value === undefined
      ? BUILTIN_ACCESS_PROFILE_IDS.askForApproval
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!profileId || profileId.length > 100) throw invalidRequest();
  const settings = PermissionSettingsManager.loadSettings();
  const resolution = resolveAccessProfileDefinitionWithStatus(
    profileId,
    settings.accessProfiles ?? [],
  );
  if (resolution.status !== "resolved") {
    throw new WebApplicationError("INVALID_REQUEST", "Access profile is unavailable.", 400);
  }
  return profileId as SafeAgentConfig["accessProfileId"];
}

function isExecutionMode(value: unknown): value is NonNullable<AgentConfig["executionMode"]> {
  return (
    value === "execute" ||
    value === "chat" ||
    value === "plan" ||
    value === "analyze" ||
    value === "verified" ||
    value === "debug"
  );
}

function isExecutionModeOverride(
  value: unknown,
): value is "execute" | "plan" | "analyze" | "debug" | "verified" {
  return (
    value === "execute" ||
    value === "plan" ||
    value === "analyze" ||
    value === "debug" ||
    value === "verified"
  );
}

function isTaskDomain(value: unknown): value is NonNullable<AgentConfig["taskDomain"]> {
  return (
    value === "auto" ||
    value === "code" ||
    value === "research" ||
    value === "operations" ||
    value === "writing" ||
    value === "general" ||
    value === "media"
  );
}

function isChronicleMode(value: unknown): value is NonNullable<AgentConfig["chronicleMode"]> {
  return value === "inherit" || value === "enabled" || value === "disabled";
}

function isValidModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
