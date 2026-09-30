import type Database from "better-sqlite3";
import { PluginRegistry } from "../../electron/extensions/registry";
import {
  getPluginPackToggleService,
  type PluginPackToggleService,
} from "../../electron/extensions/plugin-pack-toggle-service";
import {
  AgentTeamRepository,
  AgentRoleRepository,
  AutomationProfileRepository,
} from "../../electron/agents/agent-repository-facades";
import type { HeartbeatService } from "../../electron/agents/HeartbeatService";
import { AgentDaemon } from "../../electron/agent/daemon";
import { EverydayAgentService } from "../../electron/everyday-agent/everyday-agent-repository-facades";
import { CronService, getCronService } from "../../electron/cron";
import type { CronJob, CronJobCreate, CronJobPatch, CronSchedule } from "../../electron/cron/types";
import { CHANNEL_TYPES, type ChannelType } from "../../electron/gateway/channels/types";
import {
  BotNotificationPreferenceRepository,
  SkillRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../../electron/database/repository-facades";
import { TaskStore } from "../../electron/database/repositories";
import { MCPSettingsManager } from "../../electron/mcp/settings";
import { getCustomSkillLoader } from "../../electron/agent/custom-skill-loader";
import { getSkillRegistry } from "../../electron/agent/skill-registry";
import { getPackRegistry } from "../../electron/extensions/pack-registry";
import { MCPClientManager } from "../../electron/mcp/client/MCPClientManager";
import { MCPRegistryManager } from "../../electron/mcp/registry/MCPRegistryManager";
import {
  AgentBuilderService,
  type AgentBuilderInventory,
} from "../../electron/managed/AgentBuilderService";
import { AgentTemplateService } from "../../electron/managed/AgentTemplateService";
import { ImageGenProfileService } from "../../electron/managed/ImageGenProfileService";
import { ManagedSessionService } from "../../electron/managed/ManagedSessionService";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import {
  isPackAllowed,
  isPackRequired,
  loadPolicies,
  loadPoliciesStrict,
} from "../../electron/admin/policies";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../../electron/security/access-profile-resolver";
import { HooksSettingsManager } from "../../electron/hooks/settings";
import { listIntegrationMentionOptions } from "../../electron/integrations/integration-mention-options";
import type {
  EventTrigger,
  EventTriggerRegistry,
  TriggerHistoryEntry,
} from "../../electron/triggers/types";
import { RoutineService } from "../../electron/routines/service";
import type { Routine, RoutineCreate, RoutinePatch } from "../../electron/routines/types";
import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowTestRequest,
} from "../../shared/routine-workflow";
import type {
  AgentWorkspacePermissionSnapshot,
  EverydayActionPreviewInput,
  EverydayAgentApproveActionRequest,
  EverydayAgentClearDataRequest,
  EverydayAgentListReceiptsRequest,
  EverydayAgentUpdateProfileRequest,
  EverydayCapabilityBundle,
  EverydayPauseScope,
  AgentBuilderPlanRequest,
  AgentBuilderCreateRequest,
  CreateManagedAgentRoutineRequest,
  UpdateManagedAgentRoutineRequest,
  ManagedAgent,
  ManagedAgentRoutineTriggerConfig,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  ManagedSessionInputContent,
  ManagedSessionUserMessageRequest,
  BotConversationReopenRequest,
  ChannelData,
  Task,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { EVERYDAY_AGENT_CAPABILITY_BUNDLES } from "../../shared/types";
import type { ChannelGateway } from "../../electron/gateway";
import type { BrowserDesktopDefinitions, BrowserDesktopDefinition } from "./browser-desktop-rpc";
import { toBrowserTask } from "./browser-desktop-read-methods";
import { WebApplicationError } from "../web/WebApplication";
import { WorkContextService } from "../../electron/workspaces/workspaces-repository-facades";

type EventTriggerSource = EventTriggerRegistry & {
  listTriggers?: (workspaceId?: string) => EventTrigger[];
  getHistory?: (triggerId: string, limit?: number) => TriggerHistoryEntry[];
};

type HeartbeatStatusSource = Pick<HeartbeatService, "getAllStatus">;

export interface BrowserNavigationOptions {
  db: Database.Database;
  agentDaemon: AgentDaemon;
  channelGateway?: Pick<
    ChannelGateway,
    "getChannels" | "getChannel" | "getDistinctChatIds" | "sendMessage"
  >;
  getRoutineService?: () => RoutineService | null;
  getEventTriggerService?: () => EventTriggerSource | null;
  getCronService?: () => CronService | null;
  getHeartbeatService?: () => HeartbeatStatusSource | null;
  resolveWorkspace?: (workspaceId: string) => Promise<Workspace | null>;
  managedSessionService?: ManagedSessionService;
  everydayAgentService?: EverydayAgentService;
  agentBuilderService?: AgentBuilderService;
  imageGenProfileService?: ImageGenProfileService;
  /** Read-only discovery sources; injectable so browser DTOs can be tested without network access. */
  discovery?: Partial<BrowserDiscoverySources>;
  /** Shared desired-state operations; injectable for browser-method boundary tests. */
  pluginPackToggleService?: Pick<PluginPackToggleService, "setPackEnabled" | "setSkillEnabled">;
  /** Existing desktop-only executor, when the host owns the full workflow runtime. */
  executeWorkflowAction?: ConstructorParameters<typeof RoutineService>[0]["executeWorkflowAction"];
}

export interface BrowserDiscoverySources {
  listPluginPacks: () => Promise<unknown>;
  getSkillStatus: () => Promise<unknown>;
  listQuarantinedImports: () => unknown;
  searchSkillRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number },
  ) => Promise<unknown>;
  searchClawHubSkills: (
    query: string,
    options?: { page?: number; pageSize?: number },
  ) => Promise<unknown>;
  searchPackRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number; category?: string },
  ) => Promise<unknown>;
  getMCPStatus: () => unknown;
  fetchMCPRegistry: () => Promise<unknown>;
  searchMCPRegistry: (query: string, tags?: string[]) => Promise<unknown>;
}

type RecordLike = Record<string, unknown>;
type ManagedPermission = keyof Pick<
  AgentWorkspacePermissionSnapshot,
  | "canViewAgents"
  | "canRunAgents"
  | "canResumeSessions"
  | "canAnswerApprovals"
  | "canEditDrafts"
  | "canManageEnvironments"
  | "canPublishAgents"
  | "canManageRoutines"
  | "canManageMemberships"
  | "canAuditAgents"
>;

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/;
const DISCOVERY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_JSON_CHARS = 512 * 1024;
const MAX_DISCOVERY_SKILLS = 500;
const MAX_DISCOVERY_QUARANTINE_RECORDS = 100;
const MAX_DISCOVERY_REGISTRY_ENTRIES = 200;
const MAX_DISCOVERY_PLUGIN_PACKS = 100;
const MAX_PLUGIN_PACK_CHILDREN = 100;
const ROUTINE_TRIGGER_TYPES = new Set([
  "manual",
  "schedule",
  "api",
  "connector_event",
  "channel_event",
  "mailbox_event",
  "github_event",
]);

function invalidRequest(): never {
  throw new WebApplicationError("INVALID_REQUEST", "Invalid browser action arguments.", 400);
}

function requireRecord(value: unknown, allowed?: readonly string[]): RecordLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidRequest();
  const record = value as RecordLike;
  if (allowed && Object.keys(record).some((key) => !allowed.includes(key))) return invalidRequest();
  return record;
}

function boundedJson(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalidRequest();
  }
  if (serialized.length > MAX_JSON_CHARS) return invalidRequest();
  return value;
}

function boundedJsonArray<T>(items: T[]): T[] {
  let selected = items;
  while (selected.length > 0 && JSON.stringify(selected).length > MAX_JSON_CHARS) {
    selected = selected.slice(0, Math.floor(selected.length / 2));
  }
  return boundedJson(selected) as T[];
}

function boundedJsonListResult(base: RecordLike, key: string, items: unknown[]): RecordLike {
  let selected = items;
  let result: RecordLike = { ...base, [key]: selected };
  while (selected.length > 0 && JSON.stringify(result).length > MAX_JSON_CHARS) {
    selected = selected.slice(0, Math.floor(selected.length / 2));
    result = { ...base, [key]: selected, truncated: true };
  }
  return boundedJson(result) as RecordLike;
}

function stringArg(value: unknown, max = 512): string {
  if (typeof value !== "string") return invalidRequest();
  const result = value.trim();
  if (!result || result.length > max || !IDENTIFIER.test(result)) return invalidRequest();
  return result;
}

function booleanArg(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidRequest();
  return value;
}

function textArg(value: unknown, max = 100_000, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    return invalidRequest();
  }
  return value;
}

interface BrowserForkTaskSessionRequest {
  taskId: string;
  prompt?: string;
  branchLabel?: string;
  fromEventId?: string;
  sideChat?: boolean;
  initialMessage?: string;
}

function parseForkTaskSessionRequest(value: unknown): BrowserForkTaskSessionRequest {
  const input = requireRecord(value, [
    "taskId",
    "prompt",
    "branchLabel",
    "fromEventId",
    "sideChat",
    "initialMessage",
  ]);
  return {
    taskId: stringArg(input.taskId, 160),
    ...(input.prompt === undefined ? {} : { prompt: textArg(input.prompt, 500_000, true) }),
    ...(input.branchLabel === undefined ? {} : { branchLabel: textArg(input.branchLabel, 200) }),
    ...(input.fromEventId === undefined ? {} : { fromEventId: stringArg(input.fromEventId, 200) }),
    ...(input.sideChat === undefined ? {} : { sideChat: booleanArg(input.sideChat) }),
    ...(input.initialMessage === undefined
      ? {}
      : { initialMessage: textArg(input.initialMessage, 500_000, true) }),
  };
}

function publicForkTask(task: Task): RecordLike {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    prompt: "",
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.agentType ? { agentType: task.agentType } : {}),
    ...(task.depth !== undefined ? { depth: task.depth } : {}),
    ...(task.assignedAgentRoleId ? { assignedAgentRoleId: task.assignedAgentRoleId } : {}),
    ...(task.pinned !== undefined ? { pinned: task.pinned } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.source ? { source: task.source } : {}),
  };
}

function integerArg(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalidRequest();
  }
  return value;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  return value === undefined ? undefined : integerArg(value, min, max);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return invalidRequest();
  return value;
}

function stringArray(value: unknown, maxItems = 256): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return invalidRequest();
  return value.map((entry) => textArg(entry, 2048));
}

function safeDiscoveryRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;
}

function safeDiscoveryText(value: unknown, max = 1000): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function safeDiscoveryId(value: unknown): string | undefined {
  const id = safeDiscoveryText(value, 160)?.trim();
  return id && DISCOVERY_IDENTIFIER.test(id) && !id.includes("..") ? id : undefined;
}

function pluginPackToggleIdArg(value: unknown): string {
  const id = safeDiscoveryId(value);
  if (!id) return invalidRequest();
  return id;
}

function safeDiscoveryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000_000)
    : undefined;
}

function safeDiscoveryMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeDiscoveryTextList(value: unknown, maxItems = 24, maxText = 120): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).flatMap((item) => {
    const text = safeDiscoveryText(item, maxText)?.trim();
    return text ? [text] : [];
  });
}

function discoveryQueryArg(value: unknown): string {
  const query = textArg(value, 256, true).trim();
  if (/[\u0000-\u001f\u007f]/.test(query)) return invalidRequest();
  return query;
}

function parseDiscoveryPageOptions(
  value: unknown,
  allowCategory = false,
): { page?: number; pageSize?: number; category?: string } | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(
    value,
    allowCategory ? ["page", "pageSize", "category"] : ["page", "pageSize"],
  );
  const category =
    allowCategory && input.category !== undefined ? textArg(input.category, 100).trim() : undefined;
  return {
    ...(input.page === undefined ? {} : { page: integerArg(input.page, 1, 10_000) }),
    ...(input.pageSize === undefined ? {} : { pageSize: integerArg(input.pageSize, 1, 50) }),
    ...(category ? { category } : {}),
  };
}

function safeSkillRegistryEntry(value: unknown): RecordLike | null {
  const entry = safeDiscoveryRecord(value);
  const id = safeDiscoveryId(entry?.id);
  if (!entry || !id) return null;
  const source = entry.source === "clawhub" || entry.source === "cowork" ? entry.source : undefined;
  const metadata: RecordLike = {
    id,
    name: safeDiscoveryText(entry.name, 200) || id,
    description: safeDiscoveryText(entry.description, 1600) || "",
    version: safeDiscoveryText(entry.version, 80) || "",
  };
  if (source) metadata.source = source;
  for (const key of ["author", "category", "updatedAt", "icon"] as const) {
    const text = safeDiscoveryText(entry[key], key === "icon" ? 80 : 160);
    if (text) metadata[key] = text;
  }
  for (const key of [
    "downloads",
    "stars",
    "installsCurrent",
    "installsAllTime",
    "rating",
  ] as const) {
    const number = safeDiscoveryCount(entry[key]);
    if (number !== undefined) metadata[key] = number;
  }
  metadata.tags = safeDiscoveryTextList(entry.tags);
  return metadata;
}

function safeClawHubSkillUrl(value: unknown): string | undefined {
  const candidate = safeDiscoveryText(value, 2000);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (parsed.protocol !== "https:" || host !== "clawhub.ai") return undefined;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0]?.toLowerCase() === "skills") return undefined;
    const owner = safeDiscoveryId(parts[0]);
    const slug = safeDiscoveryId(parts[parts.length - 1]);
    return owner && slug ? `https://clawhub.ai/${owner}/${slug}` : undefined;
  } catch {
    return undefined;
  }
}

function safeSkillSearchResult(
  value: unknown,
  query: string,
  options?: { page?: number; pageSize?: number },
) {
  const result = safeDiscoveryRecord(value);
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 20;
  const rawEntries = Array.isArray(result?.results) ? result.results : [];
  const safeEntries = rawEntries.slice(0, pageSize).flatMap((entry) => {
    const safeEntry = safeSkillRegistryEntry(entry);
    return safeEntry ? [safeEntry] : [];
  });
  return boundedJsonListResult(
    { query, total: safeDiscoveryCount(result?.total) ?? rawEntries.length, page, pageSize },
    "results",
    safeEntries,
  );
}

function safePackRegistryEntry(value: unknown): RecordLike | null {
  const entry = safeDiscoveryRecord(value);
  const id = safeDiscoveryId(entry?.id);
  if (!entry || !id) return null;
  const pack: RecordLike = {
    id,
    name: safeDiscoveryText(entry.name, 200) || id,
    displayName:
      safeDiscoveryText(entry.displayName, 200) || safeDiscoveryText(entry.name, 200) || id,
    description: safeDiscoveryText(entry.description, 1600) || "",
  };
  const category = safeDiscoveryText(entry.category, 100);
  const skillCount = safeDiscoveryCount(entry.skillCount);
  if (category) pack.category = category;
  if (skillCount !== undefined) pack.skillCount = skillCount;
  return pack;
}

function safePackSearchResult(
  value: unknown,
  query: string,
  options?: { page?: number; pageSize?: number },
) {
  const result = safeDiscoveryRecord(value);
  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 20;
  const rawEntries = Array.isArray(result?.results) ? result.results : [];
  const safeEntries = rawEntries.slice(0, pageSize).flatMap((entry) => {
    const safeEntry = safePackRegistryEntry(entry);
    return safeEntry ? [safeEntry] : [];
  });
  return boundedJsonListResult(
    { query, total: safeDiscoveryCount(result?.total) ?? rawEntries.length, page, pageSize },
    "results",
    safeEntries,
  );
}

const SKILL_SOURCES = new Set(["bundled", "managed", "external", "workspace"]);
const SKILL_VERDICTS = new Set(["clean", "warning", "quarantined"]);
const SECURITY_SEVERITIES = new Set(["info", "warning", "critical"]);

function safeSecurityText(value: unknown, max = 1000): string | undefined {
  const text = safeDiscoveryText(value, max);
  if (!text) return text;
  return text
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s)]*/g, "[host path]")
    .replace(
      /\/(?:Users|home|tmp|private|var|Volumes|workspace|mnt)\/(?:[^\s/]+\/)*[^\s),;]*/gi,
      "[host path]",
    );
}

const PLUGIN_STATES = new Set(["loading", "loaded", "registered", "active", "error", "disabled"]);
const PLUGIN_SECURITY_VERDICTS = new Set(["clean", "warning", "quarantined"]);
const PACK_WORKFLOWS = new Set(["support_ops", "it_ops", "sales_ops"]);

function titleFromSafeId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safePluginPack(value: unknown, policies: ReturnType<typeof loadPoliciesStrict>) {
  const pack = safeDiscoveryRecord(value);
  const manifest = safeDiscoveryRecord(pack?.manifest) || pack;
  const name = safeDiscoveryId(manifest?.name ?? pack?.name);
  if (!pack || !manifest || !name) return null;

  const rawState = safeDiscoveryText(pack.state, 40);
  const state = rawState && PLUGIN_STATES.has(rawState) ? rawState : "disabled";
  const policyBlocked = !policies || !isPackAllowed(name, policies);
  const policyRequired = Boolean(policies && isPackRequired(name, policies));

  const safeSkills = (raw: unknown, directoryBacked = false) => {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_PLUGIN_PACK_CHILDREN).flatMap((value) => {
      const skill = safeDiscoveryRecord(value);
      const id = safeDiscoveryId(skill?.id);
      if (!skill || !id) return [];
      const description = safeSecurityText(skill.description, 1600);
      return [
        {
          id,
          name: safeSecurityText(skill.name, 200) || titleFromSafeId(id),
          description: description || (directoryBacked ? "Directory-backed skill" : ""),
          ...(safeSecurityText(skill.icon, 80) ? { icon: safeSecurityText(skill.icon, 80) } : {}),
          enabled: skill.enabled !== false,
        },
      ];
    });
  };

  const skills = [
    ...safeSkills(manifest.skills),
    ...safeSkills(manifest.skillDirectories, true),
  ].slice(0, MAX_PLUGIN_PACK_CHILDREN);

  const slashCommands = (Array.isArray(manifest.slashCommands) ? manifest.slashCommands : [])
    .slice(0, MAX_PLUGIN_PACK_CHILDREN)
    .flatMap((value) => {
      const command = safeDiscoveryRecord(value);
      const commandName = safeDiscoveryId(command?.name);
      const skillId = safeDiscoveryId(command?.skillId);
      if (!command || !commandName || !skillId) return [];
      return [
        {
          name: commandName,
          description: safeSecurityText(command.description, 1000) || "",
          skillId,
        },
      ];
    });

  const agentRoles = (Array.isArray(manifest.agentRoles) ? manifest.agentRoles : [])
    .slice(0, MAX_PLUGIN_PACK_CHILDREN)
    .flatMap((value) => {
      const role = safeDiscoveryRecord(value);
      const roleName = safeDiscoveryId(role?.name);
      const displayName = safeSecurityText(role?.displayName, 200);
      if (!role || !roleName || !displayName) return [];
      const color = safeDiscoveryText(role.color, 16);
      return [
        {
          name: roleName,
          displayName,
          ...(safeSecurityText(role.description, 1000)
            ? { description: safeSecurityText(role.description, 1000) }
            : {}),
          icon: safeSecurityText(role.icon, 80) || "",
          color: color && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color : "#808080",
        },
      ];
    });

  const verdictValue = safeDiscoveryText(safeDiscoveryRecord(pack.securityReport)?.verdict, 32);
  const verdict = verdictValue && PLUGIN_SECURITY_VERDICTS.has(verdictValue) ? verdictValue : null;
  const category = safeSecurityText(manifest.category, 100);
  const icon = safeSecurityText(manifest.icon, 80);
  const scope =
    manifest.scope === "personal" || manifest.scope === "organization" ? manifest.scope : undefined;
  const workflows = Array.isArray(manifest.bestFitWorkflows)
    ? manifest.bestFitWorkflows
        .slice(0, 12)
        .filter(
          (workflow): workflow is string =>
            typeof workflow === "string" && PACK_WORKFLOWS.has(workflow),
        )
    : [];

  return {
    name,
    displayName: safeSecurityText(manifest.displayName, 200) || name,
    version: safeSecurityText(manifest.version, 80) || "",
    description: safeSecurityText(manifest.description, 1600) || "",
    ...(icon ? { icon } : {}),
    ...(category ? { category } : {}),
    ...(scope ? { scope } : {}),
    ...(safeDiscoveryId(manifest.personaTemplateId)
      ? { personaTemplateId: safeDiscoveryId(manifest.personaTemplateId) }
      : {}),
    recommendedConnectors: safeDiscoveryTextList(manifest.recommendedConnectors, 32, 120).filter(
      (connector) => Boolean(safeDiscoveryId(connector)),
    ),
    ...(workflows.length ? { bestFitWorkflows: workflows } : {}),
    outcomeExamples: safeDiscoveryTextList(manifest.outcomeExamples, 12, 400)
      .map((example) => safeSecurityText(example, 400) || "")
      .filter(Boolean),
    skills,
    slashCommands,
    agentRoles,
    state,
    enabled: !policyBlocked && (state === "registered" || state === "active"),
    policyBlocked,
    policyRequired,
    ...(verdict
      ? {
          securityReport: {
            verdict,
            summary:
              verdict === "warning"
                ? "Security findings require review."
                : verdict === "quarantined"
                  ? "This pack is quarantined."
                  : "No security issue reported.",
          },
        }
      : {}),
  };
}

