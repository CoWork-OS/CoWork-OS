import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  AgentConfig,
  AgentRole,
  AgentWorkspaceMembership,
  AgentWorkspacePermissionSnapshot,
  ApprovalType,
  AgentToolRestrictions,
  ConvertAgentRoleToManagedAgentRequest,
  ConvertAutomationProfileToManagedAgentRequest,
  CreateManagedAgentRoutineRequest,
  AudioSummaryConfig,
  AudioSummaryResult,
  GatewayContextType,
  InputRequestResponse,
  UpdateManagedAgentRoutineRequest,
  ManagedAgentAuditEntry,
  ManagedAgentChannelTarget,
  ManagedAgentConversionResult,
  ManagedAgentFileRef,
  ManagedAgentInsights,
  ManagedAgentLinkedRoutineRef,
  ManagedAgentApprovalPolicy,
  ManagedAgentMemoryConfig,
  ManagedAgentRoutineRecord,
  ManagedAgentRoutineTriggerConfig,
  ManagedAgentRuntimeToolCatalog,
  ManagedAgentRuntimeToolCatalogEntry,
  ManagedAgentScheduleConfig,
  ManagedAgentStudioConfig,
  ManagedAgentToolFamily,
  ManagedSessionWorkpaper,
  ManagedSessionEventType,
  OperationalAutonomyPolicy,
  Workspace,
} from "../../shared/types";
import type {
  ManagedAgent,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  ManagedSessionEvent,
  ManagedSessionInputContent,
  ManagedSessionStatus,
  Task,
  TaskEvent,
} from "../../shared/types";
import { deriveCanonicalTaskStatus, isTerminalTaskStatus } from "../../shared/task-status";
import { isComputerUseToolName } from "../../shared/computer-use-contract";
import type { AgentDaemon } from "../agent/daemon";
import type { LLMTool } from "../agent/llm/types";
import { ToolRegistry } from "../agent/tools/registry";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { AutomationProfileRepository } from "../agents/AutomationProfileRepository";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamMemberRepository } from "../agents/AgentTeamMemberRepository";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import {
  ArtifactRepository,
  ChannelRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../database/repositories";
import { createMediaPlaybackUrl } from "../media";
import { MCPSettingsManager } from "../mcp/settings";
import { ManagedAccountManager } from "../accounts/managed-account-manager";
import { getVoiceService } from "../voice/VoiceService";
import { ImageGenProfileService } from "./ImageGenProfileService";
import type { RoutineService } from "../routines/service";
import type { Routine, RoutineTrigger } from "../routines/types";
import {
  ManagedAgentRepository,
  ManagedAgentVersionRepository,
  ManagedEnvironmentRepository,
  ManagedSessionEventRepository,
  ManagedSessionRepository,
} from "./repositories";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slugifyName(value: string): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "managed-agent";
}

function getStudioConfig(version: ManagedAgentVersion): ManagedAgentStudioConfig | undefined {
  const metadata = isRecord(version.metadata) ? version.metadata : undefined;
  const studio = metadata?.studio;
  return isRecord(studio) ? (studio as ManagedAgentStudioConfig) : undefined;
}

function roleMirrorsManagedAgent(role: AgentRole | undefined, agentId: string): boolean {
  if (!role?.soul) return false;
  try {
    const parsed = JSON.parse(role.soul) as unknown;
    return isRecord(parsed) && parsed.managedAgentId === agentId;
  } catch {
    return false;
  }
}

function setStudioConfigMetadata(
  metadata: Record<string, unknown> | undefined,
  studio: ManagedAgentStudioConfig,
): Record<string, unknown> {
  return {
    ...(metadata || {}),
    studio,
  };
}

function listManagedFileRefs(
  fileRefs: ManagedAgentFileRef[] | undefined,
  environment: ManagedEnvironment | undefined,
): string[] {
  const fromStudio = (fileRefs || []).map((file) => file.path).filter(Boolean);
  const fromEnvironment = environment?.config.filePaths || [];
  return Array.from(new Set([...fromStudio, ...fromEnvironment]));
}

function toMemoryToolRestrictions(
  memoryConfig?: ManagedAgentMemoryConfig,
): AgentToolRestrictions | undefined {
  if (memoryConfig?.mode !== "disabled") return undefined;
  return {
    deniedTools: [
      "search_quotes",
      "search_sessions",
      "memory_topics_load",
      "memory_save",
      "memory_curate",
      "memory_curated_read",
      "supermemory_profile",
      "supermemory_search",
      "supermemory_remember",
      "supermemory_forget",
    ],
  };
}

function toManagedApprovalTypes(
  approvalPolicy?: ManagedAgentApprovalPolicy,
): ApprovalType[] {
  const requested = new Set(approvalPolicy?.requireApprovalFor || []);
  const allowed = new Set<ApprovalType>();

  if (approvalPolicy?.autoApproveReadOnly !== false) {
    allowed.add("network_access");
  }
  if (!requested.has("edit spreadsheet")) {
    allowed.add("data_export");
  }
  return Array.from(allowed);
}

function toManagedAutonomyPolicy(
  approvalPolicy?: ManagedAgentApprovalPolicy,
): OperationalAutonomyPolicy | undefined {
  if (!approvalPolicy) return undefined;
  return {
    preset: "manual",
    autoApproveTypes: toManagedApprovalTypes(approvalPolicy),
    allowUserInput: true,
    pauseForRequiredDecision: true,
  };
}

function deriveCapabilities(
  templateId: string | undefined,
): import("../../shared/types").AgentCapability[] {
  switch (templateId) {
    case "team-chat-qna":
    case "customer-reply-drafter":
    case "inbox-follow-up-assistant":
      return ["communicate", "research", "document"];
    case "morning-planner":
    case "chief-of-staff":
      return ["manage", "plan", "communicate"];
    case "bug-triage":
      return ["review", "analyze", "document"];
    case "research-analyst":
      return ["research", "analyze", "document"];
    default:
      return ["research", "plan", "document"];
  }
}

const MANAGED_EVENT_MAX_STRING_CHARS = 2000;
const MANAGED_EVENT_MAX_ARRAY_ITEMS = 50;
const MANAGED_EVENT_MAX_OBJECT_KEYS = 50;
const MANAGED_EVENT_MAX_DEPTH = 3;
const MANAGED_EVENT_SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;
const MANAGED_EVENT_ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

export function sanitizeManagedEventPayload(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MANAGED_EVENT_MAX_DEPTH) return "[... truncated ...]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const maxChars = key === "message" ? 12000 : MANAGED_EVENT_MAX_STRING_CHARS;
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const next = value
      .slice(0, MANAGED_EVENT_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeManagedEventPayload(item, depth + 1));
    if (value.length > MANAGED_EVENT_MAX_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MANAGED_EVENT_MAX_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const nextKey of keys.slice(0, MANAGED_EVENT_MAX_OBJECT_KEYS)) {
      if (MANAGED_EVENT_ALWAYS_REDACT_KEY_RE.test(nextKey) || MANAGED_EVENT_SENSITIVE_KEY_RE.test(nextKey)) {
        out[nextKey] = "[REDACTED]";
        continue;
      }
      out[nextKey] = sanitizeManagedEventPayload(obj[nextKey], depth + 1, nextKey);
    }
    if (keys.length > MANAGED_EVENT_MAX_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MANAGED_EVENT_MAX_OBJECT_KEYS;
    }
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

