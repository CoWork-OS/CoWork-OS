import { BotWorkQueryService, parseBotWorkQuery } from "../../electron/agents/BotWorkQueryService";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { AgentTeamRunRepository } from "../../electron/agents/agent-repository-facades";
import type { AgentDaemon } from "../../electron/agent/daemon";
import {
  SkillRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../../electron/database/repository-facades";
import {
  TaskEventRepository,
  TaskSessionMetadataStore,
  TaskStore,
  WorkspaceStore,
  type TaskSessionMetadata,
} from "../../electron/database/repositories";
import { SessionRetentionService } from "../../electron/sessions/SessionRetentionService";
import {
  getCustomSkillLoader,
  type CustomSkillLoader,
} from "../../electron/agent/custom-skill-loader";
import { getActiveProfileId, getUserDataDir } from "../../electron/utils/user-data-dir";
import type { CustomSkill, Skill, StepFeedbackAction, Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { toBrowserTask } from "./browser-desktop-read-methods";
import { WebApplicationError } from "../web/WebApplication";

type AgentDaemonDependency = Partial<
  Pick<
    AgentDaemon,
    | "updateTaskWorkspace"
    | "resumeTask"
    | "handleStepFeedback"
    | "logEvent"
    | "wrapUpTask"
    | "ensureCollaborativeRunForParentTask"
    | "getTeamOrchestrator"
  >
>;

export interface BrowserCoreDefinitionsOptions {
  db: Database.Database;
  /** Kept alongside the task adapter factory for one host assembly contract. */
  agentDaemon: AgentDaemonDependency;
  /** The profile/admin-scoped resolver used by browser reads and file operations. */
  resolveWorkspace?: (workspaceId: string) => Promise<Workspace | null>;
  /** Narrow injection seam for focused tests; production uses the host loader singleton. */
  skillLoader?: Pick<CustomSkillLoader, "initialize" | "listTaskSkills">;
}

const WORKSPACE_PERMISSIONS: Workspace["permissions"] = {
  read: true,
  write: true,
  delete: false,
  network: true,
  shell: false,
};

/**
 * Browser-safe adapters for a small set of desktop session, workspace, and skill actions.
 * Methods use repositories/services directly and never accept an IPC channel, host path, or
 * arbitrary callback from the browser.
 */
export function createBrowserCoreDefinitions({
  db,
  agentDaemon,
  resolveWorkspace,
  skillLoader,
}: BrowserCoreDefinitionsOptions): BrowserDesktopDefinitions {
  // The desktop task admission surface is assembled next to these DB-backed methods and shares
  // this options shape. This factory intentionally does not call daemon operations itself.
  const tasks = new TaskRepository(db);
  const botWork = new BotWorkQueryService(db);
  const teamRuns = new AgentTeamRunRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const skills = new SkillRepository(db);
  const sessions = new SessionRetentionService(
    new TaskStore(db),
    new TaskEventRepository(db),
    new TaskSessionMetadataStore(db),
    new WorkspaceStore(db),
  );
  const loadSkillLoader = skillLoader ?? getCustomSkillLoader();
  const getEffectiveWorkspace =
    resolveWorkspace ??
    (async (workspaceId: string) => (await workspaces.findById(workspaceId)) ?? null);

  const definitions: BrowserDesktopDefinitions = {
    listProfiles: {
      capability: "workspaces.read",
      maxArgs: 0,
      handler: async () => {
        const id = getActiveProfileId();
        let label = id;
        try {
          const metadata = JSON.parse(
            await fs.readFile(path.join(getUserDataDir(), ".cowork-profile.json"), "utf8"),
          );
          if (metadata.id === id && typeof metadata.label === "string") label = metadata.label;
        } catch {
          /* A default or daemon profile may have no display metadata. */
        }
        return [{ id, label, isActive: true, isDefault: id === "default", userDataDir: "" }];
      },
    },
    touchWorkspace: {
      capability: "workspaces.read",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([id]) => [parseId(id)],
      handler: async ([id]) => {
        const workspace = await getEffectiveWorkspace(String(id));
        if (!workspace?.permissions.read)
          throw new WebApplicationError("FORBIDDEN", "Workspace is unavailable.");
        await workspaces.updateLastUsedAt(workspace.id);
        return null;
      },
    },
    renameTask: {
      capability: "tasks.create",
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: ([taskId, title]) => [parseId(taskId), parseTitle(title)],
      handler: async ([taskId, title]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, taskId as string);
        await tasks.update(task.id, { title: title as string });
        return undefined;
      },
    },
    toggleTaskPin: {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([taskId]) => [parseId(taskId)],
      handler: async ([taskId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, taskId as string);
        const updated = await tasks.togglePin(task.id);
        if (!updated) throw notFound();
        return publicTask(updated);
      },
    },
    archiveTask: {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([taskId]) => [parseId(taskId)],
      handler: async ([taskId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, taskId as string);
        const sessionId = task.sessionId || task.id;
        const sessionTasks = sessions.tasksForSession(sessionId, 10_000);
        for (const sessionTask of sessionTasks) {
          await requireWorkspaceAccess(getEffectiveWorkspace, sessionTask.workspaceId, true);
        }
        const result = sessions.archiveSession(sessionId);
        return {
          metadata: safeSessionMetadata(result.metadata),
          taskCount: result.taskCount,
        };
      },
    },
    createWorkspace: {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([request]) => [parseCreateWorkspaceRequest(request)],
      handler: async ([request]) =>
        createWorkspace(workspaces, getEffectiveWorkspace, request as CreateWorkspaceRequest),
    },
    listTaskSkills: {
      capability: "tasks.read",
      minArgs: 0,
      maxArgs: 0,
      handler: async () => {
        await loadSkillLoader.initialize();
        return loadSkillLoader.listTaskSkills().flatMap(toTaskSkillMetadata);
      },
    },
    listSkills: {
      capability: "tasks.read",
      minArgs: 0,
      maxArgs: 0,
      handler: async () => (await skills.findAll()).map(toSkillMetadata),
    },
    getSkill: {
      capability: "tasks.read",
      minArgs: 1,
      maxArgs: 1,
      validate: ([skillId]) => [parseId(skillId)],
      handler: async ([skillId]) => {
        const skill = await skills.findById(skillId as string);
        return skill ? toSkillMetadata(skill) : null;
      },
    },
    listBotWork: {
      capability: "tasks.read",
      minArgs: 1,
      maxArgs: 1,
      validate: ([query]) => [parseBotWorkQuery(query)],
      handler: async ([rawQuery]) => {
        const query = parseBotWorkQuery(rawQuery);
        await requireWorkspaceAccess(getEffectiveWorkspace, query.workspaceId, false);
        return botWork.list(query);
      },
    },
    listBotConversations: {
      capability: "tasks.read",
      minArgs: 1,
      maxArgs: 1,
      validate: ([query]) => [parseBotConversationQuery(query)],
      handler: async ([rawQuery]) => {
        const query = rawQuery as BotConversationQuery;
        const workspace = await requireWorkspaceAccess(
          getEffectiveWorkspace,
          query.workspaceId,
          false,
        );
        if (workspace.isTemp || isTempWorkspaceId(workspace.id)) throw workspaceUnavailable();
        const rows = await tasks.findBotConversations(query.workspaceId, {
          ...(query.agentRoleId ? { agentRoleId: query.agentRoleId } : {}),
          includeArchivedSessions: query.includeArchivedSessions,
          limit: query.limit,
          offset: query.offset,
          includeAllWorkspaces: false,
        });
        return rows.filter((task) => task.workspaceId === query.workspaceId).map(toBotConversation);
      },
    },
  };

  if (agentDaemon.updateTaskWorkspace) {
    definitions.updateTaskWorkspace = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: ([taskId, workspaceId]) => [parseId(taskId), parseId(workspaceId)],
      handler: async ([taskId, workspaceId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, String(taskId));
        const destination = await requireWorkspaceAccess(
          getEffectiveWorkspace,
          String(workspaceId),
          true,
        );
        if (task.workspaceId === destination.id) return toBrowserTask(task);
        const updated = await agentDaemon.updateTaskWorkspace!(task.id, destination.id);
        return toBrowserTask(updated);
      },
    };
  }

  if (agentDaemon.resumeTask) {
    definitions.resumeTask = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([taskId]) => [parseId(taskId)],
      handler: async ([taskId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, String(taskId));
        return agentDaemon.resumeTask!(task.id);
      },
    };
  }

  if (agentDaemon.ensureCollaborativeRunForParentTask) {
    definitions.findTeamRunByRootTask = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([taskId]) => [parseId(taskId)],
      handler: async ([taskId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, String(taskId));
        const run = agentDaemon.ensureCollaborativeRunForParentTask!(task.id);
        return run ? { ...run } : null;
      },
    };
  }

  if (agentDaemon.wrapUpTask) {
    definitions.wrapUpTask = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([taskId]) => [parseId(taskId)],
      handler: async ([taskId]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, String(taskId));
        await agentDaemon.wrapUpTask!(task.id);
        return { success: true };
      },
    };
  }

  if (agentDaemon.getTeamOrchestrator) {
    definitions.wrapUpTeamRun = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([runId]) => [parseId(runId)],
      handler: async ([runId]) => {
        const run = await teamRuns.findById(String(runId));
        if (!run) throw notFound();
        await requireWritableTask(tasks, getEffectiveWorkspace, run.rootTaskId);
        const orchestrator = agentDaemon.getTeamOrchestrator!();
        if (!orchestrator) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Team run controls are unavailable in this browser session.",
            501,
          );
        }
        await orchestrator.wrapUpRun(run.id);
        return { success: true };
      },
    };
  }

  if (agentDaemon.handleStepFeedback) {
    definitions.sendStepFeedback = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 3,
      maxArgs: 4,
      validate: parseStepFeedbackArgs,
      handler: async ([taskId, stepId, action, message]) => {
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, String(taskId));
        await agentDaemon.handleStepFeedback!(
          task.id,
          String(stepId),
          action as StepFeedbackAction,
          message as string | undefined,
        );
        return null;
      },
    };
  }

  if (agentDaemon.logEvent) {
    definitions.submitMessageFeedback = {
      capability: "tasks.create",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([value]) => [parseMessageFeedback(value)],
      handler: async ([value]) => {
        const feedback = value as MessageFeedbackRequest;
        const task = await requireWritableTask(tasks, getEffectiveWorkspace, feedback.taskId);
        const reason = [feedback.reason, feedback.note].filter(Boolean).join(": ") || undefined;
        agentDaemon.logEvent!(task.id, "user_feedback", {
          decision: feedback.decision,
          ...(reason ? { reason } : {}),
          ...(feedback.messageId ? { messageId: feedback.messageId } : {}),
        });
        return null;
      },
    };
  }

  return definitions;
}