function safePluginPackList(value: unknown) {
  const policies = loadPoliciesStrict();
  const packs = Array.isArray(value) ? value : [];
  return boundedJsonArray(
    packs.slice(0, MAX_DISCOVERY_PLUGIN_PACKS).flatMap((pack) => {
      const safe = safePluginPack(pack, policies);
      return safe ? [safe] : [];
    }),
  );
}

function safePackToggleResult(value: unknown, name: string, enabled: boolean) {
  const result = safeDiscoveryRecord(value);
  if (result?.success !== true || result.name !== name || result.enabled !== enabled) {
    throw new WebApplicationError("INTERNAL_ERROR", "Pack toggle returned an invalid result.", 500);
  }
  return { success: true as const, name, enabled };
}

function safePackSkillToggleResult(
  value: unknown,
  packName: string,
  skillId: string,
  enabled: boolean,
) {
  const result = safeDiscoveryRecord(value);
  if (
    result?.success !== true ||
    result.packName !== packName ||
    result.skillId !== skillId ||
    result.enabled !== enabled
  ) {
    throw new WebApplicationError(
      "INTERNAL_ERROR",
      "Pack skill toggle returned an invalid result.",
      500,
    );
  }
  return { success: true as const, packName, skillId, enabled };
}

function safeSkillStatusReport(value: unknown) {
  const report = safeDiscoveryRecord(value);
  const rawSkills = Array.isArray(report?.skills) ? report.skills : [];
  const skills = rawSkills.slice(0, MAX_DISCOVERY_SKILLS).flatMap((value) => {
    const skill = safeDiscoveryRecord(value);
    const id = safeDiscoveryId(skill?.id);
    if (!skill || !id) return [];
    const source =
      typeof skill.source === "string" && SKILL_SOURCES.has(skill.source)
        ? skill.source
        : undefined;
    const securityReport = safeDiscoveryRecord(skill.securityReport);
    const safeEntry: RecordLike = {
      id,
      name: safeDiscoveryText(skill.name, 200) || id,
      description: safeDiscoveryText(skill.description, 1600) || "",
      eligible: skill.eligible === true,
      disabled: skill.disabled === true,
      blockedByAllowlist: skill.blockedByAllowlist === true,
      missing: {
        bins: safeDiscoveryTextList(safeDiscoveryRecord(skill.missing)?.bins, 32, 120),
        anyBins: safeDiscoveryTextList(safeDiscoveryRecord(skill.missing)?.anyBins, 32, 120),
        env: safeDiscoveryTextList(safeDiscoveryRecord(skill.missing)?.env, 32, 120),
        config: safeDiscoveryTextList(safeDiscoveryRecord(skill.missing)?.config, 32, 120),
        os: safeDiscoveryTextList(safeDiscoveryRecord(skill.missing)?.os, 32, 120),
      },
    };
    if (source) safeEntry.source = source;
    const icon = safeDiscoveryText(skill.icon, 80);
    const category = safeDiscoveryText(skill.category, 100);
    if (icon) safeEntry.icon = icon;
    if (category) safeEntry.category = category;
    const metadata = safeDiscoveryRecord(skill.metadata);
    const version = safeDiscoveryText(metadata?.version, 80);
    const clawHubUrl =
      safeClawHubSkillUrl(metadata?.homepage) || safeClawHubSkillUrl(metadata?.repository);
    if (version || clawHubUrl) {
      safeEntry.metadata = {
        ...(version ? { version } : {}),
        ...(clawHubUrl ? { homepage: clawHubUrl } : {}),
      };
    }
    if (securityReport && SKILL_VERDICTS.has(String(securityReport.verdict))) {
      safeEntry.securityReport = {
        verdict: securityReport.verdict,
        summary: safeSecurityText(securityReport.summary, 1000) || "",
      };
    }
    return [safeEntry];
  });
  const summary = safeDiscoveryRecord(report?.summary);
  const safeReport: RecordLike = {
    // Keep the legacy shape, but never reveal host filesystem locations.
    workspaceDir: "",
    managedSkillsDir: "",
    bundledSkillsDir: "",
    externalSkillDirs: [],
    skills,
    summary: {
      total: safeDiscoveryCount(summary?.total) ?? skills.length,
      eligible:
        safeDiscoveryCount(summary?.eligible) ?? skills.filter((skill) => skill.eligible).length,
      disabled:
        safeDiscoveryCount(summary?.disabled) ?? skills.filter((skill) => skill.disabled).length,
      missingRequirements:
        safeDiscoveryCount(summary?.missingRequirements) ??
        skills.filter((skill) => {
          const missing = safeDiscoveryRecord(skill.missing);
          return Object.values(missing || {}).some(
            (items) => Array.isArray(items) && items.length > 0,
          );
        }).length,
    },
  };
  return boundedJsonListResult(safeReport, "skills", skills);
}

function safeQuarantinedSkillImports(value: unknown) {
  if (!Array.isArray(value)) return [];
  return boundedJsonArray(
    value
      .filter((record) => safeDiscoveryRecord(record)?.bundleKind === "skill")
      .slice(0, MAX_DISCOVERY_QUARANTINE_RECORDS)
      .flatMap((value) => {
        const record = safeDiscoveryRecord(value);
        const id = safeDiscoveryId(record?.id);
        const bundleId = safeDiscoveryId(record?.bundleId);
        const report = safeDiscoveryRecord(record?.report);
        if (!record || !id || !bundleId || !report) return [];
        const verdict = SKILL_VERDICTS.has(String(report.verdict)) ? report.verdict : "quarantined";
        const rawFindings = Array.isArray(report.findings) ? report.findings : [];
        const findings = rawFindings.slice(0, 32).flatMap((value) => {
          const finding = safeDiscoveryRecord(value);
          if (!finding) return [];
          const severity = SECURITY_SEVERITIES.has(String(finding.severity))
            ? finding.severity
            : "warning";
          const code = safeDiscoveryText(finding.code, 100);
          const message = safeSecurityText(finding.message, 1200);
          return [{ ...(code ? { code } : {}), severity, message: message || "Security finding" }];
        });
        return [
          {
            id,
            bundleKind: "skill",
            bundleId,
            ...(safeDiscoveryText(record.displayName, 200)
              ? { displayName: safeDiscoveryText(record.displayName, 200) }
              : {}),
            quarantinedAt: safeDiscoveryText(record.quarantinedAt, 80) || "",
            summary: safeSecurityText(record.summary, 1200) || "Import quarantined",
            report: {
              verdict,
              summary: safeSecurityText(report.summary, 1200) || "Import quarantined",
              findings,
            },
          },
        ];
      }),
  );
}

const MCP_INSTALL_METHODS = new Set(["npm", "pip", "binary", "docker", "manual"]);
const MCP_TRANSPORTS = new Set(["stdio", "sse", "websocket", "streamable-http"]);
const MCP_STATUSES = new Set(["disconnected", "connecting", "connected", "reconnecting", "error"]);

function safeMCPRegistryEntry(value: unknown): RecordLike | null {
  const entry = safeDiscoveryRecord(value);
  const id = safeDiscoveryId(entry?.id);
  if (!entry || !id) return null;
  const installMethod = MCP_INSTALL_METHODS.has(String(entry.installMethod))
    ? entry.installMethod
    : "manual";
  const transport = MCP_TRANSPORTS.has(String(entry.transport)) ? entry.transport : "stdio";
  const tools = Array.isArray(entry.tools)
    ? entry.tools.slice(0, 100).flatMap((value) => {
        const tool = safeDiscoveryRecord(value);
        const name = safeDiscoveryText(tool?.name, 120);
        return name ? [{ name, description: safeDiscoveryText(tool?.description, 800) || "" }] : [];
      })
    : [];
  const safeEntry: RecordLike = {
    id,
    name: safeDiscoveryText(entry.name, 200) || id,
    description: safeDiscoveryText(entry.description, 2000) || "",
    version: safeDiscoveryText(entry.version, 80) || "",
    author: safeDiscoveryText(entry.author, 200) || "",
    installMethod,
    transport,
    tools,
    tags: safeDiscoveryTextList(entry.tags, 50, 100),
    verified: entry.verified === true,
  };
  for (const key of ["license", "category", "tagline"] as const) {
    const text = safeDiscoveryText(entry[key], 200);
    if (text) safeEntry[key] = text;
  }
  if (entry.featured === true) safeEntry.featured = true;
  const downloads = safeDiscoveryCount(entry.downloads);
  if (downloads !== undefined) safeEntry.downloads = downloads;
  // Deliberately omit homepage/repository URLs, commands, package install data,
  // default URLs, arguments, and environment values from browser discovery.
  return safeEntry;
}

function safeMCPRegistry(value: unknown) {
  const registry = safeDiscoveryRecord(value);
  const rawServers = Array.isArray(registry?.servers) ? registry.servers : [];
  const safeEntries = rawServers.slice(0, MAX_DISCOVERY_REGISTRY_ENTRIES).flatMap((server) => {
    const safeEntry = safeMCPRegistryEntry(server);
    return safeEntry ? [safeEntry] : [];
  });
  return boundedJsonListResult(
    {
      version: safeDiscoveryText(registry?.version, 80) || "",
      lastUpdated: safeDiscoveryText(registry?.lastUpdated, 80) || "",
    },
    "servers",
    safeEntries,
  );
}

function safeMCPStatuses(value: unknown) {
  if (!Array.isArray(value)) return [];
  return boundedJson(
    value.slice(0, MAX_DISCOVERY_REGISTRY_ENTRIES).flatMap((value) => {
      const status = safeDiscoveryRecord(value);
      const id = safeDiscoveryId(status?.id);
      if (!status || !id) return [];
      const safeStatus: RecordLike = {
        id,
        name: safeDiscoveryText(status.name, 200) || id,
        status: MCP_STATUSES.has(String(status.status)) ? status.status : "disconnected",
      };
      const lastPing = safeDiscoveryMetric(status.lastPing);
      const uptime = safeDiscoveryMetric(status.uptime);
      if (lastPing !== undefined) safeStatus.lastPing = lastPing;
      if (uptime !== undefined) safeStatus.uptime = uptime;
      // Errors, tools, resources, prompts, and server info can carry host paths,
      // command output, account details, or data returned by a connected server.
      return [safeStatus];
    }),
  );
}

function parseAgentListParams(value: unknown): RecordLike | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, ["limit", "offset", "status"]);
  const status = input.status;
  if (
    status !== undefined &&
    !["draft", "active", "suspended", "archived"].includes(String(status))
  ) {
    return invalidRequest();
  }
  return {
    ...(input.limit === undefined ? {} : { limit: integerArg(input.limit, 1, 500) }),
    ...(input.offset === undefined ? {} : { offset: integerArg(input.offset, 0, 1_000_000) }),
    ...(status === undefined ? {} : { status }),
  };
}