function toManagedSessionStatus(task?: Task, hasPendingInput = false): ManagedSessionStatus {
  if (!task) return "failed";
  if (hasPendingInput) return "awaiting_input";
  switch (deriveCanonicalTaskStatus(task)) {
    case "pending":
    case "queued":
    case "planning":
      return "pending";
    case "paused":
    case "blocked":
      return "awaiting_input";
    case "executing":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function mapTaskEventType(event: TaskEvent): ManagedSessionEventType {
  const effectiveType = event.legacyType || event.type;
  switch (effectiveType) {
    case "assistant_message":
      return "assistant.message";
    case "tool_call":
      return "tool.call";
    case "tool_result":
      return "tool.result";
    case "input_request_created":
      return "input.requested";
    case "task_completed":
      return "session.completed";
    case "task_status":
      return "status.changed";
    case "error":
      return "session.failed";
    default:
      return "task.event.bridge";
  }
}

function normalizeManagedSessionEventPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  return sanitizeManagedEventPayload(payload) as Record<string, unknown>;
}

export function resolveManagedAllowedMcpTools(
  environmentConfig: Pick<ManagedEnvironment["config"], "allowedMcpServerIds">,
): string[] {
  const serverIds = environmentConfig.allowedMcpServerIds || [];
  if (serverIds.length === 0) return [];
  const settings = MCPSettingsManager.loadSettings();
  const prefix = settings.toolNamePrefix || "mcp_";
  const out = new Set<string>();
  for (const serverId of serverIds) {
    const server = MCPSettingsManager.getServer(serverId);
    if (!server) {
      throw new Error(`Managed environment references unknown MCP server: ${serverId}`);
    }
    if (!Array.isArray(server.tools) || server.tools.length === 0) {
      throw new Error(
        `Managed environment requires MCP server "${serverId}" tool metadata, but none is available`,
      );
    }
    for (const tool of server.tools) {
      if (tool?.name) out.add(`${prefix}${tool.name}`);
    }
  }
  if (out.size === 0) {
    throw new Error("Managed environment MCP allowlist resolved to zero tools");
  }
  return Array.from(out);
}

function cloneWorkspaceForManagedEnvironment(
  workspace: Workspace,
  environment: ManagedEnvironment,
): Workspace {
  return {
    ...workspace,
    permissions: {
      ...workspace.permissions,
      shell: Boolean(workspace.permissions.shell && environment.config.enableShell),
    },
  };
}

function deriveManagedToolFamily(tool: LLMTool): ManagedAgentToolFamily | undefined {
  const toolName = tool.name;
  const capabilityTags = tool.runtime?.capabilityTags || [];

  if (toolName === "run_command" || capabilityTags.includes("shell")) return "shell";
  if (toolName.startsWith("browser_") || capabilityTags.includes("browser")) return "browser";
  if (isComputerUseToolName(toolName)) return "computer-use";
  if (
    toolName.startsWith("memory_") ||
    toolName.startsWith("supermemory_") ||
    toolName === "search_memories" ||
    toolName === "search_quotes" ||
    toolName === "search_sessions" ||
    capabilityTags.includes("memory")
  ) {
    return "memory";
  }
  if (
    toolName === "generate_image" ||
    toolName === "analyze_image" ||
    toolName === "batch_image_process" ||
    toolName.startsWith("canvas_") ||
    toolName.startsWith("visual_") ||
    toolName.startsWith("video_")
  ) {
    return "images";
  }
  if (
    toolName === "read_pdf_visual" ||
    toolName.startsWith("document_") ||
    toolName.startsWith("pdf_") ||
    toolName.startsWith("docx_")
  ) {
    return "documents";
  }
  if (
    toolName.startsWith("read_") ||
    toolName.startsWith("write_") ||
    toolName.startsWith("edit_") ||
    toolName.startsWith("list_") ||
    toolName.startsWith("get_file_") ||
    toolName.startsWith("search_files") ||
    toolName === "glob" ||
    toolName === "grep" ||
    toolName.startsWith("copy_") ||
    toolName.startsWith("rename_") ||
    toolName.startsWith("create_directory") ||
    toolName.startsWith("delete_file") ||
    toolName.startsWith("scratchpad_") ||
    toolName.startsWith("git_")
  ) {
    return "files";
  }
  if (
    toolName === "web_fetch" ||
    toolName === "web_search" ||
    toolName === "http_request" ||
    tool.runtime?.resultKind === "search"
  ) {
    return "search";
  }
  if (
    toolName.startsWith("mcp_") ||
    toolName.endsWith("_action") ||
    toolName === "voice_call" ||
    toolName.startsWith("gmail_") ||
    toolName.startsWith("mailbox_") ||
    toolName.startsWith("channel_") ||
    toolName.startsWith("google_calendar_") ||
    toolName.startsWith("apple_calendar_") ||
    toolName.startsWith("apple_reminders_") ||
    toolName.startsWith("email_")
  ) {
    return "communication";
  }
  return undefined;
}

function toolMatchesManagedFamily(tool: LLMTool, family: ManagedAgentToolFamily): boolean {
  return deriveManagedToolFamily(tool) === family;
}

function isToolEnabledForManagedEnvironment(
  tool: LLMTool,
  environment: ManagedEnvironment,
  allowedMcpTools: Set<string>,
): boolean {
  if (environment.config.enableBrowser === false && tool.name.startsWith("browser_")) {
    return false;
  }
  if (!environment.config.enableComputerUse && isComputerUseToolName(tool.name)) {
    return false;
  }
  if (tool.name.startsWith("mcp_") && allowedMcpTools.size > 0 && !allowedMcpTools.has(tool.name)) {
    return false;
  }
  const allowedFamilies = environment.config.allowedToolFamilies || [];
  if (allowedFamilies.length === 0) return true;
  return allowedFamilies.some((family) => toolMatchesManagedFamily(tool, family));
}

function deriveApprovalBehavior(
  tool: LLMTool,
  approvalType: ApprovalType | null,
  autoApproveTypes: Set<ApprovalType>,
): ManagedAgentRuntimeToolCatalogEntry["approvalBehavior"] {
  if (approvalType) {
    return autoApproveTypes.has(approvalType) ? "auto_approve" : "require_approval";
  }
  if (tool.runtime?.approvalKind === "workspace_policy") {
    return "workspace_policy";
  }
  return "no_approval";
}

function mapRuntimeToolCatalogEntry(
  tool: LLMTool,
  approvalType: ApprovalType | null,
  autoApproveTypes: Set<ApprovalType>,
  mcpServerName: string | null,
): ManagedAgentRuntimeToolCatalogEntry {
  return {
    name: tool.name,
    description: tool.description,
    readOnly: tool.runtime?.readOnly ?? false,
    approvalKind: tool.runtime?.approvalKind || "none",
    approvalType,
    approvalBehavior: deriveApprovalBehavior(tool, approvalType, autoApproveTypes),
    sideEffectLevel: tool.runtime?.sideEffectLevel || "none",
    resultKind: tool.runtime?.resultKind || "generic",
    capabilityTags: tool.runtime?.capabilityTags || [],
    exposure: tool.runtime?.exposure || "conditional",
    family: deriveManagedToolFamily(tool),
    mcpServerName,
  };
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizePrincipalId(value?: string): string {
  return value?.trim() || "local-user";
}

function getWorkspaceRoleRank(role: import("../../shared/types").AgentWorkspaceRole): number {
  switch (role) {
    case "viewer":
      return 0;
    case "operator":
      return 1;
    case "builder":
      return 2;
    case "publisher":
      return 3;
    case "admin":
    default:
      return 4;
  }
}

function getPermissionSnapshot(
  workspaceId: string,
  principalId: string,
  role: import("../../shared/types").AgentWorkspaceRole | undefined,
): AgentWorkspacePermissionSnapshot {
  if (!role) {
    return {
      workspaceId,
      principalId,
      role: "viewer",
      canViewAgents: false,
      canRunAgents: false,
      canResumeSessions: false,
      canAnswerApprovals: false,
      canEditDrafts: false,
      canManageEnvironments: false,
      canPublishAgents: false,
      canManageRoutines: false,
      canManageMemberships: false,
      canAuditAgents: false,
    };
  }
  const rank = getWorkspaceRoleRank(role);
  return {
    workspaceId,
    principalId,
    role,
    canViewAgents: rank >= 0,
    canRunAgents: rank >= 1,
    canResumeSessions: rank >= 1,
    canAnswerApprovals: rank >= 1,
    canEditDrafts: rank >= 2,
    canManageEnvironments: rank >= 2,
    canPublishAgents: rank >= 3,
    canManageRoutines: rank >= 3,
    canManageMemberships: rank >= 4,
    canAuditAgents: rank >= 4,
  };
}

function summarizeRoutineTrigger(trigger: ManagedAgentRoutineTriggerConfig): string {
  switch (trigger.type) {
    case "schedule":
      return trigger.cadenceMinutes ? `Every ${trigger.cadenceMinutes} min` : "Scheduled";
    case "api":
      return trigger.path ? `API: ${trigger.path}` : "API trigger";
    case "channel_event":
      return trigger.channelType || "Channel event";
    case "mailbox_event":
      return trigger.provider || "Mailbox event";
    case "github_event":
      return trigger.repository || "GitHub event";
    case "connector_event":
      return trigger.connectorId || "Connector event";
    case "manual":
    default:
      return "Manual";
  }
}

export class ManagedSessionService {
  private readonly taskRepo: TaskRepository;
  private readonly taskEventRepo: TaskEventRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly artifactRepo: ArtifactRepository;
  private readonly inputRequestRepo: InputRequestRepository;
  private readonly channelRepo: ChannelRepository;
  private readonly managedAgentRepo: ManagedAgentRepository;
  private readonly managedAgentVersionRepo: ManagedAgentVersionRepository;
  private readonly managedEnvironmentRepo: ManagedEnvironmentRepository;
  private readonly managedSessionRepo: ManagedSessionRepository;
  private readonly managedSessionEventRepo: ManagedSessionEventRepository;
  private readonly teamRepo: AgentTeamRepository;
  private readonly teamMemberRepo: AgentTeamMemberRepository;
  private readonly teamRunRepo: AgentTeamRunRepository;
  private readonly teamItemRepo: AgentTeamItemRepository;
  private readonly agentRoleRepo: AgentRoleRepository;
  private readonly automationProfileRepo: AutomationProfileRepository;
  private readonly imageGenProfileService: ImageGenProfileService;

  constructor(
    private readonly db: import("better-sqlite3").Database,
    private readonly agentDaemon: AgentDaemon,
    private readonly options: {
      getRoutineService?: () => RoutineService | null;
    } = {},
  ) {
    this.ensureGovernanceSchema();
    this.taskRepo = new TaskRepository(db);
    this.taskEventRepo = new TaskEventRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.channelRepo = new ChannelRepository(db);
    this.managedAgentRepo = new ManagedAgentRepository(db);
    this.managedAgentVersionRepo = new ManagedAgentVersionRepository(db);
    this.managedEnvironmentRepo = new ManagedEnvironmentRepository(db);
    this.managedSessionRepo = new ManagedSessionRepository(db);
    this.managedSessionEventRepo = new ManagedSessionEventRepository(db);
    this.teamRepo = new AgentTeamRepository(db);
    this.teamMemberRepo = new AgentTeamMemberRepository(db);
    this.teamRunRepo = new AgentTeamRunRepository(db);
    this.teamItemRepo = new AgentTeamItemRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.automationProfileRepo = new AutomationProfileRepository(db);
    this.imageGenProfileService = new ImageGenProfileService();
  }

  private ensureGovernanceSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workspace_memberships (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspace_memberships_unique
        ON agent_workspace_memberships(workspace_id, principal_id);
      CREATE TABLE IF NOT EXISTS managed_agent_audit (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_managed_agent_audit_agent
        ON managed_agent_audit(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_managed_agent_audit_workspace
        ON managed_agent_audit(workspace_id, created_at DESC);
    `);
  }

  private resolveWorkspaceIdForAgent(agentId: string): string | undefined {
    const detail = this.getAgent(agentId);
    const studio = detail?.currentVersion ? getStudioConfig(detail.currentVersion) : undefined;
    const environmentId = studio?.defaultEnvironmentId;
    if (environmentId) {
      const environment = this.getEnvironment(environmentId);
      if (environment?.config.workspaceId) return environment.config.workspaceId;
    }
    const latestSession = this.listSessions({ limit: 200 }).find((session) => session.agentId === agentId);
    return latestSession?.workspaceId;
  }

  private getStoredWorkspaceRole(
    workspaceId: string,
    principalId = normalizePrincipalId(),
  ): import("../../shared/types").AgentWorkspaceRole | undefined {
    this.ensureWorkspaceMembershipSeeded(workspaceId);
    const row = this.db
      .prepare(
        `SELECT role
         FROM agent_workspace_memberships
         WHERE workspace_id = ? AND principal_id = ?`,
      )
      .get(workspaceId, principalId) as { role?: string } | undefined;
    const role = row?.role;
    if (
      role === "viewer" ||
      role === "operator" ||
      role === "builder" ||
      role === "publisher" ||
      role === "admin"
    ) {
      return role;
    }
    return undefined;
  }

  private ensureWorkspaceMembershipSeeded(workspaceId: string): void {
    const membershipCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_workspace_memberships
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as { count?: number } | undefined;
    if ((membershipCount?.count || 0) > 0) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_workspace_memberships
         (id, workspace_id, principal_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), workspaceId, normalizePrincipalId(), "admin", now, now);
  }

  private assertWorkspacePermission(
    workspaceId: string,
    check:
      | "canViewAgents"
      | "canRunAgents"
      | "canResumeSessions"
      | "canAnswerApprovals"
      | "canEditDrafts"
      | "canManageEnvironments"
      | "canPublishAgents"
      | "canManageRoutines"
      | "canManageMemberships"
      | "canAuditAgents",
    principalId = normalizePrincipalId(),
  ): void {
    const snapshot = this.getMyWorkspacePermissions(workspaceId, principalId);
    if (!snapshot[check]) {
      throw new Error(`Workspace role ${snapshot.role} does not permit ${check}`);
    }
  }

  getMyWorkspacePermissions(
    workspaceId: string,
    _principalId = normalizePrincipalId(),
  ): AgentWorkspacePermissionSnapshot {
    const principalId = normalizePrincipalId();
    return getPermissionSnapshot(
      workspaceId,
      principalId,
      this.getStoredWorkspaceRole(workspaceId, principalId),
    );
  }

  listWorkspaceMemberships(workspaceId?: string): AgentWorkspaceMembership[] {
    if (workspaceId) {
      this.ensureWorkspaceMembershipSeeded(workspaceId);
    } else {
      for (const workspace of this.workspaceRepo.findAll()) {
        this.ensureWorkspaceMembershipSeeded(workspace.id);
      }
    }
    const rows = (workspaceId
      ? this.db
          .prepare(
            `SELECT * FROM agent_workspace_memberships
             WHERE workspace_id = ?
             ORDER BY updated_at DESC`,
          )
          .all(workspaceId)
      : this.db
          .prepare(
            `SELECT * FROM agent_workspace_memberships
             ORDER BY updated_at DESC`,
          )
          .all()) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      principalId: String(row.principal_id),
      role: String(row.role) as import("../../shared/types").AgentWorkspaceRole,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }));
  }

  updateWorkspaceMembership(input: {
    workspaceId: string;
    principalId: string;
    role: import("../../shared/types").AgentWorkspaceRole;
  }): AgentWorkspaceMembership {
    this.assertWorkspacePermission(input.workspaceId, "canManageMemberships");
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT * FROM agent_workspace_memberships
         WHERE workspace_id = ? AND principal_id = ?`,
      )
      .get(input.workspaceId, input.principalId) as Any | undefined;
    const id = existing?.id ? String(existing.id) : randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_workspace_memberships
         (id, workspace_id, principal_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, principal_id) DO UPDATE SET
           role = excluded.role,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.workspaceId,
        input.principalId,
        input.role,
        existing?.created_at ? Number(existing.created_at) : now,
        now,
      );
    const membership = this.listWorkspaceMemberships(input.workspaceId).find((entry) => entry.id === id);
    if (!membership) {
      throw new Error("Failed to persist workspace membership");
    }
    this.appendAudit({
      agentId: `workspace:${input.workspaceId}`,
      workspaceId: input.workspaceId,
      action: "membership_updated",
      summary: `Updated ${input.principalId} to ${input.role}`,
      metadata: { principalId: input.principalId, role: input.role },
    });
    return membership;
  }

  listAuditEntries(agentId: string, limit = 50): ManagedAgentAuditEntry[] {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canAuditAgents");
    const rows = this.db
      .prepare(
        `SELECT * FROM managed_agent_audit
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agentId, limit) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      workspaceId: String(row.workspace_id),
      actorId: String(row.actor_id),
      action: String(row.action) as ManagedAgentAuditEntry["action"],
      summary: String(row.summary),
      metadata: safeJsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined),
      createdAt: Number(row.created_at || 0),
    }));
  }

  private appendAudit(input: {
    agentId: string;
    workspaceId: string;
    action: ManagedAgentAuditEntry["action"];
    summary: string;
    metadata?: Record<string, unknown>;
    actorId?: string;
  }): ManagedAgentAuditEntry {
    const entry: ManagedAgentAuditEntry = {
      id: randomUUID(),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      actorId: normalizePrincipalId(input.actorId),
      action: input.action,
      summary: input.summary,
      metadata: input.metadata,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO managed_agent_audit
         (id, agent_id, workspace_id, actor_id, action, summary, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.agentId,
        entry.workspaceId,
        entry.actorId,
        entry.action,
        entry.summary,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.createdAt,
      );
    return entry;
  }

  listAgents(params?: { limit?: number; offset?: number; status?: ManagedAgent["status"] }): ManagedAgent[] {
    return this.managedAgentRepo.list(params);
  }

  getAgent(agentId: string): { agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | undefined {
    const agent = this.managedAgentRepo.findById(agentId);
    if (!agent) return undefined;
    return {
      agent,
      currentVersion: this.managedAgentVersionRepo.find(agentId, agent.currentVersion),
    };
  }

  private mapManagedAgentRoutineRow(agentId: string, row: Any): ManagedAgentRoutineRecord {
    const definition = safeJsonParse<Routine | null>(row.definition_json, null);
    const triggers = Array.isArray(definition?.triggers)
      ? (definition?.triggers as RoutineTrigger[])
      : safeJsonParse<RoutineTrigger[]>(row.triggers_json, []);
    const trigger = triggers[0];
    const executionTarget = definition?.executionTarget;
    const outputKinds = Array.isArray(definition?.outputs)
      ? definition.outputs.map((output) => output.kind)
      : ["task_only"];

    const normalizedTrigger: ManagedAgentRoutineTriggerConfig = {
      id: trigger?.id,
      type: (trigger?.type || "manual") as ManagedAgentRoutineTriggerConfig["type"],
      enabled: trigger?.enabled !== false,
      cadenceMinutes:
        trigger?.type === "schedule" && trigger.schedule?.kind === "every"
          ? Math.max(15, Math.round((trigger.schedule.everyMs || 3_600_000) / 60_000))
          : undefined,
      path: trigger?.type === "api" ? trigger.path : undefined,
      connectorId: trigger?.type === "connector_event" ? trigger.connectorId : undefined,
      changeType: trigger?.type === "connector_event" ? trigger.changeType : undefined,
      resourceUriContains:
        trigger?.type === "connector_event" ? trigger.resourceUriContains : undefined,
      channelType: trigger?.type === "channel_event" ? trigger.channelType : undefined,
      chatId: trigger?.type === "channel_event" ? trigger.chatId : undefined,
      textContains: trigger?.type === "channel_event" ? trigger.textContains : undefined,
      senderContains: trigger?.type === "channel_event" ? trigger.senderContains : undefined,
      eventType: trigger?.type === "mailbox_event" ? trigger.eventType : undefined,
      subjectContains: trigger?.type === "mailbox_event" ? trigger.subjectContains : undefined,
      provider: trigger?.type === "mailbox_event" ? trigger.provider : undefined,
      labelContains: trigger?.type === "mailbox_event" ? trigger.labelContains : undefined,
      eventName: trigger?.type === "github_event" ? trigger.eventName : undefined,
      repository: trigger?.type === "github_event" ? trigger.repository : undefined,
      action: trigger?.type === "github_event" ? trigger.action : undefined,
      ref: trigger?.type === "github_event" ? trigger.ref : undefined,
    };

    return {
      id: String(row.id),
      agentId,
      name: String(row.name || ""),
      description: row.description ? String(row.description) : undefined,
      enabled: Boolean(row.enabled),
      workspaceId: String(row.workspace_id || ""),
      environmentId:
        executionTarget?.kind === "managed_environment"
          ? executionTarget.managedEnvironmentId
          : undefined,
      trigger: normalizedTrigger,
      outputKinds,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  listManagedAgentRoutines(agentId: string): ManagedAgentRoutineRecord[] {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canViewAgents");
    const rows = this.db
      .prepare(
        `SELECT * FROM automation_routines
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as Any[];
    return rows
      .map((row) => {
        const definition = safeJsonParse<Routine | null>(row.definition_json, null);
        const metadata = definition?.contextBindings?.metadata || {};
        if (metadata.managedAgentId !== agentId) return null;
        return this.mapManagedAgentRoutineRow(agentId, row);
      })
      .filter((entry): entry is ManagedAgentRoutineRecord => Boolean(entry));
  }

  buildManagedAgentRoutineDefinition(
    request: CreateManagedAgentRoutineRequest | UpdateManagedAgentRoutineRequest,
  ): {
    name?: string;
    description?: string;
    enabled?: boolean;
    workspaceId: string;
    environmentId: string;
    trigger: ManagedAgentRoutineTriggerConfig;
    instructions: string;
  } {
    const detail = this.getAgent(request.agentId);
    if (!detail?.agent || !detail.currentVersion) {
      throw new Error(`Managed agent not found: ${request.agentId}`);
    }
    const studio = getStudioConfig(detail.currentVersion);
    const environmentId = studio?.defaultEnvironmentId;
    if (!environmentId) {
      throw new Error("Managed agent needs a default environment before routines can be configured");
    }
    const environment = this.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`Managed environment not found: ${environmentId}`);
    }
    this.assertWorkspacePermission(environment.config.workspaceId, "canManageRoutines");
    const trigger = ("trigger" in request && request.trigger
      ? request.trigger
      : undefined) as ManagedAgentRoutineTriggerConfig | undefined;
    if (!trigger?.type) {
      throw new Error("Routine trigger type is required");
    }
    const workflowBrief = studio?.workflowBrief?.trim();
    return {
      name: "name" in request ? request.name : undefined,
      description: "description" in request ? request.description : undefined,
      enabled: "enabled" in request ? request.enabled : undefined,
      workspaceId: environment.config.workspaceId,
      environmentId,
      trigger: {
        enabled: true,
        ...trigger,
      },
      instructions:
        workflowBrief ||
        detail.currentVersion.systemPrompt ||
        `Run the configured workflow for ${detail.agent.name}.`,
    };
  }

  private updateCurrentStudioConfig(
    agentId: string,
    mutate: (studio: ManagedAgentStudioConfig, version: ManagedAgentVersion) => ManagedAgentStudioConfig,
  ): ManagedAgentVersion {
    const detail = this.getAgent(agentId);
    if (!detail?.currentVersion) {
      throw new Error(`Managed agent not found: ${agentId}`);
    }
    const currentStudio = getStudioConfig(detail.currentVersion) || {};
    const nextStudio = mutate(currentStudio, detail.currentVersion);
    const updated = this.managedAgentVersionRepo.updateMetadata(
      detail.currentVersion.agentId,
      detail.currentVersion.version,
      setStudioConfigMetadata(detail.currentVersion.metadata, nextStudio),
    );
    return updated || detail.currentVersion;
  }

  syncManagedAgentRoutineRefs(agentId: string): ManagedAgentLinkedRoutineRef[] {
    const routines = this.listManagedAgentRoutines(agentId);
    const linkedRoutines = routines.map((routine) => ({
      routineId: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      triggerTypes: [routine.trigger.type],
      summary: summarizeRoutineTrigger(routine.trigger),
    }));
    this.updateCurrentStudioConfig(agentId, (studio) => ({
      ...studio,
      routineIds: linkedRoutines.map((entry) => entry.routineId),
      linkedRoutines,
      scheduleSummary:
        linkedRoutines
          .filter((entry) => entry.enabled)
          .map((entry) => entry.summary)
          .filter(Boolean)
          .join(" · ") || undefined,
    }));
    return linkedRoutines;
  }

  private setRoutineEnabledInDb(routineId: string, enabled: boolean): void {
    const row = this.db
      .prepare("SELECT * FROM automation_routines WHERE id = ?")
      .get(routineId) as Any | undefined;
    if (!row) return;
    const definition = safeJsonParse<Routine | null>(row.definition_json, null);
    if (!definition) {
      this.db
        .prepare("UPDATE automation_routines SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, Date.now(), routineId);
      return;
    }
    const nextDefinition = { ...definition, enabled, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE automation_routines
         SET enabled = ?, definition_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, JSON.stringify(nextDefinition), nextDefinition.updatedAt, routineId);
  }

  private async setRoutineEnabled(routineId: string, enabled: boolean): Promise<void> {
    const routineService = this.options.getRoutineService?.() || null;
    if (routineService) {
      const updated = await routineService.update(routineId, { enabled });
      if (updated) return;
    }
    this.setRoutineEnabledInDb(routineId, enabled);
  }

  getRuntimeToolCatalog(agentId: string): ManagedAgentRuntimeToolCatalog {
    const agentDetail = this.getAgent(agentId);
    if (!agentDetail?.agent) {
      throw new Error(`Managed agent not found: ${agentId}`);
    }
    const version = agentDetail.currentVersion;
    if (!version) {
      throw new Error(`Managed agent version missing: ${agentId}@${agentDetail.agent.currentVersion}`);
    }
    const studio = getStudioConfig(version);
    const environmentId = studio?.defaultEnvironmentId;
    if (!environmentId) {
      return {
        agentId,
        chatgpt: [],
        slack: [],
      };
    }
    const environment = this.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`Managed environment not found: ${environmentId}`);
    }
    const workspace = this.workspaceRepo.findById(environment.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${environment.config.workspaceId}`);
    }
    const managedWorkspace = cloneWorkspaceForManagedEnvironment(workspace, environment);
    const agentConfig = this.buildAgentConfig(environment, version);
    const autoApproveTypes = new Set<ApprovalType>(
      (agentConfig.autoApproveTypes || []).filter((entry): entry is ApprovalType => Boolean(entry)),
    );
    const allowedMcpTools = new Set<string>(this.resolveAllowedMcpTools(environment));
    const buildSurfaceCatalog = (gatewayContext?: GatewayContextType) => {
      const registry = new ToolRegistry(
        managedWorkspace,
        this.agentDaemon,
        `managed-agent-catalog:${agentId}:${gatewayContext || "chatgpt"}`,
        gatewayContext,
        agentConfig.toolRestrictions,
      );
      const tools = registry
        .getTools()
        .filter((tool) => isToolEnabledForManagedEnvironment(tool, environment, allowedMcpTools));
      return tools.map((tool) =>
        mapRuntimeToolCatalogEntry(
          tool,
          registry.getApprovalType(tool.name),
          autoApproveTypes,
          registry.getMcpServerName(tool.name),
        ),
      );
    };

    return {
      agentId,
      environmentId,
      chatgpt: buildSurfaceCatalog(),
      slack: buildSurfaceCatalog("group"),
    };
  }

  createAgent(input: {
    name: string;
    description?: string;
    systemPrompt: string;
    executionMode: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }): { agent: ManagedAgent; version: ManagedAgentVersion } {
    const id = randomUUID();
    const agent = this.managedAgentRepo.create({
      id,
      name: input.name,
      description: input.description,
      status: "draft",
      currentVersion: 1,
    });
    const version: ManagedAgentVersion = {
      agentId: id,
      version: 1,
      model: input.model,
      systemPrompt: input.systemPrompt,
      executionMode: input.executionMode,
      runtimeDefaults: input.runtimeDefaults,
      skills: input.skills,
      mcpServers: input.mcpServers,
      teamTemplate: input.teamTemplate,
      metadata: input.metadata,
      createdAt: Date.now(),
    };
    this.managedAgentVersionRepo.create(version);
    const syncedVersion = this.syncLegacyMirror(agent, version);
    const workspaceId =
      getStudioConfig(syncedVersion)?.defaultEnvironmentId
        ? this.getEnvironment(getStudioConfig(syncedVersion)?.defaultEnvironmentId || "")?.config.workspaceId
        : undefined;
    if (workspaceId) {
      this.appendAudit({
        agentId: agent.id,
        workspaceId,
        action: "created",
        summary: `Created managed agent ${agent.name}`,
      });
    }
    return { agent, version: syncedVersion };
  }

  updateAgent(
    agentId: string,
    input: {
      name?: string;
      description?: string;
      systemPrompt?: string;
      executionMode?: ManagedAgentVersion["executionMode"];
      model?: ManagedAgentVersion["model"];
      runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
      skills?: string[];
      mcpServers?: string[];
      teamTemplate?: ManagedAgentVersion["teamTemplate"];
      metadata?: Record<string, unknown>;
    },
  ): { agent: ManagedAgent; version: ManagedAgentVersion } {
    const existing = this.managedAgentRepo.findById(agentId);
    if (!existing) throw new Error(`Managed agent not found: ${agentId}`);
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) {
      this.assertWorkspacePermission(workspaceId, "canEditDrafts");
    }
    const currentVersion = this.managedAgentVersionRepo.find(agentId, existing.currentVersion);
    if (!currentVersion) {
      throw new Error(`Managed agent version missing: ${agentId}@${existing.currentVersion}`);
    }
    const nextVersion = existing.currentVersion + 1;
    const agent = this.managedAgentRepo.update(agentId, {
      name: input.name,
      description: input.description,
      currentVersion: nextVersion,
    });
    if (!agent) throw new Error(`Managed agent not found: ${agentId}`);
    const version: ManagedAgentVersion = {
      agentId,
      version: nextVersion,
      model: input.model ?? currentVersion.model,
      systemPrompt: input.systemPrompt ?? currentVersion.systemPrompt,
      executionMode: input.executionMode ?? currentVersion.executionMode,
      runtimeDefaults: input.runtimeDefaults ?? currentVersion.runtimeDefaults,
      skills: input.skills ?? currentVersion.skills,
      mcpServers: input.mcpServers ?? currentVersion.mcpServers,
      teamTemplate: input.teamTemplate ?? currentVersion.teamTemplate,
      metadata: input.metadata ?? currentVersion.metadata,
      createdAt: Date.now(),
    };
    this.managedAgentVersionRepo.create(version);
    const syncedVersion = this.syncLegacyMirror(agent, version, getStudioConfig(currentVersion));
    if (workspaceId) {
      this.appendAudit({
        agentId,
        workspaceId,
        action: "updated",
        summary: `Updated managed agent ${agent.name}`,
      });
    }
    return { agent, version: syncedVersion };
  }

  async archiveAgent(agentId: string): Promise<ManagedAgent | undefined> {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canPublishAgents");
    const agent = this.managedAgentRepo.update(agentId, { status: "archived" });
    if (!agent) return undefined;
    const routines = this.listManagedAgentRoutines(agentId);
    for (const routine of routines) {
      await this.setRoutineEnabled(routine.id, false);
    }
    const detail = this.getAgent(agentId);
    if (detail?.currentVersion) {
      this.syncLegacyMirror(agent, detail.currentVersion, getStudioConfig(detail.currentVersion));
    }
    if (workspaceId) {
      this.appendAudit({
        agentId,
        workspaceId,
        action: "archived",
        summary: `Archived managed agent ${agent.name}`,
      });
    }
    this.syncManagedAgentRoutineRefs(agentId);
    return agent;
  }

  async publishAgent(agentId: string): Promise<ManagedAgent | undefined> {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canPublishAgents");
    const agent = this.managedAgentRepo.update(agentId, { status: "active" });
    if (!agent) return undefined;
    const detail = this.getAgent(agentId);
    const studio = detail?.currentVersion ? getStudioConfig(detail.currentVersion) : undefined;
    for (const routine of this.listManagedAgentRoutines(agentId)) {
      await this.setRoutineEnabled(routine.id, routine.trigger.enabled !== false);
    }
    if (detail?.currentVersion) {
      this.syncLegacyMirror(agent, detail.currentVersion, studio);
    }
    if (workspaceId) {
      this.appendAudit({
        agentId,
        workspaceId,
        action: "published",
        summary: `Published managed agent ${agent.name}`,
      });
    }
    this.syncManagedAgentRoutineRefs(agentId);
    return agent;
  }

  async suspendAgent(agentId: string): Promise<ManagedAgent | undefined> {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canPublishAgents");
    const agent = this.managedAgentRepo.update(agentId, { status: "suspended" });
    if (!agent) return undefined;
    const detail = this.getAgent(agentId);
    const currentVersion = detail?.currentVersion;
    const studio = currentVersion ? getStudioConfig(currentVersion) : undefined;
    for (const routine of this.listManagedAgentRoutines(agentId)) {
      await this.setRoutineEnabled(routine.id, false);
    }
    if (currentVersion) {
      this.syncLegacyMirror(agent, currentVersion, studio);
    }
    if (workspaceId) {
      this.appendAudit({
        agentId,
        workspaceId,
        action: "suspended",
        summary: `Suspended managed agent ${agent.name}`,
      });
    }
    this.syncManagedAgentRoutineRefs(agentId);
    return agent;
  }

  listAgentVersions(agentId: string): ManagedAgentVersion[] {
    return this.managedAgentVersionRepo.list(agentId);
  }

  getAgentVersion(agentId: string, version: number): ManagedAgentVersion | undefined {
    return this.managedAgentVersionRepo.find(agentId, version);
  }

  listEnvironments(params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }): ManagedEnvironment[] {
    return this.managedEnvironmentRepo.list(params);
  }

  getEnvironment(environmentId: string): ManagedEnvironment | undefined {
    return this.managedEnvironmentRepo.findById(environmentId);
  }

  createEnvironment(input: {
    name: string;
    kind?: ManagedEnvironment["kind"];
    config: ManagedEnvironment["config"];
  }): ManagedEnvironment {
    if (!this.workspaceRepo.findById(input.config.workspaceId)) {
      throw new Error(`Workspace not found: ${input.config.workspaceId}`);
    }
    this.assertWorkspacePermission(input.config.workspaceId, "canManageEnvironments");
    this.validateManagedAccountRefs(input.config.managedAccountRefs);
    return this.managedEnvironmentRepo.create({
      id: randomUUID(),
      name: input.name,
      kind: input.kind || "cowork_local",
      revision: 1,
      status: "active",
      config: input.config,
    });
  }

  updateEnvironment(
    environmentId: string,
    input: { name?: string; config?: ManagedEnvironment["config"] },
  ): ManagedEnvironment | undefined {
    const existing = this.managedEnvironmentRepo.findById(environmentId);
    if (!existing) return undefined;
    const nextConfig = input.config ? { ...existing.config, ...input.config } : undefined;
    if (nextConfig?.workspaceId && !this.workspaceRepo.findById(nextConfig.workspaceId)) {
      throw new Error(`Workspace not found: ${nextConfig.workspaceId}`);
    }
    this.assertWorkspacePermission(
      nextConfig?.workspaceId || existing.config.workspaceId,
      "canManageEnvironments",
    );
    this.validateManagedAccountRefs(nextConfig?.managedAccountRefs);
    return this.managedEnvironmentRepo.update(environmentId, {
      name: input.name,
      config: nextConfig,
      revision: existing.revision + 1,
    });
  }

  archiveEnvironment(environmentId: string): ManagedEnvironment | undefined {
    const existing = this.managedEnvironmentRepo.findById(environmentId);
    if (!existing) return undefined;
    this.assertWorkspacePermission(existing.config.workspaceId, "canManageEnvironments");
    return this.managedEnvironmentRepo.update(environmentId, { status: "archived" });
  }

  async createSession(input: ManagedSessionCreateInput): Promise<ManagedSession> {
    const agent = this.managedAgentRepo.findById(input.agentId);
    if (!agent) throw new Error(`Managed agent not found: ${input.agentId}`);
    if (agent.status === "suspended") {
      throw new Error(`Managed agent is suspended and cannot be run: ${agent.name}`);
    }
    if (agent.status === "archived") {
      throw new Error(`Managed agent is archived and cannot be run: ${agent.name}`);
    }
    const version = this.managedAgentVersionRepo.find(agent.id, agent.currentVersion);
    if (!version) throw new Error(`Managed agent version missing: ${agent.id}@${agent.currentVersion}`);
    const environment = this.managedEnvironmentRepo.findById(input.environmentId);
    if (!environment) throw new Error(`Managed environment not found: ${input.environmentId}`);
    const workspace = this.workspaceRepo.findById(environment.config.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${environment.config.workspaceId}`);
    this.assertWorkspacePermission(environment.config.workspaceId, "canRunAgents");

    const now = Date.now();
    const userPrompt = this.materializeContent(input.initialEvent?.content || []);
    const effectivePrompt = this.composeRootPrompt(version, userPrompt);
    const baseAgentConfig = this.buildAgentConfig(environment, version);

    if (version.executionMode === "team") {
      const task = this.taskRepo.create({
        title: input.title,
        prompt: effectivePrompt,
        rawPrompt: effectivePrompt,
        userPrompt: userPrompt || effectivePrompt,
        status: "pending",
        workspaceId: environment.config.workspaceId,
        agentConfig: baseAgentConfig,
      });

      const { teamRunId } = await this.createManagedTeamRun(task, agent, version);
      const session = this.managedSessionRepo.create({
        id: randomUUID(),
        agentId: agent.id,
        agentVersion: version.version,
        environmentId: environment.id,
        title: input.title,
        status: "running",
        workspaceId: environment.config.workspaceId,
        backingTaskId: task.id,
        backingTeamRunId: teamRunId,
        latestSummary: undefined,
        startedAt: now,
      });
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: now,
        type: "session.created",
        payload: {
          agentId: agent.id,
          agentVersion: version.version,
          environmentId: environment.id,
          backingTaskId: task.id,
          backingTeamRunId: teamRunId,
        },
      });
      if (input.initialEvent?.type === "user.message") {
        this.managedSessionEventRepo.create({
          sessionId: session.id,
          timestamp: now,
          type: "user.message",
          payload: { content: input.initialEvent.content },
        });
      }
      try {
        await this.agentDaemon.startTask(task);
      } catch (error: Any) {
        const message = error?.message || "Failed to start managed team session";
        this.teamRunRepo.update(teamRunId, { status: "failed", error: message });
        this.agentDaemon.failTask(task.id, message, {
          resultSummary: message,
        });
        this.managedSessionRepo.update(session.id, {
          status: "failed",
          latestSummary: message,
          completedAt: Date.now(),
        });
        this.managedSessionEventRepo.create({
          sessionId: session.id,
          timestamp: Date.now(),
          type: "session.failed",
          payload: { error: message },
        });
        return this.refreshSession(session.id) || session;
      }
      return this.refreshSession(session.id) || session;
    }

    const task = this.taskRepo.create({
      title: input.title,
      prompt: effectivePrompt,
      rawPrompt: effectivePrompt,
      userPrompt: userPrompt || effectivePrompt,
      status: "pending",
      workspaceId: environment.config.workspaceId,
      agentConfig: baseAgentConfig,
    });

    const session = this.managedSessionRepo.create({
      id: randomUUID(),
      agentId: agent.id,
      agentVersion: version.version,
      environmentId: environment.id,
      title: input.title,
      status: "pending",
      workspaceId: environment.config.workspaceId,
      backingTaskId: task.id,
      latestSummary: undefined,
    });
    this.managedSessionEventRepo.create({
      sessionId: session.id,
      timestamp: now,
      type: "session.created",
      payload: {
        agentId: agent.id,
        agentVersion: version.version,
        environmentId: environment.id,
        backingTaskId: task.id,
      },
    });
    if (input.initialEvent?.type === "user.message") {
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: now,
        type: "user.message",
        payload: { content: input.initialEvent.content },
      });
    }

    await this.agentDaemon.startTask(task);
    return this.refreshSession(session.id) || session;
  }

  listSessions(params?: {
    limit?: number;
    offset?: number;
    workspaceId?: string;
    status?: ManagedSession["status"];
  }): ManagedSession[] {
    return this.managedSessionRepo.list(params).map((session) => {
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "cancelled"
      ) {
        return session;
      }
      return this.refreshSession(session.id) || session;
    });
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.refreshSession(sessionId);
  }

  listSessionEvents(sessionId: string, limit = 500): ManagedSessionEvent[] {
    const session = this.refreshSession(sessionId);
    if (!session) return [];
    return this.managedSessionEventRepo.listBySessionId(sessionId, limit);
  }

  async cancelSession(sessionId: string): Promise<ManagedSession | undefined> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session) return undefined;
    this.assertWorkspacePermission(session.workspaceId, "canRunAgents");
    if (session.backingTeamRunId) {
      await this.cancelManagedTeamRun(session.backingTeamRunId);
    }
    if (session.backingTaskId) {
      await this.agentDaemon.cancelTask(session.backingTaskId).catch(() => {});
    }
    this.managedSessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "status.changed",
      payload: { status: "cancelled", reason: "user_cancelled" },
    });
    return this.refreshSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<{ resumed: boolean; session?: ManagedSession }> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return { resumed: false, session };
    this.assertWorkspacePermission(session.workspaceId, "canResumeSessions");
    if (session.backingTeamRunId) {
      await this.tickManagedTeamRun(session.backingTeamRunId);
      const refreshed = this.refreshSession(sessionId);
      return { resumed: true, session: refreshed };
    }
    const resumed = await this.agentDaemon.resumeTask(session.backingTaskId);
    const refreshed = this.refreshSession(sessionId);
    return { resumed, session: refreshed };
  }

  async sendEvent(
    sessionId: string,
    event:
      | { type: "user.message"; content: ManagedSessionInputContent[] }
      | { type: "input.received"; requestId: string; answers?: InputRequestResponse["answers"]; status?: InputRequestResponse["status"] },
  ): Promise<ManagedSession | undefined> {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session?.backingTaskId) return undefined;
    this.assertWorkspacePermission(
      session.workspaceId,
      event.type === "input.received" ? "canAnswerApprovals" : "canRunAgents",
    );

    if (event.type === "user.message") {
      if (session.backingTeamRunId) {
        throw new Error("user.message is not supported for team-mode managed sessions yet");
      }
      const message = this.materializeContent(event.content);
      this.managedSessionEventRepo.create({
        sessionId,
        timestamp: Date.now(),
        type: "user.message",
        payload: { content: event.content },
      });
      await this.agentDaemon.sendMessage(session.backingTaskId, message);
      return this.refreshSession(sessionId);
    }

    this.managedSessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "input.received",
      payload: {
        requestId: event.requestId,
        status: event.status || "submitted",
        answers: event.answers || {},
      },
    });
    await this.agentDaemon.respondToInputRequest({
      requestId: event.requestId,
      status: event.status || "submitted",
      answers: event.answers,
    });
    return this.refreshSession(sessionId);
  }

  async generateAudioSummary(
    sessionId: string,
    input?: Partial<AudioSummaryConfig>,
  ): Promise<AudioSummaryResult> {
    const session = this.refreshSession(sessionId);
    if (!session?.backingTaskId) {
      throw new Error(`Managed session not found: ${sessionId}`);
    }
    const task = this.taskRepo.findById(session.backingTaskId);
    if (!task) {
      throw new Error(`Backing task not found for managed session: ${sessionId}`);
    }
    const workspace = this.workspaceRepo.findById(session.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${session.workspaceId}`);
    }
    const { currentVersion } = this.getAgent(session.agentId) || {};
    const studio = currentVersion ? getStudioConfig(currentVersion) : undefined;
    const style =
      input?.style ||
      studio?.audioSummaryConfig?.style ||
      "executive-briefing";
    const title =
      input?.title ||
      studio?.audioSummaryConfig?.title ||
      `${session.title} audio summary`;
    const script = this.buildAudioSummaryScript(session, style);
    const audioBuffer = await getVoiceService().speak(script);
    if (!audioBuffer) {
      throw new Error("Audio summary generation returned no audio");
    }
    const outputDir = path.join(workspace.path, "output", "agents", "audio-summaries");
    await fs.mkdir(outputDir, { recursive: true });
    const safeTitle = slugifyName(title);
    const outputPath = path.join(outputDir, `${safeTitle}-${Date.now()}.mp3`);
    await fs.writeFile(outputPath, audioBuffer);
    const artifact = this.artifactRepo.create({
      taskId: session.backingTaskId,
      path: outputPath,
      mimeType: "audio/mpeg",
      sha256: createHash("sha256").update(audioBuffer).digest("hex"),
      size: audioBuffer.length,
      createdAt: Date.now(),
    });
    this.managedSessionEventRepo.create({
      sessionId,
      timestamp: Date.now(),
      type: "tool.result",
      payload: {
        toolName: "generate_audio_summary",
        style,
        artifactId: artifact.id,
        path: outputPath,
        title,
      },
    });
    if (currentVersion && studio) {
      const nextStudio: ManagedAgentStudioConfig = {
        ...studio,
        audioSummaryConfig: {
          enabled: true,
          style,
          title,
          voice: input?.voice || studio.audioSummaryConfig?.voice,
          lastArtifactId: artifact.id,
        },
      };
      this.managedAgentVersionRepo.updateMetadata(
        currentVersion.agentId,
        currentVersion.version,
        setStudioConfigMetadata(currentVersion.metadata, nextStudio),
      );
    }
    return {
      sessionId,
      artifact,
      style,
      title,
      script,
      playbackUrl: createMediaPlaybackUrl({
        resolvedPath: outputPath,
        workspaceRoot: workspace.path,
        mimeType: "audio/mpeg",
      }),
    };
  }

  getAgentInsights(agentId: string): ManagedAgentInsights {
    const workspaceId = this.resolveWorkspaceIdForAgent(agentId);
    if (workspaceId) this.assertWorkspacePermission(workspaceId, "canViewAgents");
    const sessions = this.listSessions({ limit: 500 }).filter((session) => session.agentId === agentId);
    const completedDurations = sessions
      .filter((session) => session.completedAt && session.startedAt && session.completedAt >= session.startedAt)
      .map((session) => (session.completedAt || 0) - (session.startedAt || 0));
    const totalDuration = completedDurations.reduce((sum, value) => sum + value, 0);
    const toolCounts = new Map<string, number>();
    const recentErrors: ManagedAgentInsights["recentErrors"] = [];
    const userKeys = new Set<string>();
    let approvalTotal = 0;
    let approvalResolved = 0;

    for (const session of sessions) {
      if (session.status === "failed" || session.status === "cancelled") {
        recentErrors.push({
          id: session.id,
          message: session.latestSummary || session.status,
          occurredAt: session.updatedAt,
          sessionId: session.id,
        });
      }
      if (!session.backingTaskId) continue;
      const events = this.taskEventRepo.findByTaskId(session.backingTaskId);
      for (const event of events) {
        const effectiveType = event.legacyType || event.type;
        if (effectiveType === "tool_call") {
          const toolName = String(event.payload?.toolName || event.payload?.tool || "").trim();
          if (toolName) {
            toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
          }
        }
        for (const userKey of this.extractUserKeysFromPayload(event.payload)) {
          userKeys.add(userKey);
        }
      }
      for (const event of this.listSessionEvents(session.id, 200)) {
        for (const userKey of this.extractUserKeysFromPayload(event.payload)) {
          userKeys.add(userKey);
        }
      }
      const inputs = this.inputRequestRepo.list({
        limit: 100,
        offset: 0,
        taskId: session.backingTaskId,
      });
      approvalTotal += inputs.length;
      approvalResolved += inputs.filter((request) => request.status === "submitted").length;
    }

    const triggerBreakdown = new Map<string, number>();
    const deploymentBreakdown = new Map<string, number>();
    for (const row of this.listRoutineRunsForAgent(agentId)) {
      const triggerType = row.run.triggerType || "manual";
      triggerBreakdown.set(triggerType, (triggerBreakdown.get(triggerType) || 0) + 1);
      deploymentBreakdown.set(row.surface, (deploymentBreakdown.get(row.surface) || 0) + 1);
      if (row.run.errorSummary) {
        recentErrors.push({
          id: row.run.id,
          message: row.run.errorSummary,
          occurredAt: row.run.updatedAt || row.run.createdAt || 0,
          routineRunId: row.run.id,
        });
      }
    }
    if (sessions.length > 0) {
      deploymentBreakdown.set(
        "chatgpt",
        (deploymentBreakdown.get("chatgpt") || 0) + sessions.length,
      );
      triggerBreakdown.set("manual", (triggerBreakdown.get("manual") || 0) + sessions.length);
    }

    return {
      agentId,
      totalRuns: sessions.length,
      uniqueUsers: userKeys.size > 0 ? userKeys.size : sessions.length > 0 ? 1 : 0,
      successCount: sessions.filter((session) => session.status === "completed").length,
      failureCount: sessions.filter((session) => session.status === "failed").length,
      cancelledCount: sessions.filter((session) => session.status === "cancelled").length,
      averageCompletionTimeMs:
        completedDurations.length > 0 ? Math.round(totalDuration / completedDurations.length) : 0,
      approvalRate: approvalTotal > 0 ? Math.round((approvalResolved / approvalTotal) * 100) : 0,
      topTools: Array.from(toolCounts.entries())
        .map(([toolName, count]) => ({ toolName, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 5),
      triggerBreakdown: Array.from(triggerBreakdown.entries()).map(([key, count]) => ({ key, count })),
      deploymentSurfaceBreakdown: Array.from(deploymentBreakdown.entries()).map(([key, count]) => ({
        key,
        count,
      })),
      recentErrors: recentErrors
        .sort((left, right) => right.occurredAt - left.occurredAt)
        .slice(0, 5),
      updatedAt: Date.now(),
    };
  }

  getSlackDeploymentHealth(agentId: string): import("../../shared/types").ManagedAgentSlackDeploymentHealth {
    const detail = this.getAgent(agentId);
    if (!detail?.agent || !detail.currentVersion) {
      throw new Error(`Managed agent not found: ${agentId}`);
    }
    const studio = getStudioConfig(detail.currentVersion);
    const targets = (studio?.channelTargets || []).filter((target) => target.channelType === "slack");
    const healthTargets = targets.map((target) => {
      const channel = this.channelRepo.findById(target.channelId);
      const status = channel?.status || "disconnected";
      return {
        channelId: target.channelId,
        channelName: target.channelName || channel?.name || target.channelId,
        status,
        connected: status === "connected" && !channel?.configReadError,
        misconfigured: Boolean(channel?.configReadError) || status !== "connected",
        securityMode: target.securityMode,
        progressRelayMode: target.progressRelayMode,
        configReadError: channel?.configReadError,
      };
    });
    const slackRuns = this.listRoutineRunsForAgent(agentId)
      .filter((row) => row.surface === "slack")
      .map((row) => row.run);
    const lastSuccessful = slackRuns.find((run) => this.isSuccessfulSlackRun(run));
    const failedRun = slackRuns.find((run) => run.status === "failed" || run.outputStatus === "failed");
    return {
      agentId,
      connectedCount: healthTargets.filter((target) => target.connected).length,
      misconfiguredCount: healthTargets.filter((target) => target.misconfigured).length,
      targets: healthTargets,
      lastSuccessfulRoutedRunAt: lastSuccessful?.updatedAt || lastSuccessful?.finishedAt,
      lastSuccessfulRoutedRunId: lastSuccessful?.id,
      lastDeploymentError:
        healthTargets.find((target) => target.configReadError)?.configReadError ||
        failedRun?.errorSummary,
      updatedAt: Date.now(),
    };
  }

  getSessionWorkpaper(sessionId: string): ManagedSessionWorkpaper {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Managed session not found: ${sessionId}`);
    }
    this.assertWorkspacePermission(session.workspaceId, "canViewAgents");
    const taskId = session.backingTaskId;
    const workspace = this.workspaceRepo.findById(session.workspaceId);
    const events = this.listSessionEvents(sessionId, 200);
    const inputRequests = taskId
      ? this.inputRequestRepo.list({ limit: 100, offset: 0, taskId })
      : [];
    const artifacts = taskId ? this.artifactRepo.findByTaskId(taskId) : [];
    const summary =
      session.latestSummary ||
      events
        .map((event) => String(event.payload?.message || event.payload?.content || "").trim())
        .filter(Boolean)
        .slice(-1)[0] ||
      "No summary recorded yet.";
    const canAudit = this.getMyWorkspacePermissions(session.workspaceId).canAuditAgents;

    return {
      sessionId,
      agentId: session.agentId,
      summary,
      evidenceRefs: artifacts.slice(0, 5).map((artifact) => ({
        evidenceId: artifact.id,
        sourceType: "file",
        sourceUrlOrPath: artifact.path,
        capturedAt: artifact.createdAt,
      })),
      decisions: events
        .filter((event) => event.type === "assistant.message")
        .map((event) => ({
          summary: String(event.payload?.message || event.payload?.content || "").trim(),
          timestamp: event.timestamp,
          sourceEventId: event.id,
        }))
        .filter((entry) => entry.summary)
        .slice(-5),
      approvals: inputRequests.map((request) => ({
        requestId: request.id,
        status: request.status,
        summary: request.questions.map((question) => question.question).join(" "),
        createdAt: request.requestedAt,
        resolvedAt: request.resolvedAt,
      })),
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        label: path.basename(artifact.path),
        path: artifact.path,
        mimeType: artifact.mimeType,
        playbackUrl:
          workspace && artifact.mimeType?.startsWith("audio/")
            ? createMediaPlaybackUrl({
                resolvedPath: artifact.path,
                workspaceRoot: workspace.path,
                mimeType: artifact.mimeType,
              })
            : undefined,
      })),
      auditTrail: canAudit
        ? this.listAuditEntries(session.agentId, 8).map((entry) => ({
            id: entry.id,
            action: entry.action,
            summary: entry.summary,
            createdAt: entry.createdAt,
            actorId: entry.actorId,
          }))
        : [],
      generatedAt: Date.now(),
    };
  }

  convertAgentRoleToManagedAgent(
    request: ConvertAgentRoleToManagedAgentRequest,
  ): Omit<ManagedAgentConversionResult, "routines"> & { routineDrafts: CreateManagedAgentRoutineRequest[] } {
    const role = this.agentRoleRepo.findById(request.agentRoleId);
    if (!role) {
      throw new Error(`Agent role not found: ${request.agentRoleId}`);
    }
    const workspace = request.workspaceId
      ? this.workspaceRepo.findById(request.workspaceId)
      : this.workspaceRepo.findAll()[0];
    if (!workspace) {
      throw new Error("At least one workspace is required before converting agent personas");
    }
    const parsedSoul = safeJsonParse<Record<string, unknown>>(role.soul || undefined, {});
    const capabilityFamilies: ManagedAgentToolFamily[] = [];
    if (role.capabilities.includes("research")) capabilityFamilies.push("search", "communication");
    if (role.capabilities.includes("code")) capabilityFamilies.push("files", "shell");
    if (role.capabilities.includes("document")) capabilityFamilies.push("documents");
    const environment = this.createEnvironment({
      name: `${role.displayName} Environment`,
      config: {
        workspaceId: workspace.id,
        enableShell: role.capabilities.includes("code"),
        enableBrowser: true,
        enableComputerUse: false,
        allowedToolFamilies: Array.from(new Set(capabilityFamilies)),
      },
    });
    const metadata: Record<string, unknown> = {
      studio: {
        workflowBrief: role.description || role.displayName,
        instructions: {
          operatingNotes:
            typeof parsedSoul.operatorMandate === "string"
              ? parsedSoul.operatorMandate
              : undefined,
        },
        apps: {
          allowedToolFamilies: Array.from(new Set(capabilityFamilies)),
        },
        approvalPolicy: {
          autoApproveReadOnly: true,
          requireApprovalFor: [],
        },
        sharing: {
          visibility: "team",
          ownerLabel: "Converted from Agent Persona",
        },
        deployment: {
          surfaces: ["chatgpt"],
        },
        legacyMirror: {
          agentRoleId: role.id,
        },
        defaultEnvironmentId: environment.id,
        conversion: {
          sourceType: "agent_role",
          sourceId: role.id,
          sourceLabel: role.displayName,
          migratedAt: Date.now(),
        },
      } satisfies ManagedAgentStudioConfig,
    };
    const created = this.createAgent({
      name: role.displayName,
      description: role.description,
      systemPrompt: role.systemPrompt || `Act as ${role.displayName}.`,
      executionMode: "solo",
      model: role.providerType || role.modelKey ? {
        providerType: role.providerType,
        modelKey: role.modelKey,
      } : undefined,
      metadata,
    });
    this.agentRoleRepo.update({
      id: role.id,
      soul: JSON.stringify({
        ...parsedSoul,
        managedAgentMigrated: true,
        managedAgentId: created.agent.id,
      }),
    });
    this.appendAudit({
      agentId: created.agent.id,
      workspaceId: workspace.id,
      action: "converted_from_agent_role",
      summary: `Converted agent persona ${role.displayName}`,
      metadata: { sourceId: role.id },
    });
    return {
      agent: created.agent,
      version: created.version,
      environment,
      sourceType: "agent_role",
      sourceId: role.id,
      routineDrafts: [],
    };
  }

  convertAutomationProfileToManagedAgent(
    request: ConvertAutomationProfileToManagedAgentRequest,
  ): Omit<ManagedAgentConversionResult, "routines"> & { routineDrafts: CreateManagedAgentRoutineRequest[] } {
    const profile = this.automationProfileRepo.findById(request.automationProfileId);
    if (!profile) {
      throw new Error(`Automation profile not found: ${request.automationProfileId}`);
    }
    const role = this.agentRoleRepo.findById(profile.agentRoleId);
    if (!role) {
      throw new Error(`Agent role not found for automation profile: ${profile.agentRoleId}`);
    }
    const converted = this.convertAgentRoleToManagedAgent({
      agentRoleId: role.id,
      workspaceId: request.workspaceId,
    });
    const routineDrafts: CreateManagedAgentRoutineRequest[] = profile.enabled
      ? [
          {
            agentId: converted.agent.id,
            name: `${role.displayName} routine`,
            description: "Converted from Automation Profile",
            enabled: true,
            trigger: {
              type: "schedule",
              enabled: true,
              cadenceMinutes: Math.max(15, profile.cadenceMinutes || 60),
            },
          },
        ]
      : [];
    this.automationProfileRepo.update({
      id: profile.id,
      enabled: false,
      cadenceMinutes: profile.cadenceMinutes,
      profile: profile.profile,
      activeHours: profile.activeHours ?? null,
    });
    this.updateCurrentStudioConfig(converted.agent.id, (studio) => ({
      ...studio,
      conversion: {
        sourceType: "automation_profile",
        sourceId: profile.id,
        sourceLabel: role.displayName,
        migratedAt: Date.now(),
      },
    }));
    this.appendAudit({
      agentId: converted.agent.id,
      workspaceId: converted.environment.config.workspaceId,
      action: "converted_from_automation_profile",
      summary: `Converted automation profile for ${role.displayName}`,
      metadata: { sourceId: profile.id },
    });
    return {
      ...converted,
      sourceType: "automation_profile",
      sourceId: profile.id,
      routineDrafts,
    };
  }

  bridgeTaskEventNotification(
    taskId: string,
    taskEvent: {
      eventId?: string;
      timestamp?: number;
      type: string;
      payload?: unknown;
      status?: string;
    },
  ): { session?: ManagedSession; appended?: ManagedSessionEvent } {
    const session = this.managedSessionRepo.findByBackingTaskId(taskId);
    if (!session) return {};
    if (taskEvent.eventId && this.managedSessionEventRepo.hasSourceTaskEvent(session.id, taskEvent.eventId)) {
      return { session: this.refreshSession(session.id) || session };
    }
    const appended = this.managedSessionEventRepo.create({
      sessionId: session.id,
      timestamp: taskEvent.timestamp || Date.now(),
      type: this.mapDaemonTaskEvent(taskEvent.type),
      payload: normalizeManagedSessionEventPayload(taskEvent.payload),
      sourceTaskId: taskId,
      sourceTaskEventId: taskEvent.eventId,
    });
    return {
      session: this.refreshSession(session.id) || session,
      appended,
    };
  }

  refreshSession(sessionId: string): ManagedSession | undefined {
    const session = this.managedSessionRepo.findById(sessionId);
    if (!session) return undefined;
    if (session.backingTaskId) {
      this.syncTaskEvents(session);
    }
    let nextSession = this.managedSessionRepo.findById(sessionId) || session;
    if (nextSession.backingTaskId && !nextSession.backingTeamRunId) {
      const run = this.teamRunRepo.findByRootTaskId(nextSession.backingTaskId);
      if (run) {
        nextSession =
          this.managedSessionRepo.update(nextSession.id, { backingTeamRunId: run.id }) || nextSession;
      }
    }

    const task = nextSession.backingTaskId ? this.taskRepo.findById(nextSession.backingTaskId) : undefined;
    const pendingInputs =
      nextSession.backingTaskId ? this.inputRequestRepo.findPendingByTaskId(nextSession.backingTaskId) : [];
    const nextStatus = toManagedSessionStatus(task, pendingInputs.length > 0);
    const latestSummary =
      task?.resultSummary ||
      (nextSession.backingTeamRunId ? this.teamRunRepo.findById(nextSession.backingTeamRunId)?.summary : undefined) ||
      nextSession.latestSummary;
    const completedAt =
      task?.completedAt ||
      (nextSession.backingTeamRunId ? this.teamRunRepo.findById(nextSession.backingTeamRunId)?.completedAt : undefined) ||
      nextSession.completedAt;

    const updates: Partial<ManagedSession> = {};
    if (nextSession.status !== nextStatus) {
      updates.status = nextStatus;
    }
    if (latestSummary && latestSummary !== nextSession.latestSummary) {
      updates.latestSummary = latestSummary;
    }
    if (!nextSession.startedAt && task?.createdAt) {
      updates.startedAt = task.createdAt;
    }
    if (completedAt && completedAt !== nextSession.completedAt) {
      updates.completedAt = completedAt;
    }
    if (Object.keys(updates).length > 0) {
      nextSession = this.managedSessionRepo.update(nextSession.id, updates) || nextSession;
      if (updates.status) {
        this.managedSessionEventRepo.create({
          sessionId: nextSession.id,
          timestamp: Date.now(),
          type:
            updates.status === "completed"
              ? "session.completed"
              : updates.status === "failed"
                ? "session.failed"
                : "status.changed",
          payload: {
            status: updates.status,
            latestSummary: updates.latestSummary || latestSummary,
          },
        });
      }
    }
    return nextSession;
  }

  private syncTaskEvents(session: ManagedSession): void {
    if (!session.backingTaskId) return;
    const events = this.taskEventRepo.findByTaskId(session.backingTaskId);
    for (const event of events) {
      if (this.managedSessionEventRepo.hasSourceTaskEvent(session.id, event.id)) continue;
      this.managedSessionEventRepo.create({
        sessionId: session.id,
        timestamp: event.timestamp,
        type: mapTaskEventType(event),
        payload: normalizeManagedSessionEventPayload(event.payload),
        sourceTaskId: session.backingTaskId,
        sourceTaskEventId: event.id,
      });
    }
  }

  private composeRootPrompt(version: ManagedAgentVersion, userPrompt: string): string {
    const promptParts = [version.systemPrompt.trim()];
    const studio = getStudioConfig(version);
    if (studio?.instructions?.operatingNotes?.trim()) {
      promptParts.push("", "Operating notes:", studio.instructions.operatingNotes.trim());
    }
    const fileRefs = listManagedFileRefs(studio?.fileRefs, undefined);
    if (fileRefs.length > 0) {
      promptParts.push("", "Reference files:", ...fileRefs.map((filePath) => `- ${filePath}`));
    }
    if (studio?.memoryConfig?.mode === "disabled") {
      promptParts.push("", "Memory policy:", "Avoid relying on long-term memory tools unless the user re-enables them.");
    } else if (studio?.memoryConfig?.sources?.length) {
      promptParts.push("", "Preferred memory sources:", ...studio.memoryConfig.sources.map((source) => `- ${source}`));
    }
    if (userPrompt.trim()) {
      promptParts.push("", "User request:", userPrompt.trim());
    }
    return promptParts.join("\n");
  }

  private materializeContent(content: ManagedSessionInputContent[]): string {
    const lines: string[] = [];
    for (const item of content) {
      if (item.type === "text" && item.text.trim()) {
        lines.push(item.text.trim());
        continue;
      }
      if (item.type === "file") {
        const artifact = this.artifactRepo.findById(item.artifactId);
        lines.push(
          artifact?.path
            ? `[Attached artifact: ${artifact.path}]`
            : `[Attached artifact: ${item.artifactId}]`,
        );
      }
    }
    return lines.join("\n\n").trim();
  }

  private buildAgentConfig(environment: ManagedEnvironment, version: ManagedAgentVersion): AgentConfig {
    const runtimeDefaults = version.runtimeDefaults || {};
    const studio = getStudioConfig(version);
    const agentConfig: AgentConfig = {
      ...(version.model?.providerType ? { providerType: version.model.providerType } : {}),
      ...(version.model?.modelKey ? { modelKey: version.model.modelKey } : {}),
      ...(version.model?.llmProfile ? { llmProfile: version.model.llmProfile } : {}),
      ...(runtimeDefaults.autonomousMode !== undefined
        ? { autonomousMode: runtimeDefaults.autonomousMode }
        : {}),
      ...(runtimeDefaults.requireWorktree || environment.config.requireWorktree
        ? { requireWorktree: true }
        : {}),
      ...(runtimeDefaults.allowUserInput !== undefined
        ? { allowUserInput: runtimeDefaults.allowUserInput }
        : {}),
      ...(environment.config.enableShell ? { shellAccess: true } : {}),
      ...(typeof runtimeDefaults.maxTurns === "number" ? { maxTurns: runtimeDefaults.maxTurns } : {}),
      ...(runtimeDefaults.webSearchMode ? { webSearchMode: runtimeDefaults.webSearchMode as Any } : {}),
      ...(runtimeDefaults.toolRestrictions?.length
        ? { toolRestrictions: [...runtimeDefaults.toolRestrictions] }
        : {}),
    };

    const memoryRestrictions = toMemoryToolRestrictions(studio?.memoryConfig)?.deniedTools || [];
    if (memoryRestrictions.length > 0) {
      agentConfig.toolRestrictions = Array.from(
        new Set([...(agentConfig.toolRestrictions || []), ...memoryRestrictions]),
      );
    }

    const managedApprovalTypes = toManagedApprovalTypes(studio?.approvalPolicy);
    if (managedApprovalTypes.length > 0) {
      agentConfig.autoApproveTypes = Array.from(
        new Set([...(agentConfig.autoApproveTypes || []), ...managedApprovalTypes]),
      );
    }
    if (studio?.approvalPolicy) {
      agentConfig.allowUserInput = true;
      agentConfig.pauseForRequiredDecision = true;
    }

    const allowedTools = new Set<string>(runtimeDefaults.allowedTools || []);
    const allowedMcpTools = this.resolveAllowedMcpTools(environment);
    for (const tool of allowedMcpTools) allowedTools.add(tool);
    if (allowedTools.size > 0) {
      agentConfig.allowedTools = Array.from(allowedTools);
    }
    if (version.executionMode === "team") {
      const template = version.teamTemplate || {};
      if (template.collaborativeMode) agentConfig.collaborativeMode = true;
      if (template.multiLlmMode) agentConfig.multiLlmMode = true;
    }

    return agentConfig;
  }

  private resolveAllowedMcpTools(environment: ManagedEnvironment): string[] {
    return resolveManagedAllowedMcpTools(environment.config);
  }

  private validateManagedAccountRefs(managedAccountRefs?: string[]): void {
    for (const accountId of managedAccountRefs || []) {
      if (!ManagedAccountManager.getById(accountId)) {
        throw new Error(`Managed account not found: ${accountId}`);
      }
    }
  }

  private async createManagedTeamRun(
    rootTask: Task,
    agent: ManagedAgent,
    version: ManagedAgentVersion,
  ): Promise<{ teamId: string; teamRunId: string }> {
    const activeRoles = this.agentRoleRepo.findAll(false).filter((role) => role.isActive);
    const template = version.teamTemplate || {};
    const leadAgentRoleId =
      (template.leadAgentRoleId && this.agentRoleRepo.findById(template.leadAgentRoleId)?.id) ||
      activeRoles[0]?.id;
    if (!leadAgentRoleId) {
      throw new Error("No active agent role available for managed team session");
    }

    const team = this.teamRepo.create({
      workspaceId: rootTask.workspaceId,
      name: `ManagedAgent-${agent.name}-${Date.now()}`,
      description: `Managed team for agent ${agent.name}`,
      leadAgentRoleId,
      maxParallelAgents: Math.max(1, template.maxParallelAgents || template.memberAgentRoleIds?.length || 1),
      persistent: false,
    });
    for (const [index, roleId] of (template.memberAgentRoleIds || []).entries()) {
      if (!this.agentRoleRepo.findById(roleId)) continue;
      this.teamMemberRepo.add({
        teamId: team.id,
        agentRoleId: roleId,
        memberOrder: (index + 1) * 10,
        isRequired: true,
      });
    }
    const run = this.teamRunRepo.create({
      teamId: team.id,
      rootTaskId: rootTask.id,
      status: "running",
      collaborativeMode: template.collaborativeMode ?? true,
      multiLlmMode: template.multiLlmMode ?? false,
    });

    const memberRoleIds = template.memberAgentRoleIds?.length
      ? template.memberAgentRoleIds
      : [leadAgentRoleId];
    for (const [index, roleId] of memberRoleIds.entries()) {
      if (!this.agentRoleRepo.findById(roleId)) continue;
      this.teamItemRepo.create({
        teamRunId: run.id,
        title: this.agentRoleRepo.findById(roleId)?.displayName || `Agent ${index + 1}`,
        description: rootTask.prompt,
        ownerAgentRoleId: roleId,
        status: "todo",
        sortOrder: (index + 1) * 10,
      });
    }
    return { teamId: team.id, teamRunId: run.id };
  }

  private async tickManagedTeamRun(teamRunId: string): Promise<void> {
    const teamOrchestrator = this.agentDaemon.getTeamOrchestrator();
    if (teamOrchestrator?.tickRun) {
      await teamOrchestrator.tickRun(teamRunId, "managed_session_create");
    }
  }

  private async cancelManagedTeamRun(teamRunId: string): Promise<void> {
    const teamOrchestrator = this.agentDaemon.getTeamOrchestrator();
    if (teamOrchestrator?.cancelRun) {
      await teamOrchestrator.cancelRun(teamRunId);
    }
  }

  private mapDaemonTaskEvent(type: string): ManagedSessionEventType {
    switch (type) {
      case "assistant_message":
        return "assistant.message";
      case "tool_call":
        return "tool.call";
      case "tool_result":
        return "tool.result";
      case "input_request_created":
        return "input.requested";
      case "task_completed":
        return "session.completed";
      case "error":
        return "session.failed";
      case "task_status":
      case "task_paused":
      case "task_resumed":
      case "task_cancelled":
      case "task_interrupted":
        return "status.changed";
      default:
        return "task.event.bridge";
    }
  }

  private syncLegacyMirror(
    agent: ManagedAgent,
    version: ManagedAgentVersion,
    previousStudio?: ManagedAgentStudioConfig,
  ): ManagedAgentVersion {
    const studio = getStudioConfig(version);
    if (!studio) return version;

    const templateId = studio.templateId;
    const roleId = studio.legacyMirror?.agentRoleId ?? previousStudio?.legacyMirror?.agentRoleId;
    const existingRole =
      (roleId ? this.agentRoleRepo.findById(roleId) : undefined) ||
      this.agentRoleRepo.findAll(true).find((role) => roleMirrorsManagedAgent(role, agent.id)) ||
      (() => {
        const namedRole = this.agentRoleRepo.findByName(`managed-${slugifyName(agent.name)}`);
        return roleMirrorsManagedAgent(namedRole, agent.id) ? namedRole : undefined;
      })();
    const heartbeatPolicy =
      studio.scheduleConfig?.enabled
        ? {
            enabled: true,
            cadenceMinutes: Math.max(15, studio.scheduleConfig.cadenceMinutes || 180),
            activeHours: studio.scheduleConfig.activeHours ?? null,
            profile: "operator" as const,
          }
        : undefined;
    const sourceTemplateVersion =
      typeof version.version === "number" ? String(version.version) : undefined;
    const autonomyPolicy = toManagedAutonomyPolicy(studio.approvalPolicy);
    let mirroredRole = existingRole;
    if (existingRole) {
      mirroredRole = this.agentRoleRepo.update({
        id: existingRole.id,
        displayName: agent.name,
        description: agent.description,
        sourceTemplateId: templateId ?? null,
        sourceTemplateVersion: sourceTemplateVersion ?? null,
        systemPrompt: version.systemPrompt,
        providerType: version.model?.providerType,
        modelKey: version.model?.modelKey,
        capabilities: deriveCapabilities(templateId),
        toolRestrictions: toMemoryToolRestrictions(studio.memoryConfig),
        autonomyLevel: studio.scheduleConfig?.enabled ? "lead" : "specialist",
        soul: JSON.stringify({
          managedAgentId: agent.id,
          managedAgentVersion: version.version,
          studio,
          autonomyPolicy,
          sourceTemplateId: templateId,
          sourceTemplateVersion,
        }),
      });
    } else {
      mirroredRole = this.agentRoleRepo.create({
        name: `managed-${slugifyName(agent.name)}`,
        displayName: agent.name,
        description: agent.description,
        roleKind: "custom",
        sourceTemplateId: templateId,
        sourceTemplateVersion,
        systemPrompt: version.systemPrompt,
        providerType: version.model?.providerType,
        modelKey: version.model?.modelKey,
        capabilities: deriveCapabilities(templateId),
        toolRestrictions: toMemoryToolRestrictions(studio.memoryConfig),
        autonomyLevel: studio.scheduleConfig?.enabled ? "lead" : "specialist",
        soul: JSON.stringify({
          managedAgentId: agent.id,
          managedAgentVersion: version.version,
          studio,
          autonomyPolicy,
          sourceTemplateId: templateId,
          sourceTemplateVersion,
        }),
        heartbeatPolicy,
      });
    }

    let automationProfileId = studio.legacyMirror?.automationProfileId;
    if (mirroredRole) {
      if (studio.scheduleConfig?.enabled) {
        const profile = this.automationProfileRepo.createOrReplace({
          agentRoleId: mirroredRole.id,
          enabled: false,
          cadenceMinutes: Math.max(15, studio.scheduleConfig.cadenceMinutes || 180),
          profile: "operator",
          activeHours: studio.scheduleConfig.activeHours ?? null,
        });
        automationProfileId = profile.id;
      } else {
        const existingProfile = this.automationProfileRepo.findByAgentRoleId(mirroredRole.id);
        if (existingProfile) {
          this.automationProfileRepo.update({
            id: existingProfile.id,
            enabled: false,
            cadenceMinutes: existingProfile.cadenceMinutes,
            profile: existingProfile.profile,
            activeHours: existingProfile.activeHours ?? null,
          });
          automationProfileId = existingProfile.id;
        }
      }
      this.syncSlackTargets(
        mirroredRole.id,
        previousStudio?.channelTargets,
        agent.status === "active" ? studio.channelTargets : [],
      );
    }

    const nextStudio: ManagedAgentStudioConfig = {
      ...studio,
      legacyMirror: {
        ...studio.legacyMirror,
        ...(mirroredRole ? { agentRoleId: mirroredRole.id } : {}),
        ...(automationProfileId ? { automationProfileId } : {}),
      },
    };
    return (
      this.managedAgentVersionRepo.updateMetadata(
        version.agentId,
        version.version,
        setStudioConfigMetadata(version.metadata, nextStudio),
      ) || version
    );
  }

  private syncSlackTargets(
    mirroredRoleId: string,
    previousTargets?: ManagedAgentChannelTarget[],
    nextTargets?: ManagedAgentChannelTarget[],
  ): void {
    const relevantChannelIds = new Set<string>();
    for (const target of previousTargets || []) {
      if (target.channelType === "slack") relevantChannelIds.add(target.channelId);
    }
    for (const target of nextTargets || []) {
      if (target.channelType === "slack") relevantChannelIds.add(target.channelId);
    }

    for (const channelId of relevantChannelIds) {
      const channel = this.channelRepo.findById(channelId);
      if (!channel || channel.configReadError) continue;
      const nextTarget = (nextTargets || []).find(
        (target) => target.channelType === "slack" && target.channelId === channelId,
      );
      const currentConfig = { ...(channel.config || {}) };
      const nextAllowed = Array.isArray(currentConfig.allowedAgentRoleIds)
        ? [...(currentConfig.allowedAgentRoleIds as string[])]
        : [];
      const nextSecurityConfig = { ...(channel.securityConfig || { mode: "pairing" as const }) };

      if (nextTarget && nextTarget.enabled !== false) {
        currentConfig.defaultAgentRoleId = mirroredRoleId;
        if (!nextAllowed.includes(mirroredRoleId)) nextAllowed.push(mirroredRoleId);
        currentConfig.allowedAgentRoleIds = nextAllowed;
        if (nextTarget.progressRelayMode) {
          currentConfig.progressRelayMode = nextTarget.progressRelayMode;
        }
        if (nextTarget.securityMode) {
          nextSecurityConfig.mode = nextTarget.securityMode;
        }
      } else {
        if (currentConfig.defaultAgentRoleId === mirroredRoleId) {
          delete currentConfig.defaultAgentRoleId;
        }
        currentConfig.allowedAgentRoleIds = nextAllowed.filter((id) => id !== mirroredRoleId);
      }

      this.channelRepo.update(channelId, {
        config: currentConfig,
        securityConfig: nextSecurityConfig,
      });
    }
  }

  private listRoutineRunsForAgent(agentId: string): Array<{
    run: import("../routines/types").RoutineRun;
    definition: Routine;
    surface: "slack" | "chatgpt";
  }> {
    const rows = this.db
      .prepare(
        `SELECT rr.*, ar.definition_json
         FROM routine_runs rr
         JOIN automation_routines ar ON ar.id = rr.routine_id
         ORDER BY rr.updated_at DESC`,
      )
      .all() as Any[];
    const runs: Array<{
      run: import("../routines/types").RoutineRun;
      definition: Routine;
      surface: "slack" | "chatgpt";
    }> = [];
    for (const row of rows) {
      const definition = safeJsonParse<Routine | null>(row.definition_json, null);
      if (!definition || definition.contextBindings?.metadata?.managedAgentId !== agentId) continue;
      const run = {
        id: String(row.id),
        routineId: String(row.routine_id),
        triggerId: String(row.trigger_id),
        triggerType: String(row.trigger_type || "manual") as import("../routines/types").RoutineRun["triggerType"],
        status: String(row.status || "queued") as import("../routines/types").RoutineRun["status"],
        startedAt: Number(row.started_at || 0),
        finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
        sourceEventSummary: row.source_event_summary ? String(row.source_event_summary) : undefined,
        backingTaskId: row.backing_task_id ? String(row.backing_task_id) : undefined,
        backingManagedSessionId: row.backing_managed_session_id
          ? String(row.backing_managed_session_id)
          : undefined,
        outputStatus: String(row.output_status || "none") as import("../routines/types").RoutineRun["outputStatus"],
        errorSummary: row.error_summary ? String(row.error_summary) : undefined,
        artifactsSummary: row.artifacts_summary ? String(row.artifacts_summary) : undefined,
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
      };
      const surface =
        definition.contextBindings?.chatContext?.channelType === "slack" ||
        run.triggerType === "channel_event"
          ? "slack"
          : "chatgpt";
      runs.push({ run, definition, surface });
    }
    return runs;
  }

  private isSuccessfulSlackRun(run: import("../routines/types").RoutineRun): boolean {
    if (run.outputStatus === "sent" || run.outputStatus === "responded") return true;
    return run.status === "completed" || run.status === "partial_success";
  }

  private extractUserKeysFromPayload(payload: unknown): string[] {
    const seen = new Set<string>();
    const visit = (value: unknown, depth = 0): void => {
      if (!value || depth > 3) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (!isRecord(value)) return;

      const candidates = [
        ["requestingUserId", "user"],
        ["userId", "user"],
        ["senderId", "user"],
        ["actorId", "user"],
        ["email", "email"],
        ["senderEmail", "email"],
        ["requestingUserName", "name"],
        ["userName", "name"],
        ["senderName", "name"],
      ] as const;
      for (const [key, prefix] of candidates) {
        const raw = value[key];
        if (typeof raw === "string" && raw.trim()) {
          seen.add(`${prefix}:${raw.trim().toLowerCase()}`);
        }
      }

      for (const nested of Object.values(value)) {
        visit(nested, depth + 1);
      }
    };
    visit(payload);
    return Array.from(seen);
  }

  private buildAudioSummaryScript(
    session: ManagedSession,
    style: AudioSummaryConfig["style"],
  ): string {
    const events = this.managedSessionEventRepo.listBySessionId(session.id, 80);
    const assistantHighlights = events
      .filter((event) => event.type === "assistant.message")
      .map((event) => String(event.payload?.message || event.payload?.content || "").trim())
      .filter(Boolean)
      .slice(-4);
    const latestSummary = session.latestSummary?.trim() || "";

    switch (style) {
      case "public-radio":
        return [
          `This is your public-radio style recap for ${session.title}.`,
          latestSummary || "Here is the latest update from the run.",
          ...assistantHighlights,
          "That concludes the recap.",
        ]
          .filter(Boolean)
          .join("\n\n");
      case "study-guide":
        return [
          `Study guide for ${session.title}.`,
          "Key takeaway:",
          latestSummary || "No final summary was recorded yet.",
          ...(assistantHighlights.length > 0 ? ["Supporting points:", ...assistantHighlights] : []),
        ]
          .filter(Boolean)
          .join("\n\n");
      case "executive-briefing":
      default:
        return [
          `Executive briefing for ${session.title}.`,
          latestSummary || "No final summary was recorded yet.",
          ...(assistantHighlights.length > 0 ? ["Key supporting details:", ...assistantHighlights] : []),
          "Next recommended action: review the agent run and decide whether to continue, publish, or adjust the configuration.",
        ]
          .filter(Boolean)
          .join("\n\n");
    }
  }
}