interface MessageFeedbackRequest {
  taskId: string;
  messageId?: string;
  decision: "accepted" | "rejected";
  reason?: string;
  note?: string;
}

function parseMessageFeedback(value: unknown): MessageFeedbackRequest {
  const record = requireRecord(value);
  if (
    Object.keys(record).some(
      (key) => !["taskId", "messageId", "decision", "reason", "note"].includes(key),
    ) ||
    (record.decision !== "accepted" && record.decision !== "rejected")
  ) {
    throw invalidRequest();
  }
  const optionalText = (input: unknown, maxLength: number): string | undefined => {
    if (input === undefined) return undefined;
    if (typeof input !== "string" || input.length > maxLength) throw invalidRequest();
    return input;
  };
  return {
    taskId: parseId(record.taskId),
    decision: record.decision,
    ...(record.messageId !== undefined
      ? { messageId: parseBoundedText(record.messageId, 200) }
      : {}),
    ...(record.reason !== undefined ? { reason: optionalText(record.reason, 2_000) } : {}),
    ...(record.note !== undefined ? { note: optionalText(record.note, 4_000) } : {}),
  };
}

function parseStepFeedbackArgs(args: unknown[]): unknown[] {
  const [taskId, stepId, action, message] = args;
  if (
    args.length < 3 ||
    args.length > 4 ||
    typeof stepId !== "string" ||
    !stepId.trim() ||
    stepId.length > 100 ||
    !["retry", "skip", "stop", "drift"].includes(String(action)) ||
    (message !== undefined && (typeof message !== "string" || message.length > 64_000))
  ) {
    throw invalidRequest();
  }
  return [parseId(taskId), stepId, action as StepFeedbackAction, message];
}

function parseBoundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalidRequest();
  }
  return value.trim();
}

interface CreateWorkspaceRequest {
  name: string;
}

interface BotConversationQuery {
  workspaceId: string;
  agentRoleId?: string;
  includeArchivedSessions?: boolean;
  limit: number;
  offset: number;
}

function parseCreateWorkspaceRequest(value: unknown): CreateWorkspaceRequest {
  const record = requireRecord(value);
  const permissions = record.permissions;
  const validPermissions =
    permissions !== null &&
    typeof permissions === "object" &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 5 &&
    (permissions as Record<string, unknown>).read === true &&
    (permissions as Record<string, unknown>).write === true &&
    (permissions as Record<string, unknown>).delete === true &&
    (permissions as Record<string, unknown>).network === true &&
    (permissions as Record<string, unknown>).shell === false;
  if (
    Object.keys(record).some((key) => key !== "name" && key !== "path" && key !== "permissions") ||
    (record.path !== undefined && record.path !== "") ||
    (permissions !== undefined && !validPermissions) ||
    typeof record.name !== "string"
  ) {
    throw invalidRequest();
  }
  const name = record.name.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw invalidRequest();
  return { name };
}

function parseBotConversationQuery(value: unknown): BotConversationQuery {
  const record = requireRecord(value);
  const allowed = new Set([
    "workspaceId",
    "includeAllWorkspaces",
    "agentRoleId",
    "includeArchivedSessions",
    "limit",
    "offset",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw invalidRequest();
  if (record.includeAllWorkspaces === true) {
    throw new WebApplicationError("FORBIDDEN", "Bot conversations are workspace-scoped.", 403);
  }
  const workspaceId = parseId(record.workspaceId);
  const agentRoleId = record.agentRoleId === undefined ? undefined : parseId(record.agentRoleId);
  const includeArchivedSessions = record.includeArchivedSessions;
  if (includeArchivedSessions !== undefined && typeof includeArchivedSessions !== "boolean") {
    throw invalidRequest();
  }
  const limit = record.limit === undefined ? 100 : record.limit;
  const offset = record.offset === undefined ? 0 : record.offset;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  ) {
    throw invalidRequest();
  }
  return {
    workspaceId,
    ...(agentRoleId ? { agentRoleId } : {}),
    ...(includeArchivedSessions !== undefined ? { includeArchivedSessions } : {}),
    limit,
    offset,
  };
}

async function createWorkspace(
  repository: WorkspaceRepository,
  resolveWorkspace: (id: string) => Promise<Workspace | null>,
  request: CreateWorkspaceRequest,
): Promise<Workspace> {
  const userDataDirectory = path.resolve(getUserDataDir());
  const workspacesDirectory = path.join(userDataDirectory, "browser-workspaces");
  const pathSegment = `${slugify(request.name)}-${randomUUID()}`;
  const workspacePath = path.join(workspacesDirectory, pathSegment);
  try {
    await fs.mkdir(workspacesDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(workspacesDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("unsafe root");
    await fs.mkdir(workspacePath, { mode: 0o700 });
  } catch {
    throw new WebApplicationError(
      "HOST_UNAVAILABLE",
      "The host could not create this project workspace.",
      503,
      true,
    );
  }

  let created: Workspace | undefined;
  try {
    created = await repository.create(request.name, workspacePath, { ...WORKSPACE_PERMISSIONS });
    const effective = await resolveWorkspace(created.id);
    if (!effective?.permissions.read || !effective.permissions.write) {
      throw new WebApplicationError("FORBIDDEN", "The new workspace is unavailable.", 403);
    }
    return publicWorkspace(effective);
  } catch (error) {
    if (created) {
      try {
        await repository.delete(created.id);
      } catch {
        // Preserve the original failure. Removing the unique new path remains best effort.
      }
    }
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof WebApplicationError) throw error;
    throw new WebApplicationError(
      "HOST_UNAVAILABLE",
      "The host could not save this project workspace.",
      503,
      true,
    );
  }
}

async function requireWritableTask(
  repository: TaskRepository,
  resolveWorkspace: (id: string) => Promise<Workspace | null>,
  taskId: string,
): Promise<Task> {
  const task = await repository.findById(taskId);
  if (!task) throw notFound();
  await requireWorkspaceAccess(resolveWorkspace, task.workspaceId, true);
  return task;
}

async function requireWorkspaceAccess(
  resolveWorkspace: (id: string) => Promise<Workspace | null>,
  workspaceId: string,
  write: boolean,
): Promise<Workspace> {
  const workspace = await resolveWorkspace(workspaceId);
  if (
    !workspace ||
    !workspace.permissions.read ||
    (write && !workspace.permissions.write) ||
    workspace.isTemp ||
    isTempWorkspaceId(workspace.id)
  ) {
    throw workspaceUnavailable();
  }
  return workspace;
}

function publicWorkspace(workspace: Workspace): Workspace {
  const permissions = workspace.permissions;
  return {
    id: workspace.id,
    name: workspace.name,
    // Browser RPC consumers identify a workspace by id; the host filesystem path stays private.
    path: "",
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
    isTemp: false,
    permissions: {
      read: permissions.read === true,
      write: permissions.write === true,
      delete: permissions.delete === true,
      network: permissions.network === true,
      shell: permissions.shell === true,
      accessProfileId: permissions.accessProfileId,
      accessProfileScoped: permissions.accessProfileScoped,
      accessFilesystemScoped: permissions.accessFilesystemScoped,
    },
  };
}

function publicTask(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pinned: task.pinned,
  };
}

function safeSessionMetadata(metadata: TaskSessionMetadata): TaskSessionMetadata {
  return {
    sessionId: metadata.sessionId,
    name: metadata.name,
    archivedAt: metadata.archivedAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function toBotConversation(task: Task): Record<string, unknown> {
  if (task.prompt.length > 256 * 1024) {
    throw new WebApplicationError("INVALID_REQUEST", "Bot conversation is too large to list.", 413);
  }
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    userPrompt: task.userPrompt,
    sidebarPromptPreview: task.sidebarPromptPreview,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    resultSummary: task.resultSummary,
    source: task.source,
    pinned: task.pinned,
    parentTaskId: task.parentTaskId,
    agentType: task.agentType,
    assignedAgentRoleId: task.assignedAgentRoleId,
    sessionId: task.sessionId,
    sessionArchived: task.sessionArchived,
    branchFromTaskId: task.branchFromTaskId,
    branchLabel: task.branchLabel,
    terminalStatus: task.terminalStatus,
    failureClass: task.failureClass,
    agentConfig: {
      botConversation: true,
      ...(task.agentConfig?.accessProfileId
        ? { accessProfileId: task.agentConfig.accessProfileId }
        : {}),
      ...(task.agentConfig?.botTeamId ? { botTeamId: task.agentConfig.botTeamId } : {}),
    },
  };
}

function toSkillMetadata(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
  };
}

function toTaskSkillMetadata(skill: CustomSkill): Record<string, unknown>[] {
  if (typeof skill.prompt !== "string" || skill.prompt.length > 48_000) return [];
  return [
    {
      id: boundedText(skill.id, 200),
      name: boundedText(skill.name, 200),
      description: boundedText(skill.description, 2_000),
      icon: boundedText(skill.icon, 80),
      prompt: skill.prompt,
      parameters: Array.isArray(skill.parameters)
        ? skill.parameters.slice(0, 40).flatMap((parameter) => {
            if (
              !parameter ||
              typeof parameter.name !== "string" ||
              typeof parameter.type !== "string"
            ) {
              return [];
            }
            return [
              {
                name: boundedText(parameter.name, 100),
                type: boundedText(parameter.type, 30),
                description: boundedText(parameter.description, 500),
                required: parameter.required === true,
                ...(isScalar(parameter.default) ? { default: parameter.default } : {}),
                ...(Array.isArray(parameter.options)
                  ? {
                      options: parameter.options
                        .filter((option) => typeof option === "string")
                        .slice(0, 50)
                        .map((option) => boundedText(option, 200)),
                    }
                  : {}),
              },
            ];
          })
        : undefined,
      category: boundedText(skill.category, 120),
      enabled: skill.enabled !== false,
      priority: typeof skill.priority === "number" ? skill.priority : undefined,
      type: skill.type === "guideline" ? "guideline" : "task",
    },
  ];
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw invalidRequest();
  const title = value.trim();
  if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw invalidRequest();
  return title;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid browser action arguments.", 400);
}

function notFound(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "The requested task is unavailable.", 404);
}

function workspaceUnavailable(): WebApplicationError {
  return new WebApplicationError("FORBIDDEN", "The workspace is unavailable.", 403);
}