function parseEnvironmentListParams(value: unknown): RecordLike | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, ["limit", "offset", "status"]);
  if (input.status !== undefined && input.status !== "active" && input.status !== "archived") {
    return invalidRequest();
  }
  return {
    ...(input.limit === undefined ? {} : { limit: integerArg(input.limit, 1, 500) }),
    ...(input.offset === undefined ? {} : { offset: integerArg(input.offset, 0, 1_000_000) }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}

function validateManagedAgentRoutineCreate(value: unknown): CreateManagedAgentRoutineRequest {
  const input = requireRecord(value, ["agentId", "name", "description", "enabled", "trigger"]);
  const agentId = stringArg(input.agentId);
  const name = textArg(input.name, 200);
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  const enabled = optionalBoolean(input.enabled);
  const trigger = validateRoutineTriggerConfig(input.trigger);
  return {
    agentId,
    name,
    ...(input.description === undefined ? {} : { description: input.description as string }),
    ...(enabled === undefined ? {} : { enabled }),
    trigger,
  };
}

function validateManagedAgentRoutineUpdate(value: unknown): UpdateManagedAgentRoutineRequest {
  const input = requireRecord(value, [
    "agentId",
    "routineId",
    "name",
    "description",
    "enabled",
    "trigger",
  ]);
  const request: UpdateManagedAgentRoutineRequest = {
    agentId: stringArg(input.agentId),
    routineId: stringArg(input.routineId),
    ...(input.name === undefined ? {} : { name: textArg(input.name, 200) }),
    ...(input.description === undefined
      ? {}
      : { description: textArg(input.description, 4_000, true) }),
    ...(input.enabled === undefined ? {} : { enabled: optionalBoolean(input.enabled) }),
    ...(input.trigger === undefined
      ? {}
      : { trigger: validateRoutineTriggerConfig(input.trigger) }),
  };
  return request;
}

function validateSessionCreate(value: unknown): ManagedSessionCreateInput {
  const input = requireRecord(value, [
    "agentId",
    "environmentId",
    "title",
    "surface",
    "successCriteria",
    "initialEvent",
  ]);
  const surface = input.surface;
  if (
    surface !== undefined &&
    !["runtime", "agent_panel", "studio_preview"].includes(String(surface))
  )
    return invalidRequest();
  const initialEvent =
    input.initialEvent === undefined
      ? undefined
      : requireRecord(input.initialEvent, ["type", "content"]);
  let normalizedEvent: ManagedSessionCreateInput["initialEvent"];
  if (initialEvent) {
    if (
      initialEvent.type !== "user.message" ||
      !Array.isArray(initialEvent.content) ||
      initialEvent.content.length > 32
    )
      return invalidRequest();
    normalizedEvent = {
      type: "user.message",
      content: initialEvent.content.map((entry) => {
        const item = requireRecord(entry, ["type", "text", "artifactId"]);
        if (item.type === "text")
          return { type: "text" as const, text: textArg(item.text, 20_000) };
        if (item.type === "file")
          return { type: "file" as const, artifactId: stringArg(item.artifactId) };
        return invalidRequest();
      }),
    };
  }
  return boundedJson({
    agentId: stringArg(input.agentId),
    environmentId: stringArg(input.environmentId),
    title: textArg(input.title, 200),
    ...(surface === undefined ? {} : { surface }),
    ...(input.successCriteria === undefined
      ? {}
      : { successCriteria: textArg(input.successCriteria, 4_000, true) }),
    ...(normalizedEvent === undefined ? {} : { initialEvent: normalizedEvent }),
  }) as ManagedSessionCreateInput;
}

function validateSessionUserMessage(value: unknown): ManagedSessionUserMessageRequest {
  const input = requireRecord(value, ["sessionId", "content", "expectedTurnId"]);
  if (!Array.isArray(input.content) || input.content.length < 1 || input.content.length > 32)
    return invalidRequest();
  const content = input.content.map((entry) => {
    const item = requireRecord(entry, ["type", "text", "artifactId"]);
    if (item.type === "text") return { type: "text" as const, text: textArg(item.text, 20_000) };
    if (item.type === "file")
      return { type: "file" as const, artifactId: stringArg(item.artifactId) };
    return invalidRequest();
  });
  return {
    sessionId: stringArg(input.sessionId),
    content: content as ManagedSessionInputContent[],
    ...(input.expectedTurnId === undefined
      ? {}
      : { expectedTurnId: stringArg(input.expectedTurnId) }),
  };
}

function validateEverydayBundle(value: unknown): EverydayCapabilityBundle {
  if (
    typeof value !== "string" ||
    !EVERYDAY_AGENT_CAPABILITY_BUNDLES.some((bundle) => bundle.id === value)
  )
    return invalidRequest();
  return value as EverydayCapabilityBundle;
}

function validateEverydayProfileUpdate(value: unknown): EverydayAgentUpdateProfileRequest {
  const input = requireRecord(value, [
    "enabled",
    "capabilitySettings",
    "connectorAllowlists",
    "workspaceScopes",
    "accountScopes",
    "approvalPosture",
    "memoryPolicy",
    "activeHours",
    "retention",
    "browserProfilePolicy",
    "heartbeatCadenceMinutes",
    "maxConcurrentBackgroundWork",
  ]);
  if (input.enabled !== undefined) optionalBoolean(input.enabled);
  if (input.workspaceScopes !== undefined) stringArray(input.workspaceScopes);
  if (
    input.approvalPosture !== undefined &&
    !["review_first", "trusted_patterns", "review_only"].includes(String(input.approvalPosture))
  )
    return invalidRequest();
  if (input.heartbeatCadenceMinutes !== undefined)
    integerArg(input.heartbeatCadenceMinutes, 5, 1440);
  if (input.maxConcurrentBackgroundWork !== undefined)
    integerArg(input.maxConcurrentBackgroundWork, 1, 20);
  if (input.capabilitySettings !== undefined) {
    const settings = requireRecord(input.capabilitySettings);
    for (const [bundle, rawPatch] of Object.entries(settings)) {
      validateEverydayBundle(bundle);
      const patch = requireRecord(rawPatch, ["enabled", "paused", "revokedAt", "lastChangedAt"]);
      optionalBoolean(patch.enabled);
      optionalBoolean(patch.paused);
      if (patch.revokedAt !== undefined) integerArg(patch.revokedAt, 0, Number.MAX_SAFE_INTEGER);
      if (patch.lastChangedAt !== undefined)
        integerArg(patch.lastChangedAt, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  if (input.connectorAllowlists !== undefined) {
    const entries = requireRecord(input.connectorAllowlists);
    for (const [id, rawEntry] of Object.entries(entries)) {
      textArg(id, 200);
      const entry = requireRecord(rawEntry, [
        "connectorId",
        "enabled",
        "accountIds",
        "scopes",
        "paused",
      ]);
      if (entry.connectorId !== undefined) textArg(entry.connectorId, 200);
      optionalBoolean(entry.enabled);
      optionalBoolean(entry.paused);
      if (entry.accountIds !== undefined) stringArray(entry.accountIds);
      if (entry.scopes !== undefined) stringArray(entry.scopes);
    }
  }
  if (input.accountScopes !== undefined) {
    const scopes = requireRecord(input.accountScopes);
    for (const [provider, ids] of Object.entries(scopes)) {
      textArg(provider, 200);
      if (!Array.isArray(ids) || ids.length > 256) return invalidRequest();
      ids.forEach((id) => textArg(id, 512));
    }
  }
  if (input.memoryPolicy !== undefined) {
    const policy = requireRecord(input.memoryPolicy, [
      "reviewRequired",
      "allowPromptVisibleMemory",
      "suppressPrivateContent",
      "allowExternalMirror",
      "retentionDays",
      "allowedWorkspaceIds",
    ]);
    for (const key of [
      "reviewRequired",
      "allowPromptVisibleMemory",
      "suppressPrivateContent",
      "allowExternalMirror",
    ])
      optionalBoolean(policy[key]);
    if (policy.retentionDays !== undefined) integerArg(policy.retentionDays, 0, 3650);
    if (policy.allowedWorkspaceIds !== undefined) stringArray(policy.allowedWorkspaceIds);
  }
  if (input.activeHours !== undefined) {
    const hours = requireRecord(input.activeHours, ["enabled", "timezone", "windows"]);
    optionalBoolean(hours.enabled);
    if (hours.timezone !== undefined) textArg(hours.timezone, 100);
    if (hours.windows !== undefined) {
      if (!Array.isArray(hours.windows) || hours.windows.length > 32) return invalidRequest();
      for (const rawWindow of hours.windows) {
        const window = requireRecord(rawWindow, ["days", "start", "end"]);
        if (!Array.isArray(window.days) || window.days.length > 7) return invalidRequest();
        window.days.forEach((day) => integerArg(day, 0, 6));
        if (window.start !== undefined && !/^\d{2}:\d{2}$/.test(textArg(window.start, 5)))
          return invalidRequest();
        if (window.end !== undefined && !/^\d{2}:\d{2}$/.test(textArg(window.end, 5)))
          return invalidRequest();
      }
    }
  }
  if (input.retention !== undefined) {
    const retention = requireRecord(input.retention, [
      "receiptsDays",
      "previewsDays",
      "connectorCacheDays",
      "memoryCandidateDays",
      "routineProvenanceDays",
    ]);
    for (const value of Object.values(retention))
      if (value !== undefined) integerArg(value, 0, 3650);
  }
  if (input.browserProfilePolicy !== undefined) {
    const policy = requireRecord(input.browserProfilePolicy, [
      "mode",
      "preferVisibleBrowser",
      "allowRealBrowserAttach",
      "retainProfileMetadata",
    ]);
    if (
      policy.mode !== undefined &&
      !["visible_existing", "visible_ephemeral", "isolated_ephemeral"].includes(String(policy.mode))
    )
      return invalidRequest();
    for (const key of ["preferVisibleBrowser", "allowRealBrowserAttach", "retainProfileMetadata"])
      optionalBoolean(policy[key]);
  }
  return boundedJson(input) as EverydayAgentUpdateProfileRequest;
}

function validateEverydayPause(value: unknown): Partial<EverydayPauseScope> {
  const input = requireRecord(value, [
    "id",
    "kind",
    "capability",
    "targetId",
    "reason",
    "pausedAt",
    "expiresAt",
  ]);
  if (input.id !== undefined) stringArg(input.id);
  if (
    input.kind !== undefined &&
    !["global", "capability", "connector", "workspace", "device", "channel"].includes(
      String(input.kind),
    )
  )
    return invalidRequest();
  if (input.capability !== undefined) validateEverydayBundle(input.capability);
  if (input.targetId !== undefined) textArg(input.targetId, 512);
  if (input.reason !== undefined) textArg(input.reason, 2_000, true);
  if (input.pausedAt !== undefined) integerArg(input.pausedAt, 1, Number.MAX_SAFE_INTEGER);
  if (input.expiresAt !== undefined) integerArg(input.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  return boundedJson(input) as Partial<EverydayPauseScope>;
}

function validateEverydayActionPreview(value: unknown): EverydayActionPreviewInput {
  const input = requireRecord(value, [
    "profileId",
    "workspaceId",
    "capability",
    "title",
    "action",
    "toolName",
    "connectorId",
    "connectorAccountId",
    "browserProfileId",
    "channelId",
    "deviceId",
    "targetIdentity",
    "destination",
    "sourceEvidence",
    "proposedMutation",
    "affectedObjects",
    "rollbackAvailable",
    "metadata",
  ]);
  if (input.profileId !== undefined) stringArg(input.profileId);
  if (input.workspaceId !== undefined) stringArg(input.workspaceId);
  if (input.capability !== undefined) validateEverydayBundle(input.capability);
  textArg(input.title, 300);
  textArg(input.action, 10_000);
  for (const key of [
    "toolName",
    "connectorId",
    "connectorAccountId",
    "browserProfileId",
    "channelId",
    "deviceId",
    "targetIdentity",
    "destination",
    "proposedMutation",
  ]) {
    if (input[key] !== undefined)
      textArg(input[key], key === "proposedMutation" ? 20_000 : 2_048, true);
  }
  if (input.sourceEvidence !== undefined) stringArray(input.sourceEvidence, 20);
  if (input.affectedObjects !== undefined) stringArray(input.affectedObjects, 100);
  optionalBoolean(input.rollbackAvailable);
  if (input.metadata !== undefined) boundedJson(requireRecord(input.metadata));
  return boundedJson(input) as EverydayActionPreviewInput;
}

function validateEverydayApprove(value: unknown): EverydayAgentApproveActionRequest {
  const input = requireRecord(value, ["previewId", "approvalId", "note"]);
  return {
    previewId: stringArg(input.previewId),
    ...(input.approvalId === undefined ? {} : { approvalId: stringArg(input.approvalId) }),
    ...(input.note === undefined ? {} : { note: textArg(input.note, 4_000, true) }),
  };
}

function validateAgentBuilderCreate(value: unknown): AgentBuilderCreateRequest {
  const input = requireRecord(value, ["plan", "workspaceId", "activate"]);
  const plan = requireRecord(input.plan, [
    "id",
    "sourcePrompt",
    "name",
    "subtitle",
    "description",
    "icon",
    "color",
    "templateId",
    "workflowBrief",
    "capabilities",
    "selectedToolFamilies",
    "selectedMcpServers",
    "connectedMcpServers",
    "recommendedMissingIntegrations",
    "missingConnections",
    "selectedSkills",
    "selectionRequirements",
    "instructions",
    "operatingNotes",
    "starterPrompts",
    "scheduleSuggestion",
    "scheduleConfig",
    "routines",
    "memoryConfig",
    "approvalPolicy",
    "sharing",
    "deployment",
    "accessProfileId",
    "enableShell",
    "enableBrowser",
    "enableComputerUse",
    "rationale",
    "checklist",
    "generatedAt",
    "fallbackUsed",
  ]);
  for (const key of [
    "id",
    "sourcePrompt",
    "name",
    "subtitle",
    "description",
    "icon",
    "color",
    "workflowBrief",
    "instructions",
    "operatingNotes",
  ]) {
    textArg(
      plan[key],
      key === "instructions" || key === "sourcePrompt" || key === "workflowBrief" ? 100_000 : 4_000,
      key === "subtitle" || key === "description" || key === "operatingNotes",
    );
  }
  for (const key of [
    "capabilities",
    "selectedMcpServers",
    "connectedMcpServers",
    "selectedSkills",
    "rationale",
    "checklist",
  ]) {
    if (!Array.isArray(plan[key])) return invalidRequest();
    stringArray(plan[key]);
  }
  if (!Array.isArray(plan.selectedToolFamilies) || plan.selectedToolFamilies.length > 64)
    return invalidRequest();
  for (const family of plan.selectedToolFamilies) textArg(family, 100);
  for (const key of ["templateId", "accessProfileId"])
    if (plan[key] !== undefined) stringArg(plan[key]);
  for (const key of ["enableShell", "enableBrowser", "enableComputerUse"])
    if (typeof plan[key] !== "boolean") return invalidRequest();
  if (plan.generatedAt !== undefined) integerArg(plan.generatedAt, 0, Number.MAX_SAFE_INTEGER);
  if (plan.fallbackUsed !== undefined && typeof plan.fallbackUsed !== "boolean")
    return invalidRequest();
  for (const key of [
    "recommendedMissingIntegrations",
    "missingConnections",
    "selectionRequirements",
    "starterPrompts",
    "routines",
  ]) {
    if (plan[key] !== undefined && !Array.isArray(plan[key])) return invalidRequest();
    if (plan[key] !== undefined) boundedJson(plan[key]);
  }
  if (plan.selectionRequirements !== undefined) {
    for (const rawRequirement of plan.selectionRequirements as unknown[]) {
      const requirement = requireRecord(rawRequirement, [
        "id",
        "kind",
        "title",
        "reason",
        "required",
        "options",
        "selectedOptionId",
      ]);
      stringArg(requirement.id);
      textArg(requirement.title, 300);
      textArg(requirement.reason, 4_000, true);
      if (typeof requirement.required !== "boolean") return invalidRequest();
      if (requirement.selectedOptionId !== undefined) stringArg(requirement.selectedOptionId);
      if (requirement.required && requirement.selectedOptionId === undefined)
        return invalidRequest();
    }
  }
  if (plan.routines !== undefined) {
    for (const rawRoutine of plan.routines as unknown[]) {
      const routine = requireRecord(rawRoutine, ["name", "description", "enabled", "trigger"]);
      textArg(routine.name, 200);
      if (routine.description !== undefined) textArg(routine.description, 4_000, true);
      if (typeof routine.enabled !== "boolean") return invalidRequest();
      validateRoutineTriggerConfig(routine.trigger);
    }
  }
  for (const key of ["scheduleConfig", "memoryConfig", "approvalPolicy", "sharing", "deployment"]) {
    if (plan[key] !== undefined) boundedJson(requireRecord(plan[key]));
  }
  const normalizedPlan = boundedJson(plan) as AgentBuilderCreateRequest["plan"];
  return {
    plan: normalizedPlan,
    ...(input.workspaceId === undefined ? {} : { workspaceId: stringArg(input.workspaceId) }),
    ...(input.activate === undefined ? {} : { activate: optionalBoolean(input.activate) }),
  };
}

function validateCronSchedule(value: unknown): CronSchedule {
  const input = requireRecord(value);
  if (input.kind === "at") {
    requireRecord(input, ["kind", "atMs"]);
    return { kind: "at", atMs: integerArg(input.atMs, 1, Number.MAX_SAFE_INTEGER) };
  }
  if (input.kind === "every") {
    requireRecord(input, ["kind", "everyMs", "anchorMs"]);
    return {
      kind: "every",
      everyMs: integerArg(input.everyMs, 1_000, 365 * 24 * 60 * 60 * 1000),
      ...(input.anchorMs === undefined
        ? {}
        : { anchorMs: integerArg(input.anchorMs, 1, Number.MAX_SAFE_INTEGER) }),
    };
  }
  if (input.kind === "cron") {
    requireRecord(input, ["kind", "expr", "tz"]);
    return {
      kind: "cron",
      expr: textArg(input.expr, 120),
      ...(input.tz === undefined ? {} : { tz: textArg(input.tz, 100) }),
    };
  }
  return invalidRequest();
}

const CRON_JOB_FIELDS = [
  "name",
  "description",
  "enabled",
  "accessProfileId",
  "shellAccess",
  "allowUserInput",
  "deleteAfterRun",
  "schedule",
  "workspaceId",
  "taskPrompt",
  "taskTitle",
  "assignedAgentRoleId",
  "runMode",
  "targetTaskId",
  "workflowRoutineId",
  "threadAutomation",
  "timeoutMs",
  "modelKey",
  "maxHistoryEntries",
  "delivery",
] as const;

function validateCronJobFields(value: unknown, partial: boolean): RecordLike {
  const input = requireRecord(value, CRON_JOB_FIELDS);
  if (!partial || input.name !== undefined) textArg(input.name, 200);
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  if (!partial || input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return invalidRequest();
  }
  if (input.accessProfileId !== undefined) stringArg(input.accessProfileId, 160);
  // Browser clients may preserve a legacy job's disabled shell override, but
  // cannot create or grant that deprecated privilege through this API.
  if (input.shellAccess === true) return invalidRequest();
  optionalBoolean(input.shellAccess);
  optionalBoolean(input.allowUserInput);
  optionalBoolean(input.deleteAfterRun);
  if (!partial || input.schedule !== undefined) validateCronSchedule(input.schedule);
  if (!partial || input.workspaceId !== undefined) stringArg(input.workspaceId);
  if (!partial || input.taskPrompt !== undefined) textArg(input.taskPrompt, 100_000);
  for (const key of ["assignedAgentRoleId", "targetTaskId", "workflowRoutineId"]) {
    if (input[key] !== undefined) stringArg(input[key]);
  }
  if (input.taskTitle !== undefined) textArg(input.taskTitle, 200);
  if (
    input.runMode !== undefined &&
    !["new_task", "thread_follow_up", "workflow"].includes(String(input.runMode))
  )
    return invalidRequest();
  if (input.threadAutomation !== undefined) {
    const thread = requireRecord(input.threadAutomation, [
      "sourceTaskId",
      "sourceTaskTitle",
      "sourceLink",
      "wakeObjective",
      "includeContextBrief",
    ]);
    for (const key of ["sourceTaskId"]) if (thread[key] !== undefined) stringArg(thread[key]);
    for (const key of ["sourceTaskTitle", "sourceLink", "wakeObjective"])
      if (thread[key] !== undefined)
        textArg(thread[key], key === "wakeObjective" ? 20_000 : 2_048, true);
    optionalBoolean(thread.includeContextBrief);
  }
  if (input.timeoutMs !== undefined) integerArg(input.timeoutMs, 1_000, 24 * 60 * 60 * 1000);
  if (input.modelKey !== undefined) textArg(input.modelKey, 200);
  if (input.maxHistoryEntries !== undefined) integerArg(input.maxHistoryEntries, 1, 500);
  if (input.delivery !== undefined) {
    const delivery = requireRecord(input.delivery, [
      "enabled",
      "channelType",
      "channelDbId",
      "channelId",
      "deliverOnSuccess",
      "deliverOnError",
      "summaryOnly",
      "deliverOnlyIfResult",
    ]);
    if (typeof delivery.enabled !== "boolean") return invalidRequest();
    for (const key of ["deliverOnSuccess", "deliverOnError", "summaryOnly", "deliverOnlyIfResult"])
      optionalBoolean(delivery[key]);
    if (delivery.channelType !== undefined) textArg(delivery.channelType, 100);
    if (delivery.channelDbId !== undefined) stringArg(delivery.channelDbId);
    if (delivery.channelId !== undefined) textArg(delivery.channelId, 512);
  }
  return boundedJson({
    ...input,
    ...(input.schedule === undefined ? {} : { schedule: validateCronSchedule(input.schedule) }),
  }) as RecordLike;
}

function safeCronJob(job: CronJob): Omit<CronJob, "taskAgentConfig" | "shellAccess"> {
  const { taskAgentConfig: _taskAgentConfig, shellAccess: _shellAccess, ...safe } = job;
  const { runHistory, ...state } = safe.state;
  return {
    ...safe,
    state: {
      ...state,
      ...(runHistory
        ? {
            runHistory: runHistory.map(
              ({ runWorkspacePath: _runWorkspacePath, ...entry }) => entry,
            ),
          }
        : {}),
    },
  };
}

function safeEventTrigger(trigger: EventTrigger) {
  const { agentConfig: _agentConfig, ...config } = trigger.action.config;
  return { ...trigger, action: { ...trigger.action, config } };
}

function safeBrowserPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeBrowserPayload);
  if (!value || typeof value !== "object") return value;
  const output: RecordLike = {};
  for (const [key, entry] of Object.entries(value as RecordLike)) {
    if (/(path|token|secret|password|credential|agentconfig)/i.test(key)) continue;
    output[key] = safeBrowserPayload(entry);
  }
  return output;
}

function validateEventTriggerInput(value: unknown, partial = false): RecordLike {
  const fields = [
    "name",
    "description",
    "enabled",
    "source",
    "conditions",
    "conditionLogic",
    "action",
    "workspaceId",
    "cooldownMs",
  ];
  const input = requireRecord(value, fields);
  if (!partial || input.name !== undefined) textArg(input.name, 200);
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  if (input.enabled !== undefined) optionalBoolean(input.enabled);
  if (
    input.source !== undefined &&
    ![
      "channel_message",
      "email",
      "mailbox_event",
      "webhook",
      "connector_event",
      "github_event",
      "file_change",
      "cron_event",
    ].includes(String(input.source))
  )
    return invalidRequest();
  if (
    input.conditionLogic !== undefined &&
    input.conditionLogic !== "all" &&
    input.conditionLogic !== "any"
  )
    return invalidRequest();
  if (!partial || input.workspaceId !== undefined) stringArg(input.workspaceId);
  if (input.cooldownMs !== undefined) integerArg(input.cooldownMs, 0, 24 * 60 * 60 * 1000);
  if (input.conditions !== undefined) {
    if (!Array.isArray(input.conditions) || input.conditions.length > 64) return invalidRequest();
    for (const raw of input.conditions) {
      const condition = requireRecord(raw, ["field", "operator", "value"]);
      textArg(condition.field, 200);
      if (
        ![
          "equals",
          "not_equals",
          "contains",
          "not_contains",
          "matches",
          "starts_with",
          "ends_with",
          "gt",
          "lt",
        ].includes(String(condition.operator))
      )
        return invalidRequest();
      textArg(condition.value, 2_000, true);
    }
  }
  if (input.action !== undefined) {
    const action = requireRecord(input.action, ["type", "config"]);
    if (!["create_task", "send_message", "wake_agent"].includes(String(action.type)))
      return invalidRequest();
    const config = requireRecord(action.config, [
      "prompt",
      "title",
      "channelType",
      "channelId",
      "message",
      "agentRoleId",
      "workspaceId",
      "runMode",
      "targetTaskId",
    ]);
    for (const key of ["prompt", "message"])
      if (config[key] !== undefined) textArg(config[key], 100_000);
    for (const key of [
      "title",
      "channelType",
      "channelId",
      "agentRoleId",
      "workspaceId",
      "targetTaskId",
    ])
      if (config[key] !== undefined) textArg(config[key], 2_048);
    if (
      config.runMode !== undefined &&
      config.runMode !== "new_task" &&
      config.runMode !== "thread_follow_up"
    )
      return invalidRequest();
    if (
      config.workspaceId !== undefined &&
      input.workspaceId !== undefined &&
      config.workspaceId !== input.workspaceId
    )
      return invalidRequest();
    if (action.type === "create_task" && config.prompt === undefined) return invalidRequest();
    if (
      action.type === "send_message" &&
      (config.message === undefined ||
        config.channelId === undefined ||
        config.channelType === undefined)
    )
      return invalidRequest();
    if (
      action.type === "wake_agent" &&
      (config.agentRoleId === undefined || config.prompt === undefined)
    )
      return invalidRequest();
  }
  if (
    !partial &&
    (input.source === undefined ||
      input.action === undefined ||
      !Array.isArray(input.conditions) ||
      typeof input.enabled !== "boolean")
  )
    return invalidRequest();
  return boundedJson(input) as RecordLike;
}

function parseSessionListParams(value: unknown): RecordLike | undefined {
  if (value === undefined) return undefined;
  const input = requireRecord(value, [
    "limit",
    "offset",
    "agentId",
    "workspaceId",
    "status",
    "surface",
  ]);
  const statuses = [
    "pending",
    "running",
    "awaiting_input",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
  ];
  const surfaces = ["runtime", "agent_panel", "studio_preview"];
  if (input.status !== undefined && !statuses.includes(String(input.status)))
    return invalidRequest();
  if (input.surface !== undefined && !surfaces.includes(String(input.surface)))
    return invalidRequest();
  return {
    ...(input.limit === undefined ? {} : { limit: integerArg(input.limit, 1, 200) }),
    ...(input.offset === undefined ? {} : { offset: integerArg(input.offset, 0, 1_000_000) }),
    ...(input.agentId === undefined ? {} : { agentId: stringArg(input.agentId) }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: stringArg(input.workspaceId) }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };
}

function definition(
  capability: BrowserDesktopDefinition["capability"],
  handler: BrowserDesktopDefinition["handler"],
  options: Pick<BrowserDesktopDefinition, "mutation" | "minArgs" | "maxArgs" | "validate"> = {},
): BrowserDesktopDefinition {
  return { capability, ...options, handler };
}

function simpleIdValidator(args: unknown[]): unknown[] {
  return [stringArg(args[0])];
}

function parseBotNotificationPolicyUpdate(value: unknown): {
  agentRoleId: string;
  onFinish?: boolean;
  onInputRequired?: boolean;
} {
  const request = requireRecord(value, ["agentRoleId", "onFinish", "onInputRequired"]);
  if (
    (request.onFinish !== undefined && typeof request.onFinish !== "boolean") ||
    (request.onInputRequired !== undefined && typeof request.onInputRequired !== "boolean")
  ) {
    return invalidRequest();
  }
  return {
    agentRoleId: stringArg(request.agentRoleId),
    ...(request.onFinish === undefined ? {} : { onFinish: request.onFinish }),
    ...(request.onInputRequired === undefined ? {} : { onInputRequired: request.onInputRequired }),
  };
}

function parseBotConversationReopenRequest(value: unknown): BotConversationReopenRequest {
  const request = requireRecord(value, [
    "workspaceId",
    "taskId",
    "agentRoleId",
    "repairMembership",
  ]);
  if (
    (request.taskId !== undefined && typeof request.taskId !== "string") ||
    (request.agentRoleId !== undefined && typeof request.agentRoleId !== "string") ||
    (request.repairMembership !== undefined && typeof request.repairMembership !== "boolean")
  ) {
    return invalidRequest();
  }
  const taskId = request.taskId === undefined ? undefined : stringArg(request.taskId);
  const agentRoleId =
    request.agentRoleId === undefined ? undefined : stringArg(request.agentRoleId);
  if (!taskId && !agentRoleId) return invalidRequest();
  return {
    workspaceId: stringArg(request.workspaceId),
    ...(taskId ? { taskId } : {}),
    ...(agentRoleId ? { agentRoleId } : {}),
    ...(request.repairMembership === true ? { repairMembership: true } : {}),
  };
}

function workflowCapabilitiesWithRuntimeState(
  capabilities: ReturnType<RoutineService["getWorkflowCapabilities"]>,
  hasExecutor: boolean,
  hasEventRuntime: boolean,
) {
  return {
    ...capabilities,
    operations: capabilities.operations.map((operation) => {
      const isExternalStarter =
        operation.kind === "starter" &&
        !["starter.manual", "starter.schedule"].includes(operation.id);
      const requiresExecutor = ["action", "ai", "agent", "custom"].includes(operation.kind);
      return {
        ...operation,
        ...((isExternalStarter && !hasEventRuntime) || (requiresExecutor && !hasExecutor)
          ? { availability: "preview" as const }
          : {}),
      };
    }),
  };
}

function routineWithoutSecrets(routine: Routine): Routine {
  return {
    ...routine,
    triggers: routine.triggers.map((trigger) =>
      trigger.type === "api" ? { ...trigger, token: undefined } : trigger,
    ),
  };
}

function safeWorkspace(workspace: Workspace): Workspace {
  const profile = resolveEffectiveAccessProfile({
    workspace,
    settings: PermissionSettingsManager.loadSettings(),
    adminPolicies: loadPolicies(),
  });
  const scoped = applyAccessProfileToWorkspace(workspace, profile);
  return {
    id: scoped.id,
    name: scoped.name,
    path: scoped.path,
    createdAt: scoped.createdAt,
    lastUsedAt: scoped.lastUsedAt,
    isTemp: scoped.isTemp,
    permissions: {
      read: scoped.permissions.read === true,
      write: scoped.permissions.write === true,
      delete: scoped.permissions.delete === true,
      network: scoped.permissions.network === true,
      shell: scoped.permissions.shell === true,
      accessProfileId: scoped.permissions.accessProfileId,
      accessProfileUnavailable: scoped.permissions.accessProfileUnavailable,
      accessProfileScoped: scoped.permissions.accessProfileScoped,
      accessFilesystemScoped: scoped.permissions.accessFilesystemScoped,
    },
  };
}

function sanitizeEnvironment(environment: ManagedEnvironment): ManagedEnvironment {
  const filePaths = (environment.config.filePaths || []).filter((filePath) =>
    isWorkspaceRelativePath(filePath),
  );
  return {
    ...environment,
    config: {
      ...environment.config,
      filePaths,
      credentialRefs: [],
      managedAccountRefs: [],
    },
  };
}

function isWorkspaceRelativePath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("://")
  ) {
    return false;
  }
  const segments = value.replace(/\\/g, "/").split("/");
  return segments.every((segment) => segment !== ".." && segment !== ".");
}

function validateEnvironmentInput(value: unknown, update: boolean): RecordLike {
  const allowed = update ? ["environmentId", "name", "config"] : ["name", "kind", "config"];
  const input = requireRecord(value, allowed);
  if (update) stringArg(input.environmentId);
  if (input.name !== undefined) textArg(input.name, 200);
  if (!update && input.name === undefined) return invalidRequest();
  if (input.kind !== undefined && input.kind !== "cowork_local") return invalidRequest();
  if (input.config !== undefined) {
    const config = requireRecord(input.config, [
      "workspaceId",
      "accessProfileId",
      "requireWorktree",
      "enableShell",
      "enableBrowser",
      "enableComputerUse",
      "allowedMcpServerIds",
      "skillPackIds",
      "filePaths",
      "allowedToolFamilies",
      "credentialRefs",
      "managedAccountRefs",
    ]);
    if (config.workspaceId !== undefined) stringArg(config.workspaceId);
    if (config.accessProfileId !== undefined) stringArg(config.accessProfileId);
    for (const key of ["requireWorktree", "enableShell", "enableBrowser", "enableComputerUse"]) {
      if (config[key] !== undefined && typeof config[key] !== "boolean") return invalidRequest();
    }
    for (const key of [
      "allowedMcpServerIds",
      "skillPackIds",
      "allowedToolFamilies",
      "credentialRefs",
      "managedAccountRefs",
    ]) {
      if (config[key] !== undefined) stringArray(config[key]);
    }
    if (config.filePaths !== undefined) {
      const paths = stringArray(config.filePaths);
      if (paths.some((filePath) => !isWorkspaceRelativePath(filePath))) return invalidRequest();
    }
  } else if (!update) {
    return invalidRequest();
  }
  return boundedJson(input) as RecordLike;
}

function validateAgentCreate(value: unknown): RecordLike {
  const input = requireRecord(value, [
    "name",
    "description",
    "systemPrompt",
    "executionMode",
    "model",
    "runtimeDefaults",
    "skills",
    "mcpServers",
    "teamTemplate",
    "metadata",
  ]);
  textArg(input.name, 200);
  textArg(input.systemPrompt, 100_000);
  if (input.executionMode !== "solo" && input.executionMode !== "team") return invalidRequest();
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  if (input.skills !== undefined) stringArray(input.skills);
  if (input.mcpServers !== undefined) stringArray(input.mcpServers);
  for (const key of ["model", "runtimeDefaults", "teamTemplate", "metadata"]) {
    if (input[key] !== undefined) boundedJson(input[key]);
  }
  return boundedJson(input) as RecordLike;
}

function validateAgentUpdate(value: unknown): RecordLike {
  const input = requireRecord(value, [
    "agentId",
    "name",
    "description",
    "systemPrompt",
    "executionMode",
    "model",
    "runtimeDefaults",
    "skills",
    "mcpServers",
    "teamTemplate",
    "metadata",
  ]);
  stringArg(input.agentId);
  if (input.name !== undefined) textArg(input.name, 200);
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  if (input.systemPrompt !== undefined) textArg(input.systemPrompt, 100_000);
  if (
    input.executionMode !== undefined &&
    input.executionMode !== "solo" &&
    input.executionMode !== "team"
  )
    return invalidRequest();
  if (input.skills !== undefined) stringArray(input.skills);
  if (input.mcpServers !== undefined) stringArray(input.mcpServers);
  for (const key of ["model", "runtimeDefaults", "teamTemplate", "metadata"]) {
    if (input[key] !== undefined) boundedJson(input[key]);
  }
  return boundedJson(input) as RecordLike;
}

function validateRoutineCreate(value: unknown): RecordLike {
  const input = requireRecord(value, [
    "name",
    "description",
    "enabled",
    "workspaceId",
    "instructions",
    "prompt",
    "executionTarget",
    "contextBindings",
    "triggers",
    "outputs",
    "approvalPolicy",
    "connectorPolicy",
    "connectors",
    "workflow",
    "activeWorkflowVersionId",
  ]);
  textArg(input.name, 200);
  stringArg(input.workspaceId);
  if (input.description !== undefined) textArg(input.description, 4_000, true);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return invalidRequest();
  if (input.instructions !== undefined) textArg(input.instructions, 100_000);
  if (input.prompt !== undefined) textArg(input.prompt, 100_000);
  input.executionTarget = validateRoutineExecutionTarget(input.executionTarget);
  if (input.contextBindings !== undefined) validateRoutineContextBindings(input.contextBindings);
  if (input.triggers !== undefined) input.triggers = validateRoutineTriggers(input.triggers);
  if (input.outputs !== undefined) input.outputs = validateRoutineOutputs(input.outputs);
  if (input.approvalPolicy !== undefined) validateRoutineApprovalPolicy(input.approvalPolicy);
  if (input.connectorPolicy !== undefined) validateRoutineConnectorPolicy(input.connectorPolicy);
  if (input.workflow !== undefined) validateWorkflowShape(input.workflow);
  if (input.connectors !== undefined) stringArray(input.connectors);
  return boundedJson(input) as RecordLike;
}

function validateRoutinePatch(args: unknown[]): unknown[] {
  const id = stringArg(args[0]);
  const patch = requireRecord(args[1], [
    "name",
    "description",
    "enabled",
    "workspaceId",
    "instructions",
    "prompt",
    "executionTarget",
    "contextBindings",
    "triggers",
    "outputs",
    "approvalPolicy",
    "connectorPolicy",
    "connectors",
    "workflow",
    "activeWorkflowVersionId",
  ]);
  if (patch.name !== undefined) textArg(patch.name, 200);
  if (patch.workspaceId !== undefined) stringArg(patch.workspaceId);
  if (patch.description !== undefined) textArg(patch.description, 4_000, true);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") return invalidRequest();
  if (patch.instructions !== undefined) textArg(patch.instructions, 100_000);
  if (patch.prompt !== undefined) textArg(patch.prompt, 100_000);
  if (patch.executionTarget !== undefined)
    patch.executionTarget = validateRoutineExecutionTarget(patch.executionTarget);
  if (patch.contextBindings !== undefined) validateRoutineContextBindings(patch.contextBindings);
  if (patch.triggers !== undefined) patch.triggers = validateRoutineTriggers(patch.triggers);
  if (patch.outputs !== undefined) patch.outputs = validateRoutineOutputs(patch.outputs);
  if (patch.approvalPolicy !== undefined) validateRoutineApprovalPolicy(patch.approvalPolicy);
  if (patch.connectorPolicy !== undefined) validateRoutineConnectorPolicy(patch.connectorPolicy);
  if (patch.workflow !== undefined) validateWorkflowShape(patch.workflow);
  if (patch.connectors !== undefined) stringArray(patch.connectors);
  return [id, boundedJson(patch)];
}

function validateRoutineTriggerConfig(value: unknown): ManagedAgentRoutineTriggerConfig {
  const input = requireRecord(value, [
    "id",
    "type",
    "enabled",
    "cadenceMinutes",
    "path",
    "connectorId",
    "changeType",
    "resourceUriContains",
    "channelType",
    "chatId",
    "textContains",
    "senderContains",
    "eventType",
    "subjectContains",
    "provider",
    "labelContains",
    "eventName",
    "repository",
    "action",
    "ref",
  ]);
  if (typeof input.type !== "string" || !ROUTINE_TRIGGER_TYPES.has(input.type))
    return invalidRequest();
  if (input.id !== undefined) stringArg(input.id);
  if (input.enabled !== undefined) optionalBoolean(input.enabled);
  if (input.cadenceMinutes !== undefined) integerArg(input.cadenceMinutes, 1, 525_600);
  for (const key of [
    "path",
    "connectorId",
    "changeType",
    "resourceUriContains",
    "channelType",
    "chatId",
    "textContains",
    "senderContains",
    "eventType",
    "subjectContains",
    "provider",
    "labelContains",
    "eventName",
    "repository",
    "action",
    "ref",
  ]) {
    if (input[key] !== undefined)
      textArg(input[key], key === "path" || key === "resourceUriContains" ? 2_048 : 512, true);
  }
  return boundedJson(input) as unknown as ManagedAgentRoutineTriggerConfig;
}

function validateRoutineExecutionTarget(value: unknown): RecordLike {
  const input = requireRecord(value, ["kind", "managedEnvironmentId"]);
  if (input.kind !== "workspace" && input.kind !== "managed_environment") return invalidRequest();
  if (input.kind === "managed_environment") stringArg(input.managedEnvironmentId);
  else if (input.managedEnvironmentId !== undefined) return invalidRequest();
  return boundedJson(input) as RecordLike;
}

function validateRoutineContextBindings(value: unknown): RecordLike {
  const input = requireRecord(value, ["chatContext", "metadata"]);
  if (input.chatContext !== undefined) {
    const chat = requireRecord(input.chatContext, ["channelType", "channelId"]);
    if (chat.channelType !== undefined) textArg(chat.channelType, 100);
    if (chat.channelId !== undefined) textArg(chat.channelId, 512);
  }
  if (input.metadata !== undefined) {
    const metadata = requireRecord(input.metadata);
    if (Object.keys(metadata).length > 100) return invalidRequest();
    for (const [key, item] of Object.entries(metadata)) {
      textArg(key, 200);
      textArg(item, 2_000, true);
    }
  }
  return boundedJson(input) as RecordLike;
}

function validateRoutineTriggers(value: unknown): RecordLike[] {
  if (!Array.isArray(value) || value.length > 32) return invalidRequest();
  return value.map((raw) => {
    const trigger = requireRecord(raw, [
      "id",
      "type",
      "enabled",
      "schedule",
      "path",
      "cooldownMs",
      "conditions",
      "connectorId",
      "changeType",
      "resourceUriContains",
      "channelType",
      "chatId",
      "textContains",
      "senderContains",
      "eventType",
      "subjectContains",
      "provider",
      "labelContains",
      "eventName",
      "repository",
      "action",
      "ref",
    ]);
    if (typeof trigger.type !== "string" || !ROUTINE_TRIGGER_TYPES.has(trigger.type))
      return invalidRequest();
    if (trigger.id !== undefined) stringArg(trigger.id);
    if (trigger.enabled !== undefined) optionalBoolean(trigger.enabled);
    if (trigger.type === "schedule") {
      if (trigger.schedule === undefined) return invalidRequest();
      validateCronSchedule(trigger.schedule);
    }
    if (trigger.type === "api" && trigger.path !== undefined) textArg(trigger.path, 2_048);
    if (trigger.cooldownMs !== undefined) integerArg(trigger.cooldownMs, 0, 24 * 60 * 60 * 1000);
    if (trigger.conditions !== undefined) {
      if (!Array.isArray(trigger.conditions) || trigger.conditions.length > 64)
        return invalidRequest();
      for (const rawCondition of trigger.conditions) {
        const condition = requireRecord(rawCondition, ["field", "operator", "value"]);
        textArg(condition.field, 200);
        if (
          ![
            "equals",
            "not_equals",
            "contains",
            "not_contains",
            "matches",
            "starts_with",
            "ends_with",
            "gt",
            "lt",
          ].includes(String(condition.operator))
        )
          return invalidRequest();
        textArg(condition.value, 2_000, true);
      }
    }
    for (const key of [
      "connectorId",
      "changeType",
      "resourceUriContains",
      "channelType",
      "chatId",
      "textContains",
      "senderContains",
      "eventType",
      "subjectContains",
      "provider",
      "labelContains",
      "eventName",
      "repository",
      "action",
      "ref",
    ]) {
      if (trigger[key] !== undefined)
        textArg(trigger[key], key === "resourceUriContains" ? 2_048 : 512, true);
    }
    return boundedJson(trigger) as RecordLike;
  });
}

function validateRoutineOutputs(value: unknown): RecordLike[] {
  if (!Array.isArray(value) || value.length > 32) return invalidRequest();
  return value.map((raw) => {
    const output = requireRecord(raw);
    if (
      typeof output.kind !== "string" ||
      ![
        "task_only",
        "channel_message",
        "webhook_response",
        "email",
        "github_comment",
        "issue_or_pr",
      ].includes(output.kind)
    )
      return invalidRequest();
    boundedJson(output);
    return output;
  });
}

function validateRoutineApprovalPolicy(value: unknown): RecordLike {
  const input = requireRecord(value, ["mode"]);
  if (!["inherit", "auto_safe", "confirm_external", "strict_confirm"].includes(String(input.mode)))
    return invalidRequest();
  return input;
}

function validateRoutineConnectorPolicy(value: unknown): RecordLike {
  const input = requireRecord(value, ["mode", "connectorIds"]);
  if (input.mode !== undefined && input.mode !== "prefer" && input.mode !== "allowlist")
    return invalidRequest();
  if (input.connectorIds !== undefined) stringArray(input.connectorIds);
  return input;
}

function validateWorkflowShape(value: unknown): RoutineWorkflowDefinition {
  const workflow = requireRecord(value, [
    "version",
    "starterNodeId",
    "nodes",
    "edges",
    "accountBindings",
    "settings",
    "generatedFromPrompt",
    "createdAt",
    "updatedAt",
  ]);
  if (workflow.version !== 1) return invalidRequest();
  stringArg(workflow.starterNodeId);
  if (
    !Array.isArray(workflow.nodes) ||
    workflow.nodes.length > 500 ||
    !Array.isArray(workflow.edges) ||
    workflow.edges.length > 2_000
  )
    return invalidRequest();
  if (workflow.accountBindings !== undefined) boundedJson(requireRecord(workflow.accountBindings));
  if (workflow.settings !== undefined)
    boundedJson(
      requireRecord(workflow.settings, [
        "maxRunDurationMs",
        "maxStepCount",
        "maxForEachItems",
        "maxParallelSteps",
        "retainStepDataDays",
      ]),
    );
  if (workflow.generatedFromPrompt !== undefined)
    textArg(workflow.generatedFromPrompt, 20_000, true);
  if (workflow.createdAt !== undefined) integerArg(workflow.createdAt, 0, Number.MAX_SAFE_INTEGER);
  if (workflow.updatedAt !== undefined) integerArg(workflow.updatedAt, 0, Number.MAX_SAFE_INTEGER);
  for (const raw of workflow.nodes) {
    const node = requireRecord(raw, [
      "id",
      "kind",
      "operation",
      "name",
      "description",
      "config",
      "position",
      "timeoutMs",
      "retry",
      "onError",
      "approvalMode",
      "children",
      "metadata",
    ]);
    stringArg(node.id);
    textArg(node.operation, 200);
    textArg(node.name, 300);
    if (!Array.isArray(node.children) && node.children !== undefined) return invalidRequest();
    boundedJson(requireRecord(node.config));
  }
  for (const raw of workflow.edges) {
    const edge = requireRecord(raw, [
      "id",
      "sourceNodeId",
      "targetNodeId",
      "sourcePort",
      "targetPort",
    ]);
    stringArg(edge.id);
    stringArg(edge.sourceNodeId);
    stringArg(edge.targetNodeId);
    if (edge.sourcePort !== undefined) textArg(edge.sourcePort, 100);
    if (edge.targetPort !== undefined) textArg(edge.targetPort, 100);
  }
  return boundedJson(workflow) as unknown as RoutineWorkflowDefinition;
}

function validateRoutineWorkflowTest(value: unknown): RoutineWorkflowTestRequest {
  const input = requireRecord(value, ["routineId", "workflow", "sampleEvent", "nodeId", "dryRun"]);
  if (input.routineId !== undefined) stringArg(input.routineId);
  if (input.workflow !== undefined) validateWorkflowShape(input.workflow);
  if (input.sampleEvent !== undefined) boundedJson(requireRecord(input.sampleEvent));
  if (input.nodeId !== undefined) stringArg(input.nodeId);
  optionalBoolean(input.dryRun);
  if (input.dryRun === false && input.routineId === undefined) {
    throw new WebApplicationError(
      "FORBIDDEN",
      "A live workflow test requires a saved routine in a writable workspace.",
      403,
    );
  }
  return boundedJson(input) as RoutineWorkflowTestRequest;
}

function managedRoutinePayload(
  input: Awaited<ReturnType<ManagedSessionService["buildManagedAgentRoutineDefinition"]>>,
  agentId: string,
): RoutineCreate {
  const triggerId = input.trigger.id || `managed:${input.trigger.type}:${Date.now()}`;
  let trigger: RoutineCreate["triggers"] extends Array<infer T> | undefined ? T : never;
  switch (input.trigger.type) {
    case "schedule":
      trigger = {
        id: triggerId,
        type: "schedule",
        enabled: input.trigger.enabled !== false,
        schedule: {
          kind: "every",
          everyMs: Math.max(15, input.trigger.cadenceMinutes || 60) * 60_000,
        },
      } as NonNullable<RoutineCreate["triggers"]>[number];
      break;
    case "api":
      trigger = {
        id: triggerId,
        type: "api",
        enabled: input.trigger.enabled !== false,
        path: input.trigger.path || `/agents/${agentId}`,
      };
      break;
    case "channel_event":
      trigger = {
        id: triggerId,
        type: "channel_event",
        enabled: input.trigger.enabled !== false,
        channelType: input.trigger.channelType,
        chatId: input.trigger.chatId,
        textContains: input.trigger.textContains,
        senderContains: input.trigger.senderContains,
      };
      break;
    case "mailbox_event":
      trigger = {
        id: triggerId,
        type: "mailbox_event",
        enabled: input.trigger.enabled !== false,
        eventType: input.trigger.eventType,
        subjectContains: input.trigger.subjectContains,
        provider: input.trigger.provider,
        labelContains: input.trigger.labelContains,
      };
      break;
    case "github_event":
      trigger = {
        id: triggerId,
        type: "github_event",
        enabled: input.trigger.enabled !== false,
        eventName: input.trigger.eventName,
        repository: input.trigger.repository,
        action: input.trigger.action,
        ref: input.trigger.ref,
      };
      break;
    case "connector_event":
      trigger = {
        id: triggerId,
        type: "connector_event",
        enabled: input.trigger.enabled !== false,
        connectorId: input.trigger.connectorId || "connector",
        changeType: input.trigger.changeType,
        resourceUriContains: input.trigger.resourceUriContains,
      };
      break;
    default:
      trigger = { id: triggerId, type: "manual", enabled: input.trigger.enabled !== false };
  }
  return {
    name: input.name || "Managed agent routine",
    description: input.description,
    enabled: input.enabled ?? true,
    workspaceId: input.workspaceId,
    instructions: input.instructions,
    executionTarget: { kind: "managed_environment", managedEnvironmentId: input.environmentId },
    contextBindings: { metadata: { managedAgentId: agentId } },
    triggers: [trigger],
    outputs: [{ kind: "task_only" }],
    approvalPolicy: { mode: "inherit" },
    connectorPolicy: { mode: "prefer", connectorIds: [] },
  };
}

function safeProfileSettings() {
  const settings = PermissionSettingsManager.loadSettings();
  return {
    defaultAccessProfileId: settings.defaultAccessProfileId,
    accessProfiles: (settings.accessProfiles || []).map((profile) => ({
      id: profile.id,
      label: profile.label,
      description: profile.description,
      extends: profile.extends,
    })),
  };
}

function safeMcpSettings() {
  const settings = MCPSettingsManager.getSettingsForDisplay();
  return {
    toolNamePrefix: settings.toolNamePrefix,
    servers: Array.isArray(settings.servers)
      ? settings.servers.map((server) => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
        }))
      : Object.entries(settings.servers || {}).map(([id, server]) => ({
          id,
          name: (server as { name?: string } | undefined)?.name || id,
        })),
  };
}

export function createBrowserNavigationDefinitions(options: BrowserNavigationOptions): {
  definitions: BrowserDesktopDefinitions;
  dispose: () => void;
} {
  const { db, agentDaemon } = options;
  const workspaceRepository = new WorkspaceRepository(db);
  const taskRepository = new TaskRepository(db);
  const skillRepository = new SkillRepository(db);
  const agentRoleRepository = new AgentRoleRepository(db);
  const agentTeamRepository = new AgentTeamRepository(db);
  const automationProfileRepository = new AutomationProfileRepository(db);
  const botNotificationPreferenceRepository = new BotNotificationPreferenceRepository(db);
  const managed =
    options.managedSessionService ||
    new ManagedSessionService(db, agentDaemon, {
      getRoutineService: () => currentRoutineService(),
      workContextService: new WorkContextService(db),
    });
  const everyday = options.everydayAgentService || new EverydayAgentService(db);
  const templates = new AgentTemplateService();
  const agentBuilder = options.agentBuilderService || new AgentBuilderService();
  const imageProfiles = options.imageGenProfileService || new ImageGenProfileService();
  const taskStore = new TaskStore(db);
  const definitions: BrowserDesktopDefinitions = {};
  definitions.forkTaskSession = {
    capability: "tasks.create",
    mutation: true,
    minArgs: 1,
    maxArgs: 1,
    validate: ([request]) => [parseForkTaskSessionRequest(request)],
    handler: async ([rawRequest]) => {
      const request = rawRequest as BrowserForkTaskSessionRequest;
      const sourceTask = await taskRepository.findById(request.taskId);
      if (!sourceTask) {
        throw new WebApplicationError("FORBIDDEN", "Task access is unavailable.", 403);
      }
      const workspace = options.resolveWorkspace
        ? await options.resolveWorkspace(sourceTask.workspaceId)
        : await workspaceRepository.findById(sourceTask.workspaceId);
      if (
        !workspace?.permissions.read ||
        !workspace.permissions.write ||
        workspace.isTemp ||
        isTempWorkspaceId(workspace.id)
      ) {
        throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
      }

      const forkedTask = await agentDaemon.forkTaskSession(request);
      try {
        new WorkContextService(db).attachForkedTask(forkedTask, sourceTask.id);
      } catch (error) {
        console.warn("Failed to register browser-forked task WorkContext:", error);
      }
      return publicForkTask(forkedTask);
    },
  };
  const packToggleService =
    options.pluginPackToggleService || getPluginPackToggleService(PluginRegistry.getInstance());
  const discoverySources: BrowserDiscoverySources = {
    listPluginPacks:
      options.discovery?.listPluginPacks ||
      (async () => {
        const registry = PluginRegistry.getInstance();
        await registry.initialize();
        return registry.getPluginsByType("pack").map((plugin) => ({
          manifest: plugin.manifest,
          state: plugin.state,
          securityReport: plugin.securityReport,
        }));
      }),
    getSkillStatus:
      options.discovery?.getSkillStatus ||
      (async () => {
        const loader = getCustomSkillLoader();
        await loader.initialize();
        return loader.getSkillStatus();
      }),
    listQuarantinedImports:
      options.discovery?.listQuarantinedImports ||
      (() => getSkillRegistry().listQuarantinedImports()),
    searchSkillRegistry:
      options.discovery?.searchSkillRegistry ||
      ((query, searchOptions) => getSkillRegistry().search(query, searchOptions)),
    searchClawHubSkills:
      options.discovery?.searchClawHubSkills ||
      ((query, searchOptions) => getSkillRegistry().searchClawHub(query, searchOptions)),
    searchPackRegistry:
      options.discovery?.searchPackRegistry ||
      ((query, searchOptions) => getPackRegistry().search(query, searchOptions)),
    getMCPStatus:
      options.discovery?.getMCPStatus || (() => MCPClientManager.getInstance().getStatus()),
    fetchMCPRegistry:
      options.discovery?.fetchMCPRegistry || (() => MCPRegistryManager.fetchRegistry()),
    searchMCPRegistry:
      options.discovery?.searchMCPRegistry ||
      ((query, tags) => MCPRegistryManager.searchServers({ query, tags, limit: 50, offset: 0 })),
  };
  let ownedRoutineService: RoutineService | null = null;
  let workflowRuntimeStarted = false;

  function eventTriggerService(): EventTriggerSource | null {
    return options.getEventTriggerService?.() || null;
  }

  function cronService(): CronService | null {
    return options.getCronService?.() ?? getCronService();
  }

  function currentRoutineService(): RoutineService | null {
    const existing = options.getRoutineService?.();
    if (existing) return existing;
    if (ownedRoutineService) return ownedRoutineService;
    ownedRoutineService = new RoutineService({
      db,
      getCronService: cronService,
      getEventTriggerService: eventTriggerService,
      loadHooksSettings: () => HooksSettingsManager.loadSettings(),
      saveHooksSettings: (settings) => HooksSettingsManager.saveSettings(settings),
      createTask: async (params) => {
        const task = await agentDaemon.createTask({
          title: params.title,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
          ...(params.assignedAgentRoleId
            ? { taskOverrides: { assignedAgentRoleId: params.assignedAgentRoleId } }
            : {}),
          agentConfig: params.agentConfig,
          source: params.source,
        });
        return { id: task.id };
      },
      sendTaskMessage: async (params) => {
        if (!taskStore.findById(params.taskId))
          throw new Error(`Target task not found: ${params.taskId}`);
        return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
          agentConfigOverride: params.agentConfig,
        });
      },
      getTaskSnapshot: (taskId) => {
        const task = taskStore.findById(taskId);
        return task
          ? {
              status: task.status,
              error: task.error || undefined,
              resultSummary: task.resultSummary || undefined,
              terminalStatus: task.terminalStatus || undefined,
              completedAt: task.completedAt || undefined,
            }
          : null;
      },
      createManagedSession: async (params) => {
        const agent = params.agentId
          ? (await managed.getAgent(params.agentId))?.agent
          : (await managed.listAgents({ limit: 1 }))[0];
        if (!agent) throw new Error("No managed agents are available for routine execution");
        const session = await managed.createSession({
          agentId: agent.id,
          environmentId: params.environmentId,
          title: params.title,
          initialEvent: { type: "user.message", content: [{ type: "text", text: params.prompt }] },
        });
        return {
          id: session.id,
          backingTaskId: session.backingTaskId,
          workspaceId: session.workspaceId,
        };
      },
      getManagedSessionSnapshot: async (sessionId) => {
        const session = await managed.getSession(sessionId);
        return session
          ? {
              status: session.status,
              latestSummary: session.latestSummary || undefined,
              completedAt: session.completedAt || undefined,
              backingTaskId: session.backingTaskId || undefined,
            }
          : null;
      },
      executeWorkflowAction: options.executeWorkflowAction,
    });
    return ownedRoutineService;
  }

  async function startOwnedWorkflowRuntime(): Promise<void> {
    const service = currentRoutineService();
    if (!service || service !== ownedRoutineService || workflowRuntimeStarted) return;
    await service.startWorkflowRuntime();
    workflowRuntimeStarted = true;
  }

  async function permission(workspaceId: string, key: ManagedPermission): Promise<void> {
    const workspace = options.resolveWorkspace
      ? await options.resolveWorkspace(workspaceId)
      : await workspaceRepository.findById(workspaceId);
    if (!workspace)
      throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
    const scoped = safeWorkspace(workspace);
    if (workspace.isTemp || !scoped.permissions.read) {
      throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
    }
    const snapshot = await managed.getMyWorkspacePermissions(workspaceId);
    if (!snapshot[key])
      throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
  }

  function ensureManagedRoutineTriggerSupported(trigger: ManagedAgentRoutineTriggerConfig): void {
    if (trigger.type === "schedule" && !cronService()) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Scheduled agent routines are unavailable on this host.",
        501,
      );
    }
    if (
      ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
        trigger.type,
      ) &&
      !eventTriggerService()
    ) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Event agent routines are unavailable on this host.",
        501,
      );
    }
  }

  async function readableWorkspace(workspaceId: string): Promise<Workspace | null> {
    const workspace = options.resolveWorkspace
      ? await options.resolveWorkspace(workspaceId)
      : await workspaceRepository.findById(workspaceId);
    if (!workspace || workspace.isTemp) return null;
    const scoped = safeWorkspace(workspace);
    return scoped.permissions.read ? scoped : null;
  }

  async function listReadableWorkspaces(): Promise<Workspace[]> {
    const rows = await workspaceRepository.findAll();
    const visible: Workspace[] = [];
    for (const workspace of rows) {
      const scoped = await readableWorkspace(workspace.id);
      if (scoped) visible.push(scoped);
    }
    return visible;
  }

  async function workspaceForAgent(agentId: string): Promise<string | null> {
    const detail = await managed.getAgent(agentId);
    const metadata = detail?.currentVersion?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const studio = (metadata as RecordLike).studio;
    if (!studio || typeof studio !== "object" || Array.isArray(studio)) return null;
    const environmentId = (studio as RecordLike).defaultEnvironmentId;
    if (typeof environmentId !== "string") return null;
    const environment = await managed.getEnvironment(environmentId);
    return environment?.config.workspaceId || null;
  }

  async function visibleAgent(agent: ManagedAgent): Promise<boolean> {
    const workspaceId = await workspaceForAgent(agent.id);
    if (!workspaceId) return false;
    const snapshot = await managed.getMyWorkspacePermissions(workspaceId);
    return snapshot.canViewAgents;
  }

  async function visibleSession(
    session: ManagedSession,
    key: ManagedPermission = "canViewAgents",
  ): Promise<void> {
    await permission(session.workspaceId, key);
  }

  async function visibleRoutine(
    routine: Routine,
    key: ManagedPermission = "canManageRoutines",
  ): Promise<void> {
    await permission(routine.workspaceId, key);
  }

  async function filterRoutines(routines: Routine[]): Promise<Routine[]> {
    const visible: Routine[] = [];
    for (const routine of routines) {
      try {
        await visibleRoutine(routine, "canViewAgents");
        visible.push(routineWithoutSecrets(routine));
      } catch {
        // A routine from another managed workspace is not visible to this browser client.
      }
    }
    return visible;
  }

  const agents = "agents.manage" as const;
  const automation = "automation.manage" as const;
  const memory = "memory.manage" as const;

  definitions.listManagedAgents = definition(
    agents,
    async (args) => {
      const params = parseAgentListParams(args[0]) as Parameters<
        ManagedSessionService["listAgents"]
      >[0];
      const rows = await managed.listAgents(params);
      const visible: ManagedAgent[] = [];
      for (const agent of rows) if (await visibleAgent(agent)) visible.push(agent);
      return visible;
    },
    { maxArgs: 1, validate: (args) => [parseAgentListParams(args[0])] },
  );

  definitions.getManagedAgent = definition(
    agents,
    async ([agentId]) => {
      const detail = await managed.getAgent(String(agentId));
      if (!detail || !(await visibleAgent(detail.agent))) return null;
      return detail;
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.getManagedAgentRuntimeToolCatalog = definition(
    agents,
    async ([agentId]) => {
      const workspaceId = await workspaceForAgent(String(agentId));
      if (!workspaceId) throw new Error("Managed agent workspace is unavailable.");
      await permission(workspaceId, "canViewAgents");
      return managed.getRuntimeToolCatalog(String(agentId));
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.createManagedAgent = definition(
    agents,
    async ([request]) => {
      const input = validateAgentCreate(request) as Parameters<
        ManagedSessionService["createAgent"]
      >[0];
      const studio = (input.metadata as RecordLike | undefined)?.studio;
      const environmentId =
        studio && typeof studio === "object" && !Array.isArray(studio)
          ? (studio as RecordLike).defaultEnvironmentId
          : undefined;
      if (typeof environmentId !== "string")
        throw new Error("A managed agent environment is required.");
      const environment = await managed.getEnvironment(environmentId);
      if (!environment) throw new Error("Managed environment not found.");
      await permission(environment.config.workspaceId, "canEditDrafts");
      return managed.createAgent(input);
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: (args) => [validateAgentCreate(args[0])] },
  );

  definitions.updateManagedAgent = definition(
    agents,
    async ([request]) => {
      const input = validateAgentUpdate(request);
      const detail = await managed.getAgent(String(input.agentId));
      if (!detail) return null;
      const workspaceId = await workspaceForAgent(String(input.agentId));
      if (!workspaceId) throw new Error("Managed agent workspace is unavailable.");
      await permission(workspaceId, "canEditDrafts");
      const { agentId, ...patch } = input;
      const updatedMetadata = patch.metadata as RecordLike | undefined;
      const studio = updatedMetadata?.studio;
      if (studio && typeof studio === "object" && !Array.isArray(studio)) {
        const environmentId = (studio as RecordLike).defaultEnvironmentId;
        if (environmentId !== undefined) {
          const environment = await managed.getEnvironment(stringArg(environmentId));
          if (!environment)
            throw new WebApplicationError("INVALID_REQUEST", "Managed environment not found.", 404);
          await permission(environment.config.workspaceId, "canEditDrafts");
        }
      }
      return managed.updateAgent(
        String(agentId),
        patch as Parameters<ManagedSessionService["updateAgent"]>[1],
      );
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: (args) => [validateAgentUpdate(args[0])] },
  );

  for (const [name, handler] of [
    ["archiveManagedAgent", (id: string) => managed.archiveAgent(id)],
    ["publishManagedAgent", (id: string) => managed.publishAgent(id)],
    ["suspendManagedAgent", (id: string) => managed.suspendAgent(id)],
  ] as const) {
    definitions[name] = definition(
      agents,
      async ([id]) => {
        const agentId = String(id);
        const workspaceId = await workspaceForAgent(agentId);
        if (!workspaceId)
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "Managed agent workspace not found.",
            404,
          );
        const permissionKey = name === "publishManagedAgent" ? "canPublishAgents" : "canEditDrafts";
        await permission(workspaceId, permissionKey);
        return handler(agentId);
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: simpleIdValidator,
      },
    );
  }

  definitions.listManagedAgentRoutines = definition(
    agents,
    async ([agentId]) => {
      const detail = await managed.getAgent(String(agentId));
      if (!detail || !(await visibleAgent(detail.agent))) return [];
      return managed.listManagedAgentRoutines(String(agentId));
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.createManagedAgentRoutine = definition(
    agents,
    async ([request]) => {
      const routineRequest = validateManagedAgentRoutineCreate(request);
      const agentId = routineRequest.agentId;
      const workspaceId = await workspaceForAgent(agentId);
      if (!workspaceId)
        throw new WebApplicationError("INVALID_REQUEST", "Managed agent workspace not found.", 404);
      await permission(workspaceId, "canManageRoutines");
      ensureManagedRoutineTriggerSupported(routineRequest.trigger);
      if (
        routineRequest.trigger.type === "schedule" ||
        routineRequest.trigger.type.endsWith("_event")
      ) {
        await startOwnedWorkflowRuntime();
      }
      const prepared = await managed.buildManagedAgentRoutineDefinition(routineRequest);
      const routine = await currentRoutineService()!.create(
        managedRoutinePayload(prepared, agentId),
      );
      await managed.syncManagedAgentRoutineRefs(agentId);
      return (
        (await managed.listManagedAgentRoutines(agentId)).find((row) => row.id === routine.id) ||
        null
      );
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = validateManagedAgentRoutineCreate(args[0]);
        ensureManagedRoutineTriggerSupported(input.trigger);
        return [input];
      },
    },
  );

  definitions.updateManagedAgentRoutine = definition(
    agents,
    async ([request]) => {
      const input = validateManagedAgentRoutineUpdate(request);
      const agentId = input.agentId;
      const routineId = input.routineId;
      const workspaceId = await workspaceForAgent(agentId);
      if (!workspaceId)
        throw new WebApplicationError("INVALID_REQUEST", "Managed agent workspace not found.", 404);
      await permission(workspaceId, "canManageRoutines");
      const rows = await managed.listManagedAgentRoutines(agentId);
      const existing = rows.find((row) => row.id === routineId);
      if (!existing) throw new Error("Managed agent routine not found.");
      const nextTrigger =
        input.trigger === undefined
          ? existing.trigger
          : validateRoutineTriggerConfig(input.trigger);
      ensureManagedRoutineTriggerSupported(nextTrigger);
      if (nextTrigger.type === "schedule" || nextTrigger.type.endsWith("_event")) {
        await startOwnedWorkflowRuntime();
      }
      const prepared = await managed.buildManagedAgentRoutineDefinition({
        ...input,
        agentId,
        routineId,
        trigger: nextTrigger,
      } as Parameters<ManagedSessionService["buildManagedAgentRoutineDefinition"]>[0]);
      await currentRoutineService()!.update(routineId, managedRoutinePayload(prepared, agentId));
      await managed.syncManagedAgentRoutineRefs(agentId);
      return (
        (await managed.listManagedAgentRoutines(agentId)).find((row) => row.id === routineId) ||
        null
      );
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = validateManagedAgentRoutineUpdate(args[0]);
        if (input.trigger)
          ensureManagedRoutineTriggerSupported(input.trigger as ManagedAgentRoutineTriggerConfig);
        return [input];
      },
    },
  );

  definitions.deleteManagedAgentRoutine = definition(
    agents,
    async ([agentId, routineId]) => {
      const id = String(agentId);
      const target = String(routineId);
      const workspaceId = await workspaceForAgent(id);
      if (!workspaceId)
        throw new WebApplicationError("INVALID_REQUEST", "Managed agent workspace not found.", 404);
      await permission(workspaceId, "canManageRoutines");
      if (!(await managed.listManagedAgentRoutines(id)).some((row) => row.id === target))
        return false;
      const removed = await currentRoutineService()!.remove(target);
      await managed.syncManagedAgentRoutineRefs(id);
      return removed;
    },
    {
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => [stringArg(args[0]), stringArg(args[1])],
    },
  );

  definitions.getManagedAgentInsights = definition(
    agents,
    async ([agentId]) => {
      const workspaceId = await workspaceForAgent(String(agentId));
      if (!workspaceId) throw new Error("Managed agent workspace is unavailable.");
      await permission(workspaceId, "canViewAgents");
      return managed.getAgentInsights(String(agentId));
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.listManagedAgentAuditEntries = definition(
    agents,
    async ([agentId, limit]) => {
      const workspaceId = await workspaceForAgent(String(agentId));
      if (!workspaceId) throw new Error("Managed agent workspace is unavailable.");
      await permission(workspaceId, "canAuditAgents");
      return managed.listAuditEntries(
        String(agentId),
        limit === undefined ? undefined : Number(limit),
      );
    },
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => [stringArg(args[0]), optionalInteger(args[1], 1, 500)],
    },
  );

  definitions.listManagedEnvironments = definition(
    agents,
    async ([params]) => {
      const input =
        params === undefined ? undefined : requireRecord(params, ["limit", "offset", "status"]);
      const rows = await managed.listEnvironments(
        input as Parameters<ManagedSessionService["listEnvironments"]>[0],
      );
      const visible: ManagedEnvironment[] = [];
      for (const environment of rows) {
        try {
          await permission(environment.config.workspaceId, "canViewAgents");
          visible.push(sanitizeEnvironment(environment));
        } catch {
          // Environments outside the browser principal's managed scope are not exposed.
        }
      }
      return visible;
    },
    { maxArgs: 1, validate: (args) => [parseEnvironmentListParams(args[0])] },
  );

  definitions.getManagedEnvironment = definition(
    agents,
    async ([id]) => {
      const environment = await managed.getEnvironment(String(id));
      if (!environment) return null;
      await permission(environment.config.workspaceId, "canViewAgents");
      return sanitizeEnvironment(environment);
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.createManagedEnvironment = definition(
    agents,
    async ([value]) => {
      const input = validateEnvironmentInput(value, false);
      await permission(String((input.config as RecordLike).workspaceId), "canManageEnvironments");
      return sanitizeEnvironment(
        await managed.createEnvironment(
          input as Parameters<ManagedSessionService["createEnvironment"]>[0],
        ),
      );
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEnvironmentInput(args[0], false)],
    },
  );

  definitions.updateManagedEnvironment = definition(
    agents,
    async ([value]) => {
      const input = validateEnvironmentInput(value, true);
      const environment = await managed.getEnvironment(String(input.environmentId));
      if (!environment) return null;
      await permission(environment.config.workspaceId, "canManageEnvironments");
      const config = input.config as RecordLike | undefined;
      if (typeof config?.workspaceId === "string")
        await permission(config.workspaceId, "canManageEnvironments");
      const { environmentId, ...patch } = input;
      const updated = await managed.updateEnvironment(
        String(environmentId),
        patch as Parameters<ManagedSessionService["updateEnvironment"]>[1],
      );
      return updated ? sanitizeEnvironment(updated) : null;
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEnvironmentInput(args[0], true)],
    },
  );

  definitions.archiveManagedEnvironment = definition(
    agents,
    async ([id]) => {
      const environment = await managed.getEnvironment(String(id));
      if (!environment) return null;
      await permission(environment.config.workspaceId, "canManageEnvironments");
      const archived = await managed.archiveEnvironment(String(id));
      return archived ? sanitizeEnvironment(archived) : null;
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.listManagedSessions = definition(
    agents,
    async ([params]) => {
      const rows = await managed.listSessions(
        parseSessionListParams(params) as Parameters<ManagedSessionService["listSessions"]>[0],
      );
      const visible: ManagedSession[] = [];
      for (const session of rows) {
        try {
          await visibleSession(session);
          visible.push(session);
        } catch {
          // Keep sessions in other workspaces private to their members.
        }
      }
      return visible;
    },
    { maxArgs: 1, validate: (args) => [parseSessionListParams(args[0])] },
  );

  definitions.getManagedSession = definition(
    agents,
    async ([id]) => {
      const session = await managed.getSession(String(id));
      if (!session) return null;
      await visibleSession(session);
      return session;
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.createManagedSession = definition(
    agents,
    async ([value]) => {
      const sessionInput = validateSessionCreate(value);
      const agentId = sessionInput.agentId;
      const environmentId = sessionInput.environmentId;
      const environment = await managed.getEnvironment(environmentId);
      if (!environment) throw new Error("Managed environment not found.");
      await permission(environment.config.workspaceId, "canRunAgents");
      return managed.createSession(sessionInput);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateSessionCreate(args[0])],
    },
  );

  definitions.sendManagedSessionUserMessage = definition(
    agents,
    async ([request]) => {
      const payload = validateSessionUserMessage(request);
      const sessionId = payload.sessionId;
      const session = await managed.getSession(sessionId);
      if (!session) return undefined;
      await visibleSession(session, "canRunAgents");
      return managed.sendUserMessage(payload.sessionId, payload.content, payload.expectedTurnId);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateSessionUserMessage(args[0])],
    },
  );

  definitions.resumeManagedSession = definition(
    agents,
    async ([id]) => {
      const session = await managed.getSession(String(id));
      if (!session) return { resumed: false };
      await visibleSession(session, "canResumeSessions");
      return managed.resumeSession(String(id));
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.cancelManagedSession = definition(
    agents,
    async ([id]) => {
      const session = await managed.getSession(String(id));
      if (!session) return undefined;
      await visibleSession(session, "canRunAgents");
      return managed.cancelSession(String(id));
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.listManagedSessionEvents = definition(
    agents,
    async ([request]) => {
      const input = requireRecord(request, ["sessionId", "limit"]);
      const session = await managed.getSession(stringArg(input.sessionId));
      if (!session) return [];
      await visibleSession(session);
      const events = await managed.listSessionEvents(
        session.id,
        input.limit === undefined ? 500 : integerArg(input.limit, 1, 500),
      );
      return events;
    },
    {
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = requireRecord(args[0], ["sessionId", "limit"]);
        return [
          {
            sessionId: stringArg(input.sessionId),
            ...(input.limit === undefined ? {} : { limit: integerArg(input.limit, 1, 500) }),
          },
        ];
      },
    },
  );

  definitions.getManagedSessionWorkpaper = definition(
    agents,
    async ([id]) => {
      const session = await managed.getSession(String(id));
      if (!session) throw new Error("Managed session not found.");
      await visibleSession(session);
      const workpaper = await managed.getSessionWorkpaper(String(id));
      return {
        ...workpaper,
        evidenceRefs: workpaper.evidenceRefs.map(
          ({ sourceUrlOrPath: _path, ...reference }) => reference,
        ),
      };
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.listAgentTemplates = definition(agents, () => templates.list());
  definitions.listWorkspaces = definition(agents, () => listReadableWorkspaces());

  async function buildAgentBuilderInventory(): Promise<AgentBuilderInventory> {
    const skillLoader = getCustomSkillLoader();
    await skillLoader.initialize();
    const registry = PluginRegistry.getInstance();
    await registry.initialize();
    const gatewayChannels = options.channelGateway
      ? await options.channelGateway.getChannels()
      : [];
    return {
      templates: templates.list(),
      skills: skillLoader.listSkills(),
      pluginPacks: registry.getPluginsByType("pack"),
      mcpServers: MCPSettingsManager.getSettingsForDisplay().servers,
      channels: gatewayChannels.map((channel) => ({
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        status: channel.status,
      })),
      workspaces: await listReadableWorkspaces(),
      agentRoles: await agentRoleRepository.findAll(false),
      runtimeToolFamilies: [
        "communication",
        "search",
        "files",
        "documents",
        "memory",
        "browser",
        "shell",
        "images",
        "computer-use",
      ],
    };
  }

  definitions.generateManagedAgentPlan = definition(
    agents,
    async ([request]) => {
      const input = requireRecord(request, ["prompt", "workspaceId"]);
      const planRequest: AgentBuilderPlanRequest = {
        prompt: textArg(input.prompt, 20_000),
        ...(input.workspaceId === undefined ? {} : { workspaceId: stringArg(input.workspaceId) }),
      };
      if (planRequest.workspaceId && !(await readableWorkspace(planRequest.workspaceId))) {
        throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
      }
      return agentBuilder.generatePlan(planRequest, await buildAgentBuilderInventory());
    },
    {
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = requireRecord(args[0], ["prompt", "workspaceId"]);
        return [
          {
            prompt: textArg(input.prompt, 20_000),
            ...(input.workspaceId === undefined
              ? {}
              : { workspaceId: stringArg(input.workspaceId) }),
          },
        ];
      },
    },
  );

  definitions.createManagedAgentFromPlan = definition(
    agents,
    async ([request]) => {
      const input = validateAgentBuilderCreate(request);
      const workspaceId = input.workspaceId || (await listReadableWorkspaces())[0]?.id;
      if (!workspaceId)
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "No readable workspace is available.",
          404,
        );
      await permission(workspaceId, "canEditDrafts");
      for (const routine of input.plan.routines || []) {
        ensureManagedRoutineTriggerSupported(routine.trigger);
      }
      if (
        (input.plan.routines || []).some(
          (routine) =>
            routine.trigger.type === "schedule" || routine.trigger.type.endsWith("_event"),
        )
      ) {
        await startOwnedWorkflowRuntime();
      }
      const created = await managed.createAgentFromBuilderPlan({ ...input, workspaceId });
      return { ...created, environment: sanitizeEnvironment(created.environment) };
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = validateAgentBuilderCreate(args[0]);
        for (const routine of input.plan.routines || []) {
          ensureManagedRoutineTriggerSupported(routine.trigger);
        }
        return [input];
      },
    },
  );
  definitions.getPermissionSettings = definition(agents, () => safeProfileSettings());
  definitions.getMCPSettings = definition(agents, () => safeMcpSettings());
  definitions.getGatewayChannels = definition(agents, async () => {
    if (!options.channelGateway)
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Channel gateway is unavailable.",
        501,
      );
    return (await options.channelGateway.getChannels()).map((channel) => ({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      status: channel.status,
    }));
  });
  definitions.listIntegrationMentionOptions = definition(
    "tasks.read",
    async () => {
      const channels = options.channelGateway ? await options.channelGateway.getChannels() : [];
      return listIntegrationMentionOptions(
        channels.map(
          (channel) =>
            ({
              id: channel.id,
              type: channel.type,
              name: channel.name,
              enabled: channel.enabled,
              status: channel.status,
            }) as ChannelData,
        ),
      );
    },
    { maxArgs: 0 },
  );
  definitions.getGatewayChats = definition(
    automation,
    async ([rawChannelId]) => {
      const gateway = options.channelGateway;
      if (!gateway)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Channel chat lookup is unavailable on this browser host.",
          501,
        );
      const channelId = String(rawChannelId);
      const channel = await gateway.getChannel(channelId);
      if (!channel?.enabled) return [];
      const chats = await gateway.getDistinctChatIds(channelId, 200);
      return chats.slice(0, 200).map(({ chatId, lastTimestamp }) => ({
        chatId: textArg(chatId, 500),
        lastTimestamp:
          Number.isSafeInteger(lastTimestamp) && lastTimestamp >= 0 ? lastTimestamp : 0,
      }));
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.sendGatewayTestMessage = definition(
    automation,
    async ([rawRequest]) => {
      const gateway = options.channelGateway;
      if (!gateway)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Channel test messages are unavailable on this browser host.",
          501,
        );
      const input = requireRecord(rawRequest, ["channelType", "channelDbId", "chatId"]);
      const requestedType = input.channelType;
      if (
        typeof requestedType !== "string" ||
        !CHANNEL_TYPES.includes(requestedType as ChannelType)
      ) {
        return invalidRequest();
      }
      const chatId = textArg(input.chatId, 500);
      const channelDbId =
        input.channelDbId === undefined ? undefined : stringArg(input.channelDbId);
      let channelType = requestedType as ChannelType;
      if (channelDbId) {
        const channel = await gateway.getChannel(channelDbId);
        if (!channel?.enabled)
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "Choose an enabled channel before sending a test message.",
            400,
          );
        if (!CHANNEL_TYPES.includes(channel.type as ChannelType)) return invalidRequest();
        channelType = channel.type as ChannelType;
      }
      await gateway.sendMessage(channelType, chatId, "Test delivery from CoWork OS", {
        ...(channelDbId ? { channelDbId } : {}),
        parseMode: "text",
      });
      return { ok: true };
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = requireRecord(args[0], ["channelType", "channelDbId", "chatId"]);
        if (
          typeof input.channelType !== "string" ||
          !CHANNEL_TYPES.includes(input.channelType as ChannelType)
        ) {
          return invalidRequest();
        }
        return [
          boundedJson({
            channelType: input.channelType,
            ...(input.channelDbId === undefined
              ? {}
              : { channelDbId: stringArg(input.channelDbId) }),
            chatId: textArg(input.chatId, 500),
          }),
        ];
      },
    },
  );
  definitions.listImageGenProfiles = definition(agents, async () =>
    (await imageProfiles.list()).map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      isDefault: profile.isDefault,
      referencePhotos: profile.referencePhotos.map(({ id, name, mimeType, size }) => ({
        id,
        name,
        mimeType,
        size,
      })),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    })),
  );
  definitions.listSkills = definition(agents, async () =>
    (await skillRepository.findAll()).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    })),
  );
  definitions.listPluginPacks = definition(agents, async () =>
    safePluginPackList(await discoverySources.listPluginPacks()),
  );
  definitions.togglePluginPack = definition(
    agents,
    async ([name, enabled]) =>
      safePackToggleResult(
        await packToggleService.setPackEnabled(name as string, enabled as boolean),
        name as string,
        enabled as boolean,
      ),
    {
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => [pluginPackToggleIdArg(args[0]), booleanArg(args[1])],
    },
  );
  definitions.togglePluginPackSkill = definition(
    agents,
    async ([packName, skillId, enabled]) =>
      safePackSkillToggleResult(
        await packToggleService.setSkillEnabled(
          packName as string,
          skillId as string,
          enabled as boolean,
        ),
        packName as string,
        skillId as string,
        enabled as boolean,
      ),
    {
      mutation: true,
      minArgs: 3,
      maxArgs: 3,
      validate: (args) => [
        pluginPackToggleIdArg(args[0]),
        pluginPackToggleIdArg(args[1]),
        booleanArg(args[2]),
      ],
    },
  );
  definitions.getSkillStatus = definition(
    "tasks.read",
    async () => safeSkillStatusReport(await discoverySources.getSkillStatus()),
    { minArgs: 0, maxArgs: 0 },
  );
  definitions.listQuarantinedImports = definition(
    "tasks.read",
    async () => safeQuarantinedSkillImports(discoverySources.listQuarantinedImports()),
    { minArgs: 0, maxArgs: 0 },
  );
  definitions.searchSkillRegistry = definition(
    "tasks.read",
    async ([query, searchOptions]) =>
      safeSkillSearchResult(
        await discoverySources.searchSkillRegistry(
          query as string,
          searchOptions as { page?: number; pageSize?: number } | undefined,
        ),
        query as string,
        searchOptions as { page?: number; pageSize?: number } | undefined,
      ),
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => [discoveryQueryArg(args[0]), parseDiscoveryPageOptions(args[1])],
    },
  );
  definitions.searchClawHubSkills = definition(
    "tasks.read",
    async ([query, searchOptions]) =>
      safeSkillSearchResult(
        await discoverySources.searchClawHubSkills(
          query as string,
          searchOptions as { page?: number; pageSize?: number } | undefined,
        ),
        query as string,
        searchOptions as { page?: number; pageSize?: number } | undefined,
      ),
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => [discoveryQueryArg(args[0]), parseDiscoveryPageOptions(args[1])],
    },
  );
  definitions.searchPackRegistry = definition(
    "tasks.read",
    async ([query, searchOptions]) =>
      safePackSearchResult(
        await discoverySources.searchPackRegistry(
          query as string,
          searchOptions as { page?: number; pageSize?: number; category?: string } | undefined,
        ),
        query as string,
        searchOptions as { page?: number; pageSize?: number } | undefined,
      ),
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => [discoveryQueryArg(args[0]), parseDiscoveryPageOptions(args[1], true)],
    },
  );
  definitions.getMCPStatus = definition(
    "tasks.read",
    async () => safeMCPStatuses(discoverySources.getMCPStatus()),
    { minArgs: 0, maxArgs: 0 },
  );
  definitions.fetchMCPRegistry = definition(
    "tasks.read",
    async () => safeMCPRegistry(await discoverySources.fetchMCPRegistry()),
    { minArgs: 0, maxArgs: 0 },
  );
  definitions.searchMCPRegistry = definition(
    "tasks.read",
    async ([query, tags]) => {
      const results = await discoverySources.searchMCPRegistry(
        query as string,
        tags as string[] | undefined,
      );
      return boundedJsonArray(
        Array.isArray(results)
          ? results.slice(0, 50).flatMap((entry) => {
              const safeEntry = safeMCPRegistryEntry(entry);
              return safeEntry ? [safeEntry] : [];
            })
          : [],
      );
    },
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => {
        const query = discoveryQueryArg(args[0]);
        if (args[1] === undefined) return [query, undefined];
        if (!Array.isArray(args[1]) || args[1].length > 20) return invalidRequest();
        const tags = args[1].map((tag) => {
          if (typeof tag !== "string" || tag.length > 100 || !tag.trim()) return invalidRequest();
          const normalized = tag.trim();
          if (/[\u0000-\u001f\u007f]/.test(normalized)) return invalidRequest();
          return normalized;
        });
        return [query, tags];
      },
    },
  );
  definitions.getAgentRoles = definition(
    agents,
    async ([includeInactive]) => {
      if (includeInactive !== undefined && typeof includeInactive !== "boolean")
        return invalidRequest();
      return (await agentRoleRepository.findAll(includeInactive === true)).map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        icon: role.icon,
        color: role.color,
        isActive: role.isActive,
        soul: role.soul,
        heartbeatEnabled: role.heartbeatEnabled,
        heartbeatPolicy: role.heartbeatPolicy,
        pulseEveryMinutes: role.pulseEveryMinutes,
      }));
    },
    {
      maxArgs: 1,
      validate: (args) => {
        if (args[0] !== undefined && typeof args[0] !== "boolean") return invalidRequest();
        return args;
      },
    },
  );
  definitions.getAgentRole = definition(
    agents,
    async ([roleId]) => (await agentRoleRepository.findById(String(roleId))) ?? undefined,
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.getBotNotificationPolicy = definition(
    agents,
    async ([rawRoleId]) => {
      const roleId = String(rawRoleId);
      if (!(await agentRoleRepository.findById(roleId))) {
        throw new WebApplicationError("FORBIDDEN", "Agent role is unavailable.", 403);
      }
      return botNotificationPreferenceRepository.findByAgentRoleId(roleId);
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.updateBotNotificationPolicy = definition(
    agents,
    async ([request]) => {
      const update = request as {
        agentRoleId: string;
        onFinish?: boolean;
        onInputRequired?: boolean;
      };
      if (!(await agentRoleRepository.findById(update.agentRoleId))) {
        throw new WebApplicationError("FORBIDDEN", "Agent role is unavailable.", 403);
      }
      return botNotificationPreferenceRepository.upsert(update.agentRoleId, {
        ...(update.onFinish === undefined ? {} : { onFinish: update.onFinish }),
        ...(update.onInputRequired === undefined
          ? {}
          : { onInputRequired: update.onInputRequired }),
      });
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: ([request]) => [parseBotNotificationPolicyUpdate(request)],
    },
  );
  definitions.listTeams = definition(
    agents,
    async ([rawWorkspaceId, includeInactive]) => {
      const workspace = await readableWorkspace(String(rawWorkspaceId));
      if (!workspace) {
        throw new WebApplicationError("FORBIDDEN", "Workspace is unavailable.", 403);
      }
      const teams = await agentTeamRepository.listByWorkspace(
        workspace.id,
        includeInactive === true,
      );
      return teams.map((team) => ({
        ...team,
        ...(team.defaultWorkspaceId && team.defaultWorkspaceId !== workspace.id
          ? { defaultWorkspaceId: undefined }
          : {}),
      }));
    },
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => {
        if (args.length < 1 || args.length > 2) return invalidRequest();
        if (args[1] !== undefined && typeof args[1] !== "boolean") return invalidRequest();
        return [stringArg(args[0]), args[1] ?? false];
      },
    },
  );
  if (agentDaemon.reopenBotConversation) {
    definitions.reopenBotConversation = definition(
      "tasks.create",
      async ([request]) => {
        const reopenRequest = request as BotConversationReopenRequest;
        const workspace = options.resolveWorkspace
          ? await options.resolveWorkspace(reopenRequest.workspaceId)
          : await workspaceRepository.findById(reopenRequest.workspaceId);
        const scopedWorkspace = workspace ? safeWorkspace(workspace) : null;
        if (
          !scopedWorkspace?.permissions.read ||
          !scopedWorkspace.permissions.write ||
          scopedWorkspace.isTemp ||
          isTempWorkspaceId(scopedWorkspace.id)
        ) {
          throw new WebApplicationError("FORBIDDEN", "Workspace access is unavailable.", 403);
        }
        if (reopenRequest.taskId) {
          const sourceTask = await taskRepository.findById(reopenRequest.taskId);
          if (!sourceTask || sourceTask.workspaceId !== scopedWorkspace.id) {
            throw new WebApplicationError("FORBIDDEN", "Bot conversation is unavailable.", 403);
          }
        }
        if (reopenRequest.repairMembership) {
          await permission(scopedWorkspace.id, "canManageMemberships");
        }
        const reopened = await agentDaemon.reopenBotConversation!(reopenRequest);
        return toBrowserTask(reopened);
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: ([request]) => [parseBotConversationReopenRequest(request)],
      },
    );
  }
  definitions.listAutomationProfiles = definition(agents, () =>
    automationProfileRepository.listAll(),
  );
  if (options.getHeartbeatService) {
    definitions.getAllHeartbeatStatus = definition(agents, async () => {
      const service = options.getHeartbeatService?.();
      if (!service)
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Heartbeat status is unavailable on this host.",
          501,
        );
      return service.getAllStatus();
    });
  }

  definitions.listRoutines = definition(automation, async () =>
    filterRoutines(await currentRoutineService()!.list()),
  );
  definitions.getRoutine = definition(
    automation,
    async ([id]) => {
      const routine = await currentRoutineService()!.get(String(id));
      if (!routine) return null;
      await visibleRoutine(routine, "canViewAgents");
      return routineWithoutSecrets(routine);
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.listRoutineRuns = definition(
    automation,
    async ([routineId, limit]) => {
      if (routineId !== undefined) {
        const routine = await currentRoutineService()!.get(String(routineId));
        if (!routine) return [];
        await visibleRoutine(routine, "canViewAgents");
      }
      const rows = await currentRoutineService()!.listRuns(
        routineId as string | undefined,
        limit as number | undefined,
      );
      const visibleIds = new Set(
        (await filterRoutines(await currentRoutineService()!.list())).map((routine) => routine.id),
      );
      return rows.filter((row) => visibleIds.has(row.routineId));
    },
    {
      maxArgs: 2,
      validate: (args) => [
        args[0] === undefined ? undefined : stringArg(args[0]),
        optionalInteger(args[1], 1, 500),
      ],
    },
  );
  definitions.createRoutine = definition(
    automation,
    async ([request]) => {
      const input = validateRoutineCreate(request) as unknown as RoutineCreate;
      await permission(input.workspaceId, "canManageRoutines");
      const target = input.executionTarget;
      if (target.kind === "managed_environment") {
        const environment = await managed.getEnvironment(target.managedEnvironmentId!);
        if (!environment || environment.config.workspaceId !== input.workspaceId) {
          throw new WebApplicationError(
            "FORBIDDEN",
            "The managed environment is outside this workspace.",
            403,
          );
        }
      }
      if (input.triggers?.some((trigger) => trigger.type === "schedule") && !cronService()) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Scheduled routine triggers are unavailable on this host.",
          501,
        );
      }
      if (
        input.triggers?.some((trigger) =>
          ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
            trigger.type,
          ),
        ) &&
        !eventTriggerService()
      ) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Event routine triggers are unavailable on this host.",
          501,
        );
      }
      await startOwnedWorkflowRuntime();
      return routineWithoutSecrets(await currentRoutineService()!.create(input));
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = validateRoutineCreate(args[0]) as unknown as RoutineCreate;
        if (input.triggers?.some((trigger) => trigger.type === "schedule") && !cronService()) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Scheduled routine triggers are unavailable on this host.",
            501,
          );
        }
        if (
          input.triggers?.some((trigger) =>
            ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
              trigger.type,
            ),
          ) &&
          !eventTriggerService()
        ) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Event routine triggers are unavailable on this host.",
            501,
          );
        }
        if (input.workflow !== undefined) {
          const validation = currentRoutineService()!.validateWorkflow(
            input.workflow as RoutineWorkflowDefinition,
            input.enabled !== true,
          );
          if (validation.issues.some((issue) => issue.severity === "error"))
            return invalidRequest();
        }
        return [input];
      },
    },
  );
  definitions.updateRoutine = definition(
    automation,
    async ([id, patch]) => {
      const routineId = String(id);
      const existing = await currentRoutineService()!.get(routineId);
      if (!existing) return null;
      await visibleRoutine(existing);
      const next = patch as RoutinePatch;
      if (next.workspaceId && next.workspaceId !== existing.workspaceId)
        await permission(next.workspaceId, "canManageRoutines");
      const nextWorkspaceId = next.workspaceId || existing.workspaceId;
      const nextTarget = next.executionTarget || existing.executionTarget;
      if (
        next.enabled === true &&
        (nextTarget.kind === "device" || nextTarget.kind === "worktree")
      ) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Device or worktree routine execution is unavailable on this browser host.",
          501,
        );
      }
      if (nextTarget.kind === "managed_environment") {
        const environment = await managed.getEnvironment(nextTarget.managedEnvironmentId!);
        if (!environment || environment.config.workspaceId !== nextWorkspaceId) {
          throw new WebApplicationError(
            "FORBIDDEN",
            "The managed environment is outside this workspace.",
            403,
          );
        }
      }
      if (next.triggers?.some((trigger) => trigger.type === "schedule") && !cronService()) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Scheduled routine triggers are unavailable on this host.",
          501,
        );
      }
      if (
        next.triggers?.some((trigger) =>
          ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
            trigger.type,
          ),
        ) &&
        !eventTriggerService()
      ) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Event routine triggers are unavailable on this host.",
          501,
        );
      }
      await startOwnedWorkflowRuntime();
      const updated = await currentRoutineService()!.update(routineId, next);
      return updated ? routineWithoutSecrets(updated) : null;
    },
    {
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => {
        const validated = validateRoutinePatch(args);
        const patch = validated[1] as RoutinePatch;
        if (patch.triggers?.some((trigger) => trigger.type === "schedule") && !cronService()) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Scheduled routine triggers are unavailable on this host.",
            501,
          );
        }
        if (
          patch.triggers?.some((trigger) =>
            ["connector_event", "channel_event", "mailbox_event", "github_event"].includes(
              trigger.type,
            ),
          ) &&
          !eventTriggerService()
        ) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Event routine triggers are unavailable on this host.",
            501,
          );
        }
        if (patch.workflow !== undefined) {
          const validation = currentRoutineService()!.validateWorkflow(
            patch.workflow,
            patch.enabled === false,
          );
          if (validation.issues.some((issue) => issue.severity === "error"))
            return invalidRequest();
        }
        return validated;
      },
    },
  );
  definitions.removeRoutine = definition(
    automation,
    async ([id]) => {
      const routine = await currentRoutineService()!.get(String(id));
      if (!routine) return false;
      await visibleRoutine(routine);
      return currentRoutineService()!.remove(routine.id);
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.runRoutineNow = definition(
    automation,
    async ([id]) => {
      const routine = await currentRoutineService()!.get(String(id));
      if (!routine) return null;
      await visibleRoutine(routine, "canRunAgents");
      if (
        routine.executionTarget.kind === "device" ||
        routine.executionTarget.kind === "worktree"
      ) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Device or worktree routine execution is unavailable on this browser host.",
          501,
        );
      }
      return currentRoutineService()!.runNow(routine.id);
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  definitions.getRoutineWorkflowCapabilities = definition(automation, () => {
    const routineService = currentRoutineService();
    return workflowCapabilitiesWithRuntimeState(
      routineService!.getWorkflowCapabilities(),
      Boolean(options.executeWorkflowAction || routineService !== ownedRoutineService),
      Boolean(eventTriggerService()),
    );
  });
  definitions.validateRoutineWorkflow = definition(
    automation,
    ([workflow, allowIncomplete]) => {
      if (allowIncomplete !== undefined && typeof allowIncomplete !== "boolean")
        return invalidRequest();
      return currentRoutineService()!.validateWorkflow(
        validateWorkflowShape(workflow),
        allowIncomplete === true,
      );
    },
    {
      minArgs: 1,
      maxArgs: 2,
      validate: (args) => [validateWorkflowShape(args[0]), optionalBoolean(args[1])],
    },
  );
  definitions.generateRoutineWorkflow = definition(
    automation,
    ([prompt]) => currentRoutineService()!.generateWorkflowDraft(textArg(prompt, 20_000)),
    { minArgs: 1, maxArgs: 1, validate: (args) => [textArg(args[0], 20_000)] },
  );
  definitions.saveRoutineWorkflowDraft = definition(
    automation,
    async ([routineId, workflow]) => {
      const routine = await currentRoutineService()!.get(String(routineId));
      if (!routine) throw new Error("Routine not found.");
      await visibleRoutine(routine);
      await startOwnedWorkflowRuntime();
      return currentRoutineService()!.saveWorkflowDraft(
        routine.id,
        validateWorkflowShape(workflow),
      );
    },
    {
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => {
        const workflow = validateWorkflowShape(args[1]);
        const validation = currentRoutineService()!.validateWorkflow(workflow, true);
        if (validation.issues.some((issue) => issue.severity === "error")) return invalidRequest();
        return [stringArg(args[0]), workflow];
      },
    },
  );
  definitions.listRoutineWorkflowVersions = definition(
    automation,
    async ([routineId]) => {
      const routine = await currentRoutineService()!.get(String(routineId));
      if (!routine) return [];
      await visibleRoutine(routine, "canViewAgents");
      return currentRoutineService()!.listWorkflowVersions(routine.id);
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.activateRoutineWorkflowVersion = definition(
    automation,
    async ([routineId, versionId]) => {
      const routine = await currentRoutineService()!.get(String(routineId));
      if (!routine) return null;
      await visibleRoutine(routine);
      await startOwnedWorkflowRuntime();
      const updated = await currentRoutineService()!.activateWorkflowVersion(
        routine.id,
        String(versionId),
      );
      return updated ? routineWithoutSecrets(updated) : null;
    },
    {
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => [stringArg(args[0]), stringArg(args[1])],
    },
  );
  definitions.testRoutineWorkflow = definition(
    automation,
    async ([request]) => {
      const input = validateRoutineWorkflowTest(request);
      if (input.routineId !== undefined) {
        const routine = await currentRoutineService()!.get(stringArg(input.routineId));
        if (!routine) {
          throw new WebApplicationError("INVALID_REQUEST", "Routine not found.", 404);
        }
        if (input.dryRun === false) {
          const workspace = await readableWorkspace(routine.workspaceId);
          if (!workspace?.permissions.write) {
            throw new WebApplicationError(
              "FORBIDDEN",
              "A live workflow test requires a writable workspace.",
              403,
            );
          }
        }
        await visibleRoutine(routine, "canRunAgents");
      }
      if (
        input.dryRun === false &&
        !options.executeWorkflowAction &&
        currentRoutineService() === ownedRoutineService
      ) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "Workflow action execution is unavailable on this host.",
          501,
        );
      }
      return currentRoutineService()!.testWorkflow(input);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = validateRoutineWorkflowTest(args[0]);
        if (
          input.dryRun === false &&
          !options.executeWorkflowAction &&
          currentRoutineService() === ownedRoutineService
        ) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Workflow action execution is unavailable on this host.",
            501,
          );
        }
        if (input.workflow !== undefined) {
          const validation = currentRoutineService()!.validateWorkflow(
            input.workflow,
            input.dryRun !== false,
          );
          if (validation.issues.some((issue) => issue.severity === "error"))
            return invalidRequest();
        }
        return [input];
      },
    },
  );
  definitions.listRoutineWorkflowRuns = definition(
    automation,
    async ([routineId, limit]) => {
      if (routineId !== undefined) {
        const routine = await currentRoutineService()!.get(String(routineId));
        if (!routine) return [];
        await visibleRoutine(routine, "canViewAgents");
      }
      const rows = await currentRoutineService()!.listWorkflowRuns(
        routineId as string | undefined,
        limit as number | undefined,
      );
      if (routineId !== undefined) return rows;
      const visibleIds = new Set(
        (await filterRoutines(await currentRoutineService()!.list())).map((routine) => routine.id),
      );
      return rows.filter((row) => visibleIds.has(row.routineId));
    },
    {
      maxArgs: 2,
      validate: (args) => [
        args[0] === undefined ? undefined : stringArg(args[0]),
        optionalInteger(args[1], 1, 500),
      ],
    },
  );
  definitions.listRoutineWorkflowSteps = definition(
    automation,
    async ([runId]) => {
      const run = await currentRoutineService()!
        .listWorkflowRuns(undefined, 500)
        .then((runs) => runs.find((item) => item.id === String(runId)));
      if (!run) return [];
      const routine = await currentRoutineService()!.get(run.routineId);
      if (!routine) return [];
      await visibleRoutine(routine, "canViewAgents");
      return currentRoutineService()!.listWorkflowRunSteps(run.id);
    },
    { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  // The desktop renderer uses this name for workflow run detail refreshes.
  // Keep the shorter legacy method as an alias for callers that already use it.
  definitions.listRoutineWorkflowRunSteps = definitions.listRoutineWorkflowSteps;
  definitions.listRoutineWorkflowEvents = definition(
    automation,
    async ([routineId, limit]) => {
      if (routineId !== undefined) {
        const routine = await currentRoutineService()!.get(String(routineId));
        if (!routine) return [];
        await visibleRoutine(routine, "canViewAgents");
      }
      const rows = await currentRoutineService()!.listWorkflowEvents(
        routineId as string | undefined,
        limit as number | undefined,
      );
      if (routineId !== undefined) return rows;
      const visibleIds = new Set(
        (await filterRoutines(await currentRoutineService()!.list())).map((routine) => routine.id),
      );
      return rows.filter((row) => visibleIds.has(row.routineId));
    },
    {
      maxArgs: 2,
      validate: (args) => [
        args[0] === undefined ? undefined : stringArg(args[0]),
        optionalInteger(args[1], 1, 500),
      ],
    },
  );
  definitions.respondToRoutineWorkflowApproval = definition(
    automation,
    async ([request]) => {
      const input = requireRecord(request, ["runId", "stepId", "approved"]);
      if (typeof input.approved !== "boolean") return invalidRequest();
      const run = (await currentRoutineService()!.listWorkflowRuns(undefined, 500)).find(
        (candidate) => candidate.id === stringArg(input.runId),
      );
      const routine = run ? await currentRoutineService()!.get(run.routineId) : null;
      if (!routine) throw new Error("Workflow run not found.");
      await visibleRoutine(routine, "canRunAgents");
      return currentRoutineService()!.respondToWorkflowApproval({
        runId: run!.id,
        stepId: stringArg(input.stepId),
        approved: input.approved,
      });
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const input = requireRecord(args[0], ["runId", "stepId", "approved"]);
        if (typeof input.approved !== "boolean") return invalidRequest();
        return [
          {
            runId: stringArg(input.runId),
            stepId: stringArg(input.stepId),
            approved: input.approved,
          },
        ];
      },
    },
  );
  definitions.retryRoutineWorkflowRun = definition(
    automation,
    async ([runId]) => {
      const run = (await currentRoutineService()!.listWorkflowRuns(undefined, 500)).find(
        (candidate) => candidate.id === String(runId),
      );
      const routine = run ? await currentRoutineService()!.get(run.routineId) : null;
      if (!routine) return null;
      await visibleRoutine(routine, "canRunAgents");
      return currentRoutineService()!.retryWorkflowRun(run!.id);
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.cancelRoutineWorkflowRun = definition(
    automation,
    async ([runId]) => {
      const run = (await currentRoutineService()!.listWorkflowRuns(undefined, 500)).find(
        (candidate) => candidate.id === String(runId),
      );
      const routine = run ? await currentRoutineService()!.get(run.routineId) : null;
      if (!routine) return null;
      await visibleRoutine(routine, "canRunAgents");
      return currentRoutineService()!.cancelWorkflowRun(run!.id);
    },
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );
  definitions.listRoutineWorkflowSecrets = definition(automation, () =>
    currentRoutineService()!.listWorkflowSecrets(),
  );
  definitions.upsertRoutineWorkflowSecret = definition(
    automation,
    ([input]) => {
      const value = requireRecord(input, ["id", "name", "value"]);
      return currentRoutineService()!.upsertWorkflowSecret({
        ...(value.id === undefined ? {} : { id: stringArg(value.id) }),
        name: textArg(value.name, 200),
        value: textArg(value.value, 16_384),
      });
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        const value = requireRecord(args[0], ["id", "name", "value"]);
        if (value.id !== undefined) stringArg(value.id);
        textArg(value.name, 200);
        textArg(value.value, 16_384);
        return [boundedJson(value)];
      },
    },
  );
  definitions.removeRoutineWorkflowSecret = definition(
    automation,
    ([id]) => currentRoutineService()!.removeWorkflowSecret(String(id)),
    { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
  );

  const cronAvailable = Boolean(
    options.getCronService ? options.getCronService() : getCronService(),
  );
  if (cronAvailable) {
    async function readableCronJob(
      id: string,
      key: ManagedPermission = "canViewAgents",
    ): Promise<CronJob | null> {
      const job = await cronService()!.get(id);
      if (!job) return null;
      await permission(job.workspaceId, key);
      return job;
    }

    async function validateCronExecutionTarget(
      job: Pick<CronJob, "workspaceId" | "runMode" | "targetTaskId" | "workflowRoutineId">,
    ): Promise<void> {
      await permission(job.workspaceId, "canRunAgents");
      if (job.runMode === "thread_follow_up") {
        if (!job.targetTaskId)
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "A target task is required for a follow-up job.",
            400,
          );
        const task = taskStore.findById(job.targetTaskId);
        if (!task || task.workspaceId !== job.workspaceId)
          throw new WebApplicationError(
            "FORBIDDEN",
            "The target task is outside this workspace.",
            403,
          );
      }
      if (job.runMode === "workflow") {
        if (!job.workflowRoutineId)
          throw new WebApplicationError(
            "INVALID_REQUEST",
            "A routine is required for workflow jobs.",
            400,
          );
        const routine = await currentRoutineService()!.get(job.workflowRoutineId);
        if (!routine || routine.workspaceId !== job.workspaceId)
          throw new WebApplicationError(
            "FORBIDDEN",
            "The workflow is outside this workspace.",
            403,
          );
        if (
          routine.executionTarget.kind === "device" ||
          routine.executionTarget.kind === "worktree"
        ) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Device or worktree routine execution is unavailable on this browser host.",
            501,
          );
        }
        await visibleRoutine(routine, "canRunAgents");
      }
    }

    definitions.getCronStatus = definition(automation, async () => {
      const status = await cronService()!.status();
      const jobs = await cronService()!.list({ includeDisabled: true });
      const visible: CronJob[] = [];
      for (const job of jobs) {
        try {
          await permission(job.workspaceId, "canViewAgents");
          visible.push(job);
        } catch {
          /* private workspace */
        }
      }
      const { storePath: _storePath, scheduler, ...safe } = status;
      const { runnerHost: _runnerHost, ...safeScheduler } = scheduler;
      return {
        ...safe,
        jobCount: visible.length,
        enabledJobCount: visible.filter((job) => job.enabled).length,
        runningJobCount: visible.filter((job) => job.state.runningAtMs !== undefined).length,
        scheduler: safeScheduler,
      };
    });
    definitions.listCronJobs = definition(
      automation,
      async ([params]) => {
        const input = params === undefined ? undefined : requireRecord(params, ["includeDisabled"]);
        if (input?.includeDisabled !== undefined && typeof input.includeDisabled !== "boolean")
          return invalidRequest();
        const result = await cronService()!.list(
          input as { includeDisabled?: boolean } | undefined,
        );
        const visible: CronJob[] = [];
        for (const job of result) {
          try {
            await permission(job.workspaceId, "canViewAgents");
            visible.push(safeCronJob(job) as CronJob);
          } catch {
            /* private workspace */
          }
        }
        return visible;
      },
      {
        maxArgs: 1,
        validate: (args) => {
          if (args[0] === undefined) return [undefined];
          const input = requireRecord(args[0], ["includeDisabled"]);
          if (input.includeDisabled !== undefined && typeof input.includeDisabled !== "boolean")
            return invalidRequest();
          return [input];
        },
      },
    );
    definitions.getCronJob = definition(
      automation,
      async ([id]) => {
        const job = await readableCronJob(String(id));
        return job ? safeCronJob(job) : null;
      },
      { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
    definitions.addCronJob = definition(
      automation,
      async ([rawJob]) => {
        const job = validateCronJobFields(rawJob, false) as unknown as CronJobCreate;
        await permission(job.workspaceId, "canManageRoutines");
        if (job.enabled) await validateCronExecutionTarget(job);
        const result = await cronService()!.add(job);
        return result.ok ? { ...result, job: safeCronJob(result.job) } : result;
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => [validateCronJobFields(args[0], false)],
      },
    );
    definitions.updateCronJob = definition(
      automation,
      async ([rawId, rawPatch]) => {
        const id = String(rawId);
        const existing = await readableCronJob(id, "canManageRoutines");
        if (!existing) return { ok: false, error: "Job not found" };
        const patch = validateCronJobFields(rawPatch, true) as unknown as CronJobPatch;
        if (patch.workspaceId && patch.workspaceId !== existing.workspaceId)
          await permission(patch.workspaceId, "canManageRoutines");
        const nextJob = {
          ...existing,
          ...patch,
          workspaceId: patch.workspaceId || existing.workspaceId,
        };
        if (nextJob.enabled) await validateCronExecutionTarget(nextJob);
        const result = await cronService()!.update(id, patch);
        return result.ok ? { ...result, job: safeCronJob(result.job) } : result;
      },
      {
        mutation: true,
        minArgs: 2,
        maxArgs: 2,
        validate: (args) => [stringArg(args[0]), validateCronJobFields(args[1], true)],
      },
    );
    definitions.removeCronJob = definition(
      automation,
      async ([id]) => {
        const job = await readableCronJob(String(id), "canManageRoutines");
        return job ? cronService()!.remove(job.id) : { ok: true, removed: false };
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
    definitions.runCronJob = definition(
      automation,
      async ([id, mode]) => {
        const job = await readableCronJob(String(id), "canRunAgents");
        if (!job) return { ok: true, ran: false, reason: "not-found" as const };
        await validateCronExecutionTarget(job);
        return cronService()!.run(job.id, mode as "due" | "force" | undefined);
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 2,
        validate: (args) => [
          stringArg(args[0]),
          args[1] === undefined
            ? undefined
            : args[1] === "due" || args[1] === "force"
              ? args[1]
              : invalidRequest(),
        ],
      },
    );
    definitions.getCronRunHistory = definition(
      automation,
      async ([id]) => {
        const job = await readableCronJob(String(id));
        if (!job) return null;
        const result = await cronService()!.getRunHistory(job.id);
        if (!result) return null;
        const entries = [];
        for (const { runWorkspacePath: _runWorkspacePath, ...entry } of result.entries) {
          if (
            !entry.workspaceId ||
            entry.workspaceId === job.workspaceId ||
            (await readableWorkspace(entry.workspaceId))
          )
            entries.push(entry);
        }
        return { ...result, entries };
      },
      { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
    definitions.clearCronRunHistory = definition(
      automation,
      async ([id]) => {
        const job = await readableCronJob(String(id), "canManageRoutines");
        return job ? cronService()!.clearRunHistory(job.id) : false;
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
  }

  const triggersAvailable = Boolean(eventTriggerService());
  if (triggersAvailable) {
    definitions.listTriggers = definition(
      automation,
      async ([rawWorkspaceId]) => {
        const service = eventTriggerService();
        if (!service?.listTriggers)
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Event trigger listing is unavailable.",
            501,
          );
        const workspaceId =
          rawWorkspaceId === undefined || rawWorkspaceId === ""
            ? undefined
            : stringArg(rawWorkspaceId);
        if (workspaceId) {
          await permission(workspaceId, "canViewAgents");
          return service.listTriggers!(workspaceId).map(safeEventTrigger);
        }
        const visibleIds = new Set(
          (await listReadableWorkspaces()).map((workspace) => workspace.id),
        );
        return service.listTriggers!()
          .filter((trigger) => visibleIds.has(trigger.workspaceId))
          .map(safeEventTrigger);
      },
      {
        maxArgs: 1,
        validate: (args) => [args[0] === undefined || args[0] === "" ? "" : stringArg(args[0])],
      },
    );
    definitions.addTrigger = definition(
      automation,
      async ([value]) => {
        const input = validateEventTriggerInput(value) as Omit<
          EventTrigger,
          "id" | "fireCount" | "createdAt" | "updatedAt"
        >;
        await permission(input.workspaceId, "canManageRoutines");
        const actionWorkspace = input.action.config.workspaceId;
        if (actionWorkspace && actionWorkspace !== input.workspaceId)
          throw new WebApplicationError(
            "FORBIDDEN",
            "The action workspace must match its trigger workspace.",
            403,
          );
        if (input.action.config.runMode === "thread_follow_up") {
          const targetTaskId = input.action.config.targetTaskId;
          const task = targetTaskId ? taskStore.findById(targetTaskId) : null;
          if (!task || task.workspaceId !== input.workspaceId)
            throw new WebApplicationError(
              "FORBIDDEN",
              "The target task is outside this workspace.",
              403,
            );
        }
        return eventTriggerService()!.addTrigger(input);
      },
      {
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => [validateEventTriggerInput(args[0])],
      },
    );
    definitions.updateTrigger = definition(
      automation,
      async ([id, patch]) => {
        const trigger = eventTriggerService()!.getTrigger(String(id));
        if (!trigger) return null;
        await permission(trigger.workspaceId, "canManageRoutines");
        const updates = validateEventTriggerInput(patch, true) as Partial<EventTrigger>;
        const next = validateEventTriggerInput({
          ...trigger,
          ...updates,
        }) as unknown as EventTrigger;
        if (next.workspaceId !== trigger.workspaceId)
          await permission(next.workspaceId, "canManageRoutines");
        const actionWorkspace = next.action.config.workspaceId;
        if (actionWorkspace && actionWorkspace !== next.workspaceId)
          throw new WebApplicationError(
            "FORBIDDEN",
            "The action workspace must match its trigger workspace.",
            403,
          );
        if (next.action.config.runMode === "thread_follow_up") {
          const targetTaskId = next.action.config.targetTaskId;
          const task = targetTaskId ? taskStore.findById(targetTaskId) : null;
          if (!task || task.workspaceId !== next.workspaceId)
            throw new WebApplicationError(
              "FORBIDDEN",
              "The target task is outside this workspace.",
              403,
            );
        }
        return eventTriggerService()!.updateTrigger(String(id), updates);
      },
      {
        mutation: true,
        minArgs: 2,
        maxArgs: 2,
        validate: (args) => [stringArg(args[0]), validateEventTriggerInput(args[1], true)],
      },
    );
    definitions.removeTrigger = definition(
      automation,
      async ([id]) => {
        const trigger = eventTriggerService()!.getTrigger(String(id));
        if (!trigger) return false;
        await permission(trigger.workspaceId, "canManageRoutines");
        return eventTriggerService()!.removeTrigger(String(id));
      },
      { mutation: true, minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
    definitions.getTriggerHistory = definition(
      automation,
      async ([id]) => {
        const service = eventTriggerService();
        if (!service?.getHistory)
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "Event trigger history is unavailable.",
            501,
          );
        const trigger = service.getTrigger(String(id));
        if (!trigger) return [];
        await permission(trigger.workspaceId, "canViewAgents");
        return service.getHistory(String(id)).map(({ eventData, ...entry }) => ({
          ...entry,
          eventData: safeBrowserPayload(eventData) as Record<string, unknown>,
        }));
      },
      { minArgs: 1, maxArgs: 1, validate: simpleIdValidator },
    );
  }

  definitions.everydayAgentGetProfile = definition(memory, () => everyday.getProfile());
  definitions.everydayAgentUpdateProfile = definition(
    memory,
    async ([updates]) => {
      const request = validateEverydayProfileUpdate(updates);
      for (const workspaceId of [
        ...(request.workspaceScopes || []),
        ...(request.memoryPolicy?.allowedWorkspaceIds || []),
      ]) {
        await permission(workspaceId, "canManageRoutines");
      }
      return everyday.updateProfile(request);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEverydayProfileUpdate(args[0])],
    },
  );
  definitions.everydayAgentAcceptConsent = definition(
    memory,
    async ([request]) => {
      const input =
        request === undefined
          ? undefined
          : requireRecord(request, ["enabled", "workspaceId", "accepted"]);
      if (input?.enabled !== undefined && typeof input.enabled !== "boolean")
        return invalidRequest();
      if (input?.accepted !== undefined && typeof input.accepted !== "boolean")
        return invalidRequest();
      let workspaceId = input?.workspaceId === undefined ? undefined : stringArg(input.workspaceId);
      if ((input?.enabled === true || input?.accepted === true) && !workspaceId) {
        workspaceId = (await listReadableWorkspaces())[0]?.id;
      }
      if ((input?.enabled === true || input?.accepted === true) && !workspaceId) {
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "A readable workspace is required to enable Everyday Agent.",
          400,
        );
      }
      if (workspaceId) await permission(workspaceId, "canEditDrafts");
      return everyday.acceptConsent({ ...input, workspaceId } as Parameters<
        EverydayAgentService["acceptConsent"]
      >[0]);
    },
    {
      mutation: true,
      maxArgs: 1,
      validate: (args) => {
        if (args[0] === undefined) return [undefined];
        const input = requireRecord(args[0], ["enabled", "workspaceId", "accepted"]);
        if (input.enabled !== undefined) optionalBoolean(input.enabled);
        if (input.accepted !== undefined) optionalBoolean(input.accepted);
        if (input.workspaceId !== undefined) stringArg(input.workspaceId);
        return [input];
      },
    },
  );
  definitions.everydayAgentPause = definition(
    memory,
    async ([scope]) => {
      const request = validateEverydayPause(scope);
      if (request.kind === "workspace" && request.targetId)
        await permission(request.targetId, "canManageRoutines");
      return everyday.pause(request);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEverydayPause(args[0])],
    },
  );
  definitions.everydayAgentRevokeCapability = definition(
    memory,
    ([capability]) => {
      return everyday.revokeCapability(validateEverydayBundle(capability));
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEverydayBundle(args[0])],
    },
  );
  definitions.everydayAgentListReceipts = definition(
    memory,
    async ([request]) => {
      const input =
        request === undefined
          ? {}
          : requireRecord(request, ["profileId", "workspaceId", "capability", "limit", "offset"]);
      const profileId = input.profileId === undefined ? undefined : stringArg(input.profileId);
      if (profileId && profileId !== (await everyday.getProfile()).profile.id) {
        throw new WebApplicationError("FORBIDDEN", "Everyday Agent profile is unavailable.", 403);
      }
      const workspaceId =
        input.workspaceId === undefined ? undefined : stringArg(input.workspaceId);
      if (workspaceId) {
        await permission(workspaceId, "canViewAgents");
        return everyday.listReceipts({
          profileId,
          workspaceId,
          ...(input.capability === undefined
            ? {}
            : { capability: validateEverydayBundle(input.capability) }),
          ...(input.limit === undefined ? {} : { limit: integerArg(input.limit, 1, 200) }),
          ...(input.offset === undefined ? {} : { offset: integerArg(input.offset, 0, 1_000_000) }),
        } as EverydayAgentListReceiptsRequest);
      }
      const all = await everyday.listReceipts({ profileId, limit: 500, offset: 0 });
      const workspaceIds = new Set(
        (await listReadableWorkspaces()).map((workspace) => workspace.id),
      );
      const scoped = all.filter(
        (receipt) => !receipt.workspaceId || workspaceIds.has(receipt.workspaceId),
      );
      const capability =
        input.capability === undefined ? undefined : validateEverydayBundle(input.capability);
      const filtered = capability
        ? scoped.filter((receipt) => receipt.capability === capability)
        : scoped;
      const offset = input.offset === undefined ? 0 : integerArg(input.offset, 0, 1_000_000);
      const limit = input.limit === undefined ? 100 : integerArg(input.limit, 1, 200);
      return filtered.slice(offset, offset + limit);
    },
    {
      maxArgs: 1,
      validate: (args) => {
        if (args[0] === undefined) return [undefined];
        const input = requireRecord(args[0], [
          "profileId",
          "workspaceId",
          "capability",
          "limit",
          "offset",
        ]);
        if (input.profileId !== undefined) stringArg(input.profileId);
        if (input.workspaceId !== undefined) stringArg(input.workspaceId);
        if (input.capability !== undefined) validateEverydayBundle(input.capability);
        if (input.limit !== undefined) integerArg(input.limit, 1, 200);
        if (input.offset !== undefined) integerArg(input.offset, 0, 1_000_000);
        return [input];
      },
    },
  );
  definitions.everydayAgentClearData = definition(
    memory,
    ([request]) =>
      everyday.clearData(
        request === undefined
          ? undefined
          : (boundedJson(
              requireRecord(request, [
                "profile",
                "receipts",
                "previews",
                "trustPatterns",
                "consentHistory",
                "pauseScopes",
                "memoryCandidates",
                "routineProvenance",
                "cachedConnectorSummaries",
                "browserProfileMetadata",
              ]),
            ) as EverydayAgentClearDataRequest),
      ),
    {
      mutation: true,
      maxArgs: 1,
      validate: (args) => {
        if (args[0] === undefined) return [undefined];
        const input = requireRecord(args[0], [
          "profile",
          "receipts",
          "previews",
          "trustPatterns",
          "consentHistory",
          "pauseScopes",
          "memoryCandidates",
          "routineProvenance",
          "cachedConnectorSummaries",
          "browserProfileMetadata",
        ]);
        if (Object.values(input).some((value) => typeof value !== "boolean"))
          return invalidRequest();
        return [input];
      },
    },
  );
  definitions.everydayAgentPreviewAction = definition(
    memory,
    async ([input]) => {
      const request = validateEverydayActionPreview(input);
      if (request.workspaceId !== undefined) {
        await permission(request.workspaceId, "canRunAgents");
      }
      return everyday.previewAction(request);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEverydayActionPreview(args[0])],
    },
  );
  definitions.everydayAgentApproveAction = definition(
    memory,
    async ([request]) => {
      const input = validateEverydayApprove(request);
      const row = db
        .prepare("SELECT preview_json FROM everyday_agent_action_previews WHERE id = ?")
        .get(input.previewId) as { preview_json?: string } | undefined;
      if (!row?.preview_json)
        throw new WebApplicationError("INVALID_REQUEST", "Everyday Agent preview not found.", 400);
      let preview: RecordLike;
      try {
        preview = JSON.parse(row.preview_json) as RecordLike;
      } catch {
        throw new Error("Everyday Agent preview is unreadable.");
      }
      if (preview.profileId !== (await everyday.getProfile()).profile.id) {
        throw new WebApplicationError("FORBIDDEN", "Everyday Agent preview is unavailable.", 403);
      }
      if (typeof preview.workspaceId === "string")
        await permission(preview.workspaceId, "canAnswerApprovals");
      return everyday.approveAction(input);
    },
    {
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateEverydayApprove(args[0])],
    },
  );

  return {
    definitions,
    dispose: () => {
      if (ownedRoutineService && workflowRuntimeStarted) ownedRoutineService.stopWorkflowRuntime();
      workflowRuntimeStarted = false;
    },
  };
}
