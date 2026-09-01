import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Bot,
  Briefcase,
  Bug,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Circle,
  FileText,
  Image as ImageIcon,
  Inbox,
  Library,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Search,
  Send,
  ShieldCheck,
  Slack,
  Sparkles,
  Wrench,
} from "lucide-react";
import type {
  AgentTemplate,
  AgentBuilderConnectionRequirement,
  AgentBuilderPlan,
  AgentBuilderSelectionOption,
  AgentBuilderSelectionRequirement,
  AgentStarterPrompt,
  AgentWorkspacePermissionSnapshot,
  ApprovalType,
  ChannelData,
  ImageGenProfile,
  ManagedAgent,
  ManagedAgentAuditEntry,
  ManagedAgentInsights,
  ManagedAgentApprovalPolicy,
  ManagedAgentChannelTarget,
  ManagedAgentDeploymentConfig,
  ManagedAgentFileRef,
  ManagedAgentMemoryConfig,
  ManagedAgentRoutineRecord,
  ManagedAgentRoutineTriggerConfig,
  ManagedAgentSlackDeploymentHealth,
  ManagedAgentRuntimeToolCatalog,
  ManagedAgentRuntimeToolCatalogEntry,
  ManagedAgentScheduleConfig,
  ManagedAgentSharingConfig,
  ManagedAgentStudioConfig,
  ManagedAgentTeamTemplate,
  ManagedAgentToolFamily,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionEvent,
  ManagedSessionWorkpaper,
  SecurityMode,
  Workspace,
} from "../../shared/types";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  BUILTIN_ACCESS_PROFILES,
  getAccessProfileLabel,
  type AccessProfileDefinition,
  type AccessProfileId,
} from "../../shared/access-profiles";
import { getEmojiIcon } from "../utils/emoji-icon-map";

type SkillLite = {
  id: string;
  name: string;
  description?: string;
};

type PluginPackLite = {
  name: string;
  displayName: string;
  recommendedConnectors?: string[];
};

type AgentsHubAgentRole = {
  id: string;
  name?: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
  isActive: boolean;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatPolicy?: {
    enabled?: boolean;
    cadenceMinutes?: number;
  };
  pulseEveryMinutes?: number;
};

type AgentsLibraryTab = "all" | "recent" | "mine" | "scheduled" | "templates";

type AgentDraft = {
  agentId?: string;
  status?: ManagedAgent["status"];
  templateId?: string;
  workflowBrief: string;
  name: string;
  subtitle?: string;
  description: string;
  icon: string;
  color?: string;
  systemPrompt: string;
  operatingNotes: string;
  starterPrompts: AgentStarterPrompt[];
  builderPlan?: AgentBuilderPlan;
  missingConnections: AgentBuilderConnectionRequirement[];
  executionMode: ManagedAgentVersion["executionMode"];
  teamTemplate?: ManagedAgentTeamTemplate;
  templateRequiredPackIds: string[];
  templateRequiredConnectorIds: string[];
  expectedArtifacts: NonNullable<AgentTemplate["expectedArtifacts"]>;
  teamRoleNames: string[];
  selectedSkills: string[];
  selectedMcpServers: string[];
  selectedToolFamilies: ManagedAgentToolFamily[];
  fileRefs: ManagedAgentFileRef[];
  memoryConfig: ManagedAgentMemoryConfig;
  scheduleConfig: ManagedAgentScheduleConfig;
  channelTargets: ManagedAgentChannelTarget[];
  audioSummaryEnabled: boolean;
  audioSummaryStyle: "public-radio" | "executive-briefing" | "study-guide";
  imageGenProfileId?: string;
  sharing: ManagedAgentSharingConfig;
  approvalPolicy: ManagedAgentApprovalPolicy;
  deployment: ManagedAgentDeploymentConfig;
  workspaceId: string;
  accessProfileId?: AccessProfileId;
  /** @deprecated Kept only to rehydrate old drafts; the UI no longer writes it. */
  enableShell: boolean;
  enableBrowser: boolean;
  enableComputerUse: boolean;
  defaultEnvironmentId?: string;
  routines: Array<{
    id?: string;
    name: string;
    description?: string;
    enabled: boolean;
    trigger: ManagedAgentRoutineTriggerConfig;
  }>;
};

type ConversionPanel = "agent-role" | "automation-profile" | null;

type PersistStudioDraftResult = {
  agentId: string;
  environmentId: string;
};

type AgentConnectionSettingsTab = "integrations" | "mcp" | "skills" | "morechannels" | "slack";

interface AgentsHubPanelProps {
  onOpenMissionControl?: () => void;
  onOpenAgentPersonas?: () => void;
  onOpenSlackSettings?: () => void;
  onOpenSettings?: (tab: AgentConnectionSettingsTab) => void;
  onOpenTask?: (taskId: string) => void;
}

const TOOL_FAMILY_OPTIONS: Array<{ id: ManagedAgentToolFamily; label: string }> = [
  { id: "communication", label: "Communication" },
  { id: "search", label: "Search" },
  { id: "files", label: "Files" },
  { id: "documents", label: "Documents" },
  { id: "memory", label: "Memory" },
  { id: "browser", label: "Browser" },
  { id: "computer-use", label: "Computer Use" },
  { id: "images", label: "Images" },
];

const APPROVAL_ACTION_OPTIONS = [
  "send email",
  "post message",
  "edit spreadsheet",
  "create calendar event",
  "file external ticket",
] as const;

const APPROVAL_ACTION_RUNTIME_TYPE: Record<(typeof APPROVAL_ACTION_OPTIONS)[number], ApprovalType> =
  {
    "send email": "external_service",
    "post message": "external_service",
    "edit spreadsheet": "data_export",
    "create calendar event": "external_service",
    "file external ticket": "external_service",
  };

const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  workspace_write: "Workspace write",
  delete_file: "Delete file",
  delete_multiple: "Delete multiple",
  bulk_rename: "Bulk rename",
  network_access: "Network access",
  external_file_access: "External file access",
  data_export: "Data export",
  external_service: "External service",
  run_command: "Run command",
  risk_gate: "Risk gate",
  computer_use: "Computer use",
  location_access: "Location access",
  protected_credential: "Protected credential",
};

const TOOL_APPROVAL_BEHAVIOR_ORDER: Record<
  ManagedAgentRuntimeToolCatalogEntry["approvalBehavior"],
  number
> = {
  require_approval: 0,
  workspace_policy: 1,
  auto_approve: 2,
  no_approval: 3,
};

function normalizeWorkflowText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleizeWorkflowName(value: string): string {
  return normalizeWorkflowText(value)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

export function suggestTemplateFromWorkflowBrief(
  workflowBrief: string,
  templates: AgentTemplate[],
): AgentTemplate | undefined {
  const normalized = normalizeWorkflowText(workflowBrief);
  if (!normalized) return templates[0];

  const scored = templates
    .map((template) => {
      const haystack = normalizeWorkflowText(
        [
          template.name,
          template.description,
          template.tagline || "",
          template.category,
          template.systemPrompt,
        ].join(" "),
      );
      let score = 0;
      for (const token of normalized.split(/\s+/)) {
        if (token.length < 3) continue;
        if (haystack.includes(token)) score += 1;
      }
      return { template, score };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score ? scored[0].template : templates[0];
}

function getStudioConfig(version?: ManagedAgentVersion): ManagedAgentStudioConfig | undefined {
  const metadata = version?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const studio = (metadata as Record<string, unknown>).studio;
  if (!studio || typeof studio !== "object" || Array.isArray(studio)) return undefined;
  return studio as ManagedAgentStudioConfig;
}

function sessionStatusLabel(session: ManagedSession): string {
  return session.status.replace(/_/g, " ");
}

function formatRelative(timestamp?: number): string {
  if (!timestamp) return "";
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSharingLabel(sharing?: ManagedAgentSharingConfig): string {
  if (sharing?.ownerLabel) return sharing.ownerLabel;
  if (sharing?.visibility) return sharing.visibility;
  return "Sharing not configured";
}

function formatIdentifierLabel(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toLocaleUpperCase());
}

function parseNumberedInstructionList(
  paragraph: string,
): { lead?: string; items: string[] } | null {
  const matches = [...paragraph.matchAll(/(?:^|\s)(\d{1,2})\.\s+/g)];
  if (matches.length < 2 || matches[0].index === undefined) return null;

  const firstMarkerIndex = matches[0].index + (matches[0][0].startsWith(" ") ? 1 : 0);
  const lead = paragraph.slice(0, firstMarkerIndex).trim();
  const items = matches
    .map((match, index) => {
      const markerOffset = match[0].startsWith(" ") ? 1 : 0;
      const start = (match.index || 0) + markerOffset + match[1].length + 2;
      const next = matches[index + 1];
      const end =
        next && next.index !== undefined
          ? next.index + (next[0].startsWith(" ") ? 1 : 0)
          : paragraph.length;
      return paragraph.slice(start, end).trim();
    })
    .filter(Boolean);

  return items.length > 1 ? { lead: lead || undefined, items } : null;
}

function resolveConnectionSettingsTab(
  connection: AgentBuilderConnectionRequirement,
): AgentConnectionSettingsTab {
  const haystack = `${connection.id} ${connection.label} ${connection.reason}`.toLowerCase();
  if (haystack.includes("slack")) return "slack";
  if (connection.kind === "skill" || connection.connectAction?.type === "skill") return "skills";
  if (connection.kind === "mcp_server") return "mcp";
  if (connection.kind === "channel" || connection.connectAction?.type === "channel") {
    return "morechannels";
  }
  return "integrations";
}

function uniqueValues<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function optionConnectionKeys(option: AgentBuilderSelectionOption): Set<string> {
  return new Set(
    (option.missingConnections || []).map((connection) => `${connection.kind}:${connection.id}`),
  );
}

export function getUnresolvedBuilderSelectionRequirements(
  plan?: AgentBuilderPlan | null,
): AgentBuilderSelectionRequirement[] {
  return (plan?.selectionRequirements || []).filter(
    (requirement) => requirement.required && !requirement.selectedOptionId,
  );
}

export function applyBuilderSelectionRequirement(
  plan: AgentBuilderPlan,
  requirementId: string,
  optionId: string,
): AgentBuilderPlan {
  const requirement = (plan.selectionRequirements || []).find(
    (entry) => entry.id === requirementId,
  );
  const option = requirement?.options.find((entry) => entry.id === optionId);
  if (!requirement || !option) return plan;

  const requirementToolFamilies = new Set(
    requirement.options.flatMap((entry) => entry.selectedToolFamilies || []),
  );
  const requirementMcpServers = new Set(
    requirement.options.flatMap((entry) => entry.selectedMcpServers || []),
  );
  const requirementSkills = new Set(
    requirement.options.flatMap((entry) => entry.selectedSkills || []),
  );
  const requirementConnectionKeys = new Set(
    requirement.options.flatMap((entry) => Array.from(optionConnectionKeys(entry))),
  );

  const missingConnections = [
    ...(plan.missingConnections || []).filter(
      (connection) => !requirementConnectionKeys.has(`${connection.kind}:${connection.id}`),
    ),
    ...(option.missingConnections || []),
  ];

  return {
    ...plan,
    selectedToolFamilies: uniqueValues([
      ...(plan.selectedToolFamilies || []).filter((family) => !requirementToolFamilies.has(family)),
      ...(option.selectedToolFamilies || []),
    ]),
    selectedMcpServers: uniqueValues([
      ...(plan.selectedMcpServers || []).filter((serverId) => !requirementMcpServers.has(serverId)),
      ...(option.selectedMcpServers || []),
    ]),
    connectedMcpServers: uniqueValues([
      ...(plan.connectedMcpServers || []).filter(
        (serverId) => !requirementMcpServers.has(serverId),
      ),
      ...(option.selectedMcpServers || []),
    ]),
    selectedSkills: uniqueValues([
      ...(plan.selectedSkills || []).filter((skillId) => !requirementSkills.has(skillId)),
      ...(option.selectedSkills || []),
    ]),
    missingConnections,
    recommendedMissingIntegrations: missingConnections,
    selectionRequirements: (plan.selectionRequirements || []).map((entry) =>
      entry.id === requirementId ? { ...entry, selectedOptionId: optionId } : entry,
    ),
  };
}

function isTerminalManagedSessionStatus(status?: ManagedSession["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function parseAgentRoleSoul(soul?: string): Record<string, unknown> | null {
  if (!soul) return null;
  try {
    const parsed = JSON.parse(soul) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isManagedAgentMirrorRole(role: Pick<AgentsHubAgentRole, "soul">): boolean {
  const metadata = parseAgentRoleSoul(role.soul);
  return typeof metadata?.managedAgentId === "string" || metadata?.managedAgentMigrated === true;
}

export function getMissionControlActiveAgentRoles<T extends AgentsHubAgentRole>(
  agentRoles: T[],
): T[] {
  return agentRoles.filter(
    (role) =>
      role.isActive &&
      !isManagedAgentMirrorRole(role) &&
      (role.heartbeatPolicy?.enabled === true || role.heartbeatEnabled === true),
  );
}

function extractManagedSessionContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "file" && typeof record.artifactId === "string") {
        return `Attached file ${record.artifactId}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

export function getManagedSessionEventText(event: ManagedSessionEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  const fromMessage = typeof payload?.message === "string" ? payload.message : undefined;
  const fromContent = extractManagedSessionContentText(payload?.content);
  const fromSummary = typeof payload?.summary === "string" ? payload.summary : undefined;
  const fromName = typeof payload?.name === "string" ? payload.name : undefined;
  const fromStatus = typeof payload?.status === "string" ? payload.status : undefined;
  const fromError = typeof payload?.error === "string" ? payload.error : undefined;
  return (
    fromMessage ||
    fromContent ||
    fromSummary ||
    fromError ||
    fromName ||
    fromStatus ||
    event.type.replace(/\./g, " ")
  );
}

export function buildDraftFromTemplate(
  template: AgentTemplate,
  workspaces: Workspace[],
): AgentDraft {
  const defaultWorkspaceId = workspaces[0]?.id || "";
  return {
    templateId: template.id,
    workflowBrief: template.description,
    name: template.name,
    subtitle: template.studio?.subtitle,
    description: template.description,
    icon: template.icon,
    color: template.color,
    systemPrompt: template.systemPrompt,
    operatingNotes: template.studio?.instructions?.operatingNotes || "",
    starterPrompts: template.studio?.starterPrompts || [],
    builderPlan: template.studio?.builderPlan,
    missingConnections: template.studio?.missingConnections || [],
    executionMode: template.executionMode,
    teamTemplate: template.teamTemplate,
    templateRequiredPackIds: template.requiredPackIds || template.studio?.requiredPackIds || [],
    templateRequiredConnectorIds:
      template.requiredConnectorIds || template.studio?.requiredConnectorIds || [],
    expectedArtifacts: template.expectedArtifacts || template.studio?.expectedArtifacts || [],
    teamRoleNames: template.teamRoleNames || template.studio?.teamRoleNames || [],
    selectedSkills: template.skills || template.studio?.skills || [],
    selectedMcpServers: template.mcpServers || template.studio?.apps?.mcpServers || [],
    selectedToolFamilies: template.studio?.apps?.allowedToolFamilies || [],
    fileRefs: template.studio?.fileRefs || [],
    memoryConfig: template.studio?.memoryConfig || { mode: "default", sources: ["workspace"] },
    scheduleConfig: template.studio?.scheduleConfig || {
      enabled: false,
      mode: "manual",
    },
    channelTargets: template.studio?.channelTargets || [],
    audioSummaryEnabled: template.studio?.audioSummaryConfig?.enabled || false,
    audioSummaryStyle: template.studio?.audioSummaryConfig?.style || "executive-briefing",
    imageGenProfileId: template.studio?.imageGenProfileId,
    sharing: template.studio?.sharing || { visibility: "team" },
    approvalPolicy: template.studio?.approvalPolicy || {
      autoApproveReadOnly: true,
      requireApprovalFor: [],
    },
    deployment: template.studio?.deployment || { surfaces: ["chatgpt"] },
    workspaceId: defaultWorkspaceId,
    accessProfileId: template.environmentConfig?.accessProfileId,
    enableShell: !!template.environmentConfig?.enableShell,
    enableBrowser: template.environmentConfig?.enableBrowser !== false,
    enableComputerUse: !!template.environmentConfig?.enableComputerUse,
    defaultEnvironmentId: template.studio?.defaultEnvironmentId,
    routines: [
      {
        name: `${template.name} manual run`,
        description: template.description,
        enabled: true,
        trigger: { type: "manual", enabled: true },
      },
    ],
  };
}

export function buildDraftFromAgent(
  agent: ManagedAgent,
  version: ManagedAgentVersion | undefined,
  environments: ManagedEnvironment[],
  workspaces: Workspace[],
  routines: ManagedAgentRoutineRecord[] = [],
): AgentDraft {
  const studio = getStudioConfig(version);
  const environment = environments.find((entry) => entry.id === studio?.defaultEnvironmentId);
  return {
    agentId: agent.id,
    status: agent.status,
    templateId: studio?.templateId,
    workflowBrief: studio?.workflowBrief || agent.description || "",
    name: agent.name,
    subtitle: studio?.subtitle,
    description: agent.description || "",
    icon: studio?.appearance?.icon || "🤖",
    color: studio?.appearance?.color,
    systemPrompt: version?.systemPrompt || "",
    operatingNotes: studio?.instructions?.operatingNotes || "",
    starterPrompts: studio?.starterPrompts || [],
    builderPlan: studio?.builderPlan,
    missingConnections: studio?.missingConnections || [],
    executionMode: version?.executionMode || "solo",
    teamTemplate: version?.teamTemplate,
    templateRequiredPackIds: studio?.requiredPackIds || [],
    templateRequiredConnectorIds: studio?.requiredConnectorIds || [],
    expectedArtifacts: studio?.expectedArtifacts || [],
    teamRoleNames: studio?.teamRoleNames || [],
    selectedSkills: studio?.skills || version?.skills || [],
    selectedMcpServers: studio?.apps?.mcpServers || version?.mcpServers || [],
    selectedToolFamilies: studio?.apps?.allowedToolFamilies || [],
    fileRefs: studio?.fileRefs || [],
    memoryConfig: studio?.memoryConfig || { mode: "default", sources: ["workspace"] },
    scheduleConfig: studio?.scheduleConfig || {
      enabled: false,
      mode: "manual",
    },
    channelTargets: studio?.channelTargets || [],
    audioSummaryEnabled: studio?.audioSummaryConfig?.enabled || false,
    audioSummaryStyle: studio?.audioSummaryConfig?.style || "executive-briefing",
    imageGenProfileId: studio?.imageGenProfileId,
    sharing: studio?.sharing || { visibility: "team" },
    approvalPolicy: studio?.approvalPolicy || {
      autoApproveReadOnly: true,
      requireApprovalFor: [],
    },
    deployment: studio?.deployment || {
      surfaces: (studio?.channelTargets?.length || 0) > 0 ? ["chatgpt", "slack"] : ["chatgpt"],
    },
    workspaceId: environment?.config.workspaceId || workspaces[0]?.id || "",
    accessProfileId: environment?.config.accessProfileId,
    enableShell: !!environment?.config.enableShell,
    enableBrowser: environment?.config.enableBrowser !== false,
    enableComputerUse: !!environment?.config.enableComputerUse,
    defaultEnvironmentId: studio?.defaultEnvironmentId,
    routines: routines.map((routine) => ({
      id: routine.id,
      name: routine.name,
      description: routine.description,
      enabled: routine.enabled,
      trigger: routine.trigger,
    })),
  };
}

export function makeBlankDraft(workspaces: Workspace[]): AgentDraft {
  return {
    workflowBrief: "",
    name: "New Agent",
    subtitle: "Private in CoWork OS",
    description: "",
    icon: "🤖",
    color: "#1570ef",
    systemPrompt: "You are a focused CoWork OS agent.",
    operatingNotes: "",
    starterPrompts: [],
    missingConnections: [],
    executionMode: "solo",
    templateRequiredPackIds: [],
    templateRequiredConnectorIds: [],
    expectedArtifacts: [],
    teamRoleNames: [],
    selectedSkills: [],
    selectedMcpServers: [],
    selectedToolFamilies: ["communication", "search", "files"],
    fileRefs: [],
    memoryConfig: { mode: "default", sources: ["workspace"] },
    scheduleConfig: { enabled: false, mode: "manual" },
    channelTargets: [],
    audioSummaryEnabled: false,
    audioSummaryStyle: "executive-briefing",
    sharing: { visibility: "team" },
    approvalPolicy: {
      autoApproveReadOnly: true,
      requireApprovalFor: [],
    },
    deployment: { surfaces: ["chatgpt"] },
    workspaceId: workspaces[0]?.id || "",
    accessProfileId: undefined,
    enableShell: false,
    enableBrowser: true,
    enableComputerUse: false,
    routines: [
      {
        name: "Manual run",
        enabled: true,
        trigger: { type: "manual", enabled: true },
      },
    ],
  };
}

export function buildDraftFromWorkflowBrief(
  workflowBrief: string,
  templates: AgentTemplate[],
  workspaces: Workspace[],
): AgentDraft {
  const suggestedTemplate = suggestTemplateFromWorkflowBrief(workflowBrief, templates);
  const baseDraft = suggestedTemplate
    ? buildDraftFromTemplate(suggestedTemplate, workspaces)
    : makeBlankDraft(workspaces);
  const trimmed = workflowBrief.trim();
  const derivedName = titleizeWorkflowName(trimmed) || baseDraft.name;

  return {
    ...baseDraft,
    workflowBrief: trimmed,
    name: derivedName,
    description: trimmed || baseDraft.description,
    systemPrompt: trimmed
      ? `${baseDraft.systemPrompt}\n\nPrimary workflow:\n${trimmed}\n\nFollow the team process, ask for approval when required, and leave reviewable outputs.`
      : baseDraft.systemPrompt,
  };
}

export function buildDraftFromBuilderPlan(
  plan: AgentBuilderPlan,
  workspaces: Workspace[],
): AgentDraft {
  return {
    workflowBrief: plan.workflowBrief || plan.sourcePrompt,
    name: plan.name,
    subtitle: plan.subtitle,
    description: plan.description,
    icon: plan.icon,
    color: plan.color,
    systemPrompt: plan.instructions,
    operatingNotes: plan.operatingNotes,
    starterPrompts: plan.starterPrompts || [],
    builderPlan: plan,
    missingConnections: plan.missingConnections || plan.recommendedMissingIntegrations || [],
    executionMode: "solo",
    templateId: plan.templateId,
    templateRequiredPackIds: [],
    templateRequiredConnectorIds: (plan.missingConnections || [])
      .filter((connection) => connection.kind !== "channel")
      .map((connection) => connection.id),
    expectedArtifacts: [],
    teamRoleNames: [],
    selectedSkills: plan.selectedSkills || [],
    selectedMcpServers: plan.selectedMcpServers || [],
    selectedToolFamilies: plan.selectedToolFamilies || [],
    fileRefs: [],
    memoryConfig: plan.memoryConfig || { mode: "default", sources: ["workspace"] },
    scheduleConfig: plan.scheduleConfig || { enabled: false, mode: "manual" },
    channelTargets: [],
    audioSummaryEnabled: false,
    audioSummaryStyle: "executive-briefing",
    sharing: { visibility: "private", ownerLabel: "You" },
    approvalPolicy: plan.approvalPolicy || {
      autoApproveReadOnly: true,
      requireApprovalFor: [],
    },
    deployment: { surfaces: ["chatgpt"] },
    workspaceId: workspaces[0]?.id || "",
    accessProfileId: plan.accessProfileId,
    enableShell: plan.enableShell,
    enableBrowser: plan.enableBrowser !== false,
    enableComputerUse: plan.enableComputerUse,
    routines: (
      plan.routines || [
        {
          name: `${plan.name} manual run`,
          enabled: true,
          trigger: { type: "manual" as const, enabled: true },
        },
      ]
    ).filter((routine) => routine.trigger.type !== "schedule" || plan.scheduleConfig.enabled),
  };
}

function normalizeRoleKey(value?: string): string {
  return (value || "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildTeamTemplateFromRoleNames(
  roleNames: string[],
  agentRoles: AgentsHubAgentRole[],
): ManagedAgentTeamTemplate | undefined {
  if (roleNames.length === 0) return undefined;
  const activeRoles = agentRoles.filter((role) => role.isActive !== false);
  const byKey = new Map<string, AgentsHubAgentRole>();
  for (const role of activeRoles) {
    byKey.set(normalizeRoleKey(role.name), role);
    byKey.set(normalizeRoleKey(role.displayName), role);
  }
  const resolved = roleNames
    .map((roleName) => byKey.get(normalizeRoleKey(roleName)))
    .filter((role): role is AgentsHubAgentRole => Boolean(role));
  if (resolved.length === 0) return undefined;
  const [lead, ...members] = resolved;
  return {
    leadAgentRoleId: lead.id,
    memberAgentRoleIds: members.map((role) => role.id),
    maxParallelAgents: Math.max(1, Math.min(4, members.length || 1)),
    collaborativeMode: true,
    multiLlmMode: false,
  };
}

function buildDraftFromTemplateWithRoles(
  template: AgentTemplate,
  workspaces: Workspace[],
  agentRoles: AgentsHubAgentRole[],
): AgentDraft {
  const draft = buildDraftFromTemplate(template, workspaces);
  if (draft.executionMode !== "team" || draft.teamTemplate) return draft;
  return {
    ...draft,
    teamTemplate: buildTeamTemplateFromRoleNames(draft.teamRoleNames, agentRoles),
  };
}

export function getEffectiveApprovalPreview(
  approvalPolicy?: ManagedAgentApprovalPolicy,
  deployment?: ManagedAgentDeploymentConfig,
) {
  const autoApproveReadOnly = approvalPolicy?.autoApproveReadOnly !== false;
  const requiredActions = approvalPolicy?.requireApprovalFor || [];
  const surfaces = deployment?.surfaces || ["chatgpt"];
  const autoApproved = autoApproveReadOnly ? ["read-only web and knowledge lookups"] : [];
  const gatedActions =
    requiredActions.length > 0
      ? requiredActions
      : ["send email", "post message", "edit spreadsheet", "create calendar event"];

  const sharedSummary = autoApproveReadOnly
    ? "Read-only lookup work can keep moving without a prompt."
    : "Even read-only lookup work will wait when the runtime marks it as approval-worthy.";

  return {
    autoApproved,
    gatedActions,
    sharedSummary,
    chatgptSummary: autoApproveReadOnly
      ? "In CoWork OS, the agent can research and gather context on its own, then pause for sensitive follow-through."
      : "In CoWork OS, the agent will pause more often and rely on explicit approvals before continuing.",
    slackSummary: surfaces.includes("slack")
      ? autoApproveReadOnly
        ? "In Slack, the agent can answer quickly from trusted context, but sensitive follow-through still pauses for approval."
        : "In Slack, the agent can respond, but actions remain tightly gated and will pause for approval."
      : "Slack deployment is off, so approvals only affect direct managed runs for now.",
  };
}

export function getApprovalRuntimeMatrix(approvalPolicy?: ManagedAgentApprovalPolicy): Array<{
  semanticAction: string;
  runtimeType: ApprovalType;
  runtimeLabel: string;
  behavior: "auto_approve" | "require_approval";
}> {
  const rows: Array<{
    semanticAction: string;
    runtimeType: ApprovalType;
    runtimeLabel: string;
    behavior: "auto_approve" | "require_approval";
  }> = [];
  const requiredActions = new Set(approvalPolicy?.requireApprovalFor || []);
  const autoApproveReadOnly = approvalPolicy?.autoApproveReadOnly !== false;

  rows.push({
    semanticAction: "Read-only research and documentation lookup",
    runtimeType: "network_access",
    runtimeLabel: APPROVAL_TYPE_LABELS.network_access,
    behavior: autoApproveReadOnly ? "auto_approve" : "require_approval",
  });

  for (const action of APPROVAL_ACTION_OPTIONS) {
    const runtimeType = APPROVAL_ACTION_RUNTIME_TYPE[action];
    rows.push({
      semanticAction: action,
      runtimeType,
      runtimeLabel: APPROVAL_TYPE_LABELS[runtimeType],
      behavior: requiredActions.has(action) ? "require_approval" : "auto_approve",
    });
  }

  return rows;
}

export function sortRuntimeToolCatalogEntries(
  entries: ManagedAgentRuntimeToolCatalogEntry[],
): ManagedAgentRuntimeToolCatalogEntry[] {
  return [...entries].sort((left, right) => {
    const behaviorDelta =
      TOOL_APPROVAL_BEHAVIOR_ORDER[left.approvalBehavior] -
      TOOL_APPROVAL_BEHAVIOR_ORDER[right.approvalBehavior];
    if (behaviorDelta !== 0) return behaviorDelta;
    if (left.sideEffectLevel !== right.sideEffectLevel) {
      const sideEffectOrder = { high: 0, medium: 1, low: 2, none: 3 } as const;
      return sideEffectOrder[left.sideEffectLevel] - sideEffectOrder[right.sideEffectLevel];
    }
    return left.name.localeCompare(right.name);
  });
}

function makeBlankRoutine(
  type: ManagedAgentRoutineTriggerConfig["type"] = "manual",
): AgentDraft["routines"][number] {
  return {
    name:
      type === "schedule"
        ? "Scheduled run"
        : type === "api"
          ? "API trigger"
          : type === "channel_event"
            ? "Channel event"
            : type === "mailbox_event"
              ? "Mailbox event"
              : type === "github_event"
                ? "GitHub event"
                : type === "connector_event"
                  ? "Connector event"
                  : "Manual run",
    enabled: true,
    trigger:
      type === "schedule"
        ? { type, enabled: true, cadenceMinutes: 60 }
        : type === "api"
          ? { type, enabled: true, path: "/agents/run" }
          : type === "channel_event"
            ? { type, enabled: true, channelType: "slack" }
            : type === "mailbox_event"
              ? { type, enabled: true, provider: "gmail" }
              : type === "github_event"
                ? { type, enabled: true }
                : type === "connector_event"
                  ? { type, enabled: true, connectorId: "github" }
                  : { type: "manual", enabled: true },
  };
}

export function getSlackDeploymentHealth(
  studio: ManagedAgentStudioConfig | undefined,
  slackChannels: ChannelData[],
  agentId = "",
): ManagedAgentSlackDeploymentHealth {
  const healthTargets = (studio?.channelTargets || [])
    .filter((target) => target.channelType === "slack")
    .map((target) => {
      const channel = slackChannels.find((entry) => entry.id === target.channelId);
      const status = channel?.status || "disconnected";
      return {
        channelId: target.channelId,
        channelName: target.channelName || channel?.name || target.channelId,
        status,
        connected: status === "connected" && !channel?.configReadError,
        misconfigured: status !== "connected" || Boolean(channel?.configReadError),
        securityMode: target.securityMode,
        progressRelayMode: target.progressRelayMode,
        configReadError: channel?.configReadError,
      };
    });
  return {
    agentId,
    connectedCount: healthTargets.filter((target) => target.connected).length,
    misconfiguredCount: healthTargets.filter((target) => target.misconfigured).length,
    targets: healthTargets,
    updatedAt: Date.now(),
  };
}

export function normalizeSlackDeploymentHealth(
  health: ManagedAgentSlackDeploymentHealth | null | undefined,
  fallback: ManagedAgentSlackDeploymentHealth,
): ManagedAgentSlackDeploymentHealth {
  if (!health) return fallback;
  const targets = Array.isArray(health.targets) ? health.targets : fallback.targets;
  return {
    ...fallback,
    ...health,
    targets,
    connectedCount:
      typeof health.connectedCount === "number"
        ? health.connectedCount
        : targets.filter((target) => target.connected).length,
    misconfiguredCount:
      typeof health.misconfiguredCount === "number"
        ? health.misconfiguredCount
        : targets.filter((target) => target.misconfigured).length,
    updatedAt: typeof health.updatedAt === "number" ? health.updatedAt : fallback.updatedAt,
  };
}

function getTemplateGlyph(template: AgentTemplate) {
  switch (template.id) {
    case "team-chat-qna":
      return MessageSquare;
    case "morning-planner":
      return CalendarDays;
    case "bug-triage":
      return Bug;
    case "chief-of-staff":
      return Briefcase;
    case "customer-reply-drafter":
      return Send;
    case "research-analyst":
      return Search;
    case "inbox-follow-up-assistant":
      return Inbox;
    default:
      switch (template.category) {
        case "support":
          return MessageSquare;
        case "planning":
          return CalendarDays;
        case "engineering":
          return Bug;
        case "operations":
          return Briefcase;
        case "research":
          return Search;
        case "finance":
          return BarChart3;
        default:
          return Bot;
      }
  }
}

export function AgentsHubPanel({
  onOpenMissionControl,
  onOpenAgentPersonas,
  onOpenSlackSettings,
  onOpenSettings,
  onOpenTask,
}: AgentsHubPanelProps) {
  void onOpenMissionControl;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [agentDetails, setAgentDetails] = useState<Record<string, ManagedAgentVersion | undefined>>(
    {},
  );
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [skills, setSkills] = useState<SkillLite[]>([]);
  const [pluginPacks, setPluginPacks] = useState<PluginPackLite[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [accessProfiles, setAccessProfiles] = useState<AccessProfileDefinition[]>([]);
  const [defaultAccessProfileId, setDefaultAccessProfileId] = useState<AccessProfileId>(
    BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
  );
  const [slackChannels, setSlackChannels] = useState<ChannelData[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<Array<{ id: string; name: string }>>([]);
  const [imageProfiles, setImageProfiles] = useState<ImageGenProfile[]>([]);
  const [studioDraft, setStudioDraft] = useState<AgentDraft | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentRoutines, setAgentRoutines] = useState<Record<string, ManagedAgentRoutineRecord[]>>(
    {},
  );
  const [agentInsights, setAgentInsights] = useState<Record<string, ManagedAgentInsights>>({});
  const [agentAudit, setAgentAudit] = useState<Record<string, ManagedAgentAuditEntry[]>>({});
  const [slackHealth, setSlackHealth] = useState<Record<string, ManagedAgentSlackDeploymentHealth>>(
    {},
  );
  const [sessionWorkpapers, setSessionWorkpapers] = useState<
    Record<string, ManagedSessionWorkpaper>
  >({});
  const [runtimeCatalogs, setRuntimeCatalogs] = useState<
    Record<string, ManagedAgentRuntimeToolCatalog | null | undefined>
  >({});
  const [runtimeCatalogErrors, setRuntimeCatalogErrors] = useState<Record<string, string>>({});
  const [runtimeCatalogLoadingId, setRuntimeCatalogLoadingId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState<AgentsLibraryTab>("all");
  const [workflowComposer, setWorkflowComposer] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDescription, setNewProfileDescription] = useState("");
  const [workspacePermissions, setWorkspacePermissions] = useState<
    Record<string, AgentWorkspacePermissionSnapshot>
  >({});
  const [agentRoles, setAgentRoles] = useState<AgentsHubAgentRole[]>([]);
  const [automationProfiles, setAutomationProfiles] = useState<Any[]>([]);
  const [conversionPanel, setConversionPanel] = useState<ConversionPanel>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showcaseIndex, setShowcaseIndex] = useState(0);
  const [isCreateComposerOpen, setIsCreateComposerOpen] = useState(false);
  const [builderPlan, setBuilderPlan] = useState<AgentBuilderPlan | null>(null);
  const [builderStage, setBuilderStage] = useState<
    "idle" | "thinking" | "plan" | "creating" | "created"
  >("idle");
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [studioTestPrompt, setStudioTestPrompt] = useState("");
  const [studioTestSessionId, setStudioTestSessionId] = useState<string | null>(null);
  const [studioSessionEvents, setStudioSessionEvents] = useState<
    Record<string, ManagedSessionEvent[]>
  >({});
  const [studioTestRunning, setStudioTestRunning] = useState(false);
  const [studioTestError, setStudioTestError] = useState<string | null>(null);
  const [agentRunSubmitting, setAgentRunSubmitting] = useState(false);
  const [agentRunError, setAgentRunError] = useState<string | null>(null);
  const unresolvedBuilderSelections = getUnresolvedBuilderSelectionRequirements(builderPlan);

  const handleConnectionRequirementAction = (connection: AgentBuilderConnectionRequirement) => {
    const targetTab = resolveConnectionSettingsTab(connection);
    if (targetTab === "slack" && onOpenSlackSettings) {
      onOpenSlackSettings();
      return;
    }
    if (onOpenSettings) {
      onOpenSettings(targetTab);
      return;
    }
    const message = `Connect ${connection.label} from Settings or Integrations.`;
    if (isCreateComposerOpen) {
      setBuilderError(message);
    } else {
      setError(message);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const [
        managedAgents,
        managedSessions,
        agentTemplates,
        availableSkills,
        availablePluginPacks,
        availableWorkspaces,
        gatewayChannels,
        imageGenProfiles,
        managedEnvironments,
        permissionSettings,
        mcpSettings,
        legacyAgentRoles,
        legacyAutomationProfiles,
      ] = await Promise.all([
        window.electronAPI.listManagedAgents(),
        window.electronAPI.listManagedSessions({ limit: 40, surface: "runtime" }),
        window.electronAPI.listAgentTemplates(),
        window.electronAPI.listSkills(),
        window.electronAPI.listPluginPacks(),
        window.electronAPI.listWorkspaces(),
        window.electronAPI.getGatewayChannels(),
        window.electronAPI.listImageGenProfiles(),
        window.electronAPI.listManagedEnvironments(),
        window.electronAPI.getPermissionSettings(),
        window.electronAPI.getMCPSettings(),
        window.electronAPI.getAgentRoles(true),
        window.electronAPI.listAutomationProfiles(),
      ]);
      const detailEntries = await Promise.all(
        managedAgents.map(async (agent) => {
          const detail = await window.electronAPI.getManagedAgent(agent.id);
          return [agent.id, detail?.currentVersion] as const;
        }),
      );
      const routineEntries = await Promise.all(
        managedAgents.map(async (agent) => {
          const routines = await window.electronAPI.listManagedAgentRoutines(agent.id);
          return [agent.id, routines] as const;
        }),
      );
      const insightEntries = await Promise.all(
        managedAgents.map(async (agent) => {
          try {
            const insights = await window.electronAPI.getManagedAgentInsights(agent.id);
            return [agent.id, insights] as const;
          } catch {
            return [agent.id, undefined] as const;
          }
        }),
      );
      setAgents(managedAgents);
      setSessions(managedSessions);
      setTemplates(agentTemplates);
      setSkills((availableSkills || []) as SkillLite[]);
      setPluginPacks((availablePluginPacks || []) as PluginPackLite[]);
      setWorkspaces(availableWorkspaces);
      setEnvironments(managedEnvironments);
      setAccessProfiles(
        Array.isArray(permissionSettings?.accessProfiles) ? permissionSettings.accessProfiles : [],
      );
      setDefaultAccessProfileId(
        permissionSettings?.defaultAccessProfileId || BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
      );
      setSlackChannels((gatewayChannels || []).filter((channel) => channel.type === "slack"));
      setImageProfiles(imageGenProfiles);
      setAgentDetails(Object.fromEntries(detailEntries));
      setAgentRoutines(Object.fromEntries(routineEntries));
      setAgentInsights(
        Object.fromEntries(
          insightEntries.filter((entry): entry is readonly [string, ManagedAgentInsights] =>
            Boolean(entry[1]),
          ),
        ),
      );
      setRuntimeCatalogs({});
      setRuntimeCatalogErrors({});
      setRuntimeCatalogLoadingId(null);
      setAgentRoles(legacyAgentRoles || []);
      setAutomationProfiles(legacyAutomationProfiles || []);

      const serversRaw = (mcpSettings as Any)?.servers;
      const serverList: Array<{ id: string; name: string }> = Array.isArray(serversRaw)
        ? (serversRaw as Array<{ id?: string; name?: string }>)
            .map((server) => {
              const id = server.id || server.name || "";
              const name = server.name || server.id || "";
              return { id, name };
            })
            .filter((entry) => entry.id)
        : Object.entries((serversRaw as Record<string, { name?: string }>) || {}).map(
            ([id, server]) => ({ id, name: server?.name || id }),
          );
      setMcpServerIds(serverList);

      if (studioDraft?.agentId) {
        const existing = managedAgents.find((agent) => agent.id === studioDraft.agentId);
        const version = existing
          ? detailEntries.find(([id]) => id === existing.id)?.[1]
          : undefined;
        const routines = existing
          ? routineEntries.find(([id]) => id === existing.id)?.[1] || []
          : [];
        if (existing) {
          setStudioDraft(
            buildDraftFromAgent(
              existing,
              version,
              managedEnvironments,
              availableWorkspaces,
              routines,
            ),
          );
        }
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (
      !selectedAgentId ||
      runtimeCatalogs[selectedAgentId] !== undefined ||
      runtimeCatalogLoadingId === selectedAgentId
    ) {
      return;
    }
    let cancelled = false;
    setRuntimeCatalogLoadingId(selectedAgentId);
    void window.electronAPI
      .getManagedAgentRuntimeToolCatalog(selectedAgentId)
      .then((catalog) => {
        if (cancelled) return;
        setRuntimeCatalogs((current) => ({ ...current, [selectedAgentId]: catalog }));
        setRuntimeCatalogErrors((current) => {
          const next = { ...current };
          delete next[selectedAgentId];
          return next;
        });
      })
      .catch((catalogError) => {
        if (cancelled) return;
        setRuntimeCatalogs((current) => ({ ...current, [selectedAgentId]: null }));
        setRuntimeCatalogErrors((current) => ({
          ...current,
          [selectedAgentId]:
            catalogError instanceof Error ? catalogError.message : "Failed to load runtime tools",
        }));
      })
      .finally(() => {
        if (cancelled) return;
        setRuntimeCatalogLoadingId((current) => (current === selectedAgentId ? null : current));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, runtimeCatalogLoadingId, runtimeCatalogs]);

  useEffect(() => {
    if (!selectedAgentId || agentInsights[selectedAgentId]) return;
    void window.electronAPI
      .getManagedAgentInsights(selectedAgentId)
      .then((insights) =>
        setAgentInsights((current) => ({
          ...current,
          [selectedAgentId]: insights,
        })),
      )
      .catch(() => {});
    void window.electronAPI
      .listManagedAgentAuditEntries(selectedAgentId, 10)
      .then((entries) =>
        setAgentAudit((current) => ({
          ...current,
          [selectedAgentId]: entries,
        })),
      )
      .catch(() => {});
    void window.electronAPI
      .getManagedAgentSlackDeploymentHealth(selectedAgentId)
      .then((health) =>
        setSlackHealth((current) => ({
          ...current,
          [selectedAgentId]: normalizeSlackDeploymentHealth(
            health,
            getSlackDeploymentHealth(
              getStudioConfig(agentDetails[selectedAgentId]),
              slackChannels,
              selectedAgentId,
            ),
          ),
        })),
      )
      .catch(() => {});
  }, [agentInsights, selectedAgentId]);

  useEffect(() => {
    const workspaceId = studioDraft?.workspaceId;
    if (!workspaceId || workspacePermissions[workspaceId]) return;
    void window.electronAPI
      .getMyAgentWorkspacePermissions(workspaceId)
      .then((permissions) =>
        setWorkspacePermissions((current) => ({ ...current, [workspaceId]: permissions })),
      )
      .catch(() => {});
  }, [studioDraft, workspacePermissions]);

  useEffect(() => {
    const sessionId =
      selectedSessionId ||
      sessions.find(
        (session) =>
          session.agentId === selectedAgentId && (session.surface || "runtime") !== "agent_panel",
      )?.id ||
      null;
    if (!sessionId || sessionWorkpapers[sessionId]) return;
    setSelectedSessionId(sessionId);
    void window.electronAPI
      .getManagedSessionWorkpaper(sessionId)
      .then((workpaper) =>
        setSessionWorkpapers((current) => ({ ...current, [sessionId]: workpaper })),
      )
      .catch(() => {});
  }, [selectedAgentId, selectedSessionId, sessionWorkpapers, sessions]);

  useEffect(() => {
    if (!studioTestSessionId) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const [session, events, workpaper] = await Promise.all([
          window.electronAPI.getManagedSession(studioTestSessionId),
          window.electronAPI.listManagedSessionEvents(studioTestSessionId, 120),
          window.electronAPI.getManagedSessionWorkpaper(studioTestSessionId),
        ]);
        if (cancelled) return;
        if (session) {
          setSessions((current) => {
            const next = current.filter((entry) => entry.id !== session.id);
            return [session, ...next].sort((left, right) => right.updatedAt - left.updatedAt);
          });
          setSelectedSessionId(session.id);
        }
        setStudioSessionEvents((current) => ({
          ...current,
          [studioTestSessionId]: events,
        }));
        setSessionWorkpapers((current) => ({
          ...current,
          [studioTestSessionId]: workpaper,
        }));
        const currentSession =
          session || sessions.find((entry) => entry.id === studioTestSessionId);
        if (!currentSession || isTerminalManagedSessionStatus(currentSession.status)) {
          setStudioTestRunning(false);
          return;
        }
        timeoutId = setTimeout(() => {
          void refresh();
        }, 1800);
      } catch {
        if (cancelled) return;
        setStudioTestRunning(false);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [studioTestSessionId, sessions]);

  const recentAgentIds = useMemo(() => {
    const ordered = sessions
      .filter((session) => (session.surface || "runtime") !== "agent_panel")
      .map((session) => session.agentId);
    return Array.from(new Set(ordered));
  }, [sessions]);

  const recentlyUsedAgents = recentAgentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is ManagedAgent => Boolean(agent));
  const scheduledAgents = agents.filter((agent) => {
    const studio = getStudioConfig(agentDetails[agent.id]);
    return !!studio?.scheduleConfig?.enabled;
  });
  const activeMissionControlAgentRoles = useMemo(
    () => getMissionControlActiveAgentRoles(agentRoles),
    [agentRoles],
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null;
  const selectedAgentWorkspaceId = selectedAgent
    ? environments.find(
        (environment) =>
          environment.id === getStudioConfig(agentDetails[selectedAgent.id])?.defaultEnvironmentId,
      )?.config.workspaceId
    : undefined;

  useEffect(() => {
    if (!selectedAgentWorkspaceId || workspacePermissions[selectedAgentWorkspaceId]) return;
    void window.electronAPI
      .getMyAgentWorkspacePermissions(selectedAgentWorkspaceId)
      .then((permissions) =>
        setWorkspacePermissions((current) => ({
          ...current,
          [selectedAgentWorkspaceId]: permissions,
        })),
      )
      .catch(() => {});
  }, [selectedAgentWorkspaceId, workspacePermissions]);
  const libraryAgents = useMemo(() => {
    switch (libraryTab) {
      case "recent":
        return recentlyUsedAgents;
      case "mine":
        return agents;
      case "scheduled":
        return scheduledAgents;
      case "templates":
        return [];
      default:
        return agents;
    }
  }, [agents, libraryTab, recentlyUsedAgents, scheduledAgents]);
  const slackChannelTargetCount = agents.reduce(
    (count, agent) =>
      count + (getStudioConfig(agentDetails[agent.id])?.channelTargets?.length || 0),
    0,
  );
  const visibleLibraryAgents = libraryAgents.slice(0, 6);
  const visibleMissionControlAgentRoles =
    libraryTab === "all"
      ? activeMissionControlAgentRoles.slice(0, Math.max(0, 6 - visibleLibraryAgents.length))
      : [];
  const visibleAgentCount = agents.length + activeMissionControlAgentRoles.length;
  const managedAgentInsights = agents
    .map((agent) => agentInsights[agent.id])
    .filter((insights): insights is ManagedAgentInsights => Boolean(insights));
  const managedAgentInsightsComplete = managedAgentInsights.length === agents.length;
  const managedAgentTotalRuns = managedAgentInsightsComplete
    ? managedAgentInsights.reduce((total, insights) => total + insights.totalRuns, 0)
    : null;

  const featuredTemplates = useMemo(() => {
    const preferred = templates.filter((template) => template.featured);
    return (preferred.length > 0 ? preferred : templates).slice(0, 4);
  }, [templates]);

  const activeShowcaseTemplate =
    featuredTemplates[showcaseIndex] || featuredTemplates[0] || templates[0] || null;
  const showcaseSideTemplates = featuredTemplates
    .filter((_, index) => index !== showcaseIndex)
    .slice(0, 2);
  const quickCreateTemplates = useMemo(
    () =>
      ["team-chat-qna", "morning-planner", "bug-triage"]
        .map((id) => templates.find((template) => template.id === id))
        .filter((template): template is AgentTemplate => Boolean(template)),
    [templates],
  );

  useEffect(() => {
    if (showcaseIndex < featuredTemplates.length) return;
    setShowcaseIndex(0);
  }, [featuredTemplates.length, showcaseIndex]);

  useEffect(() => {
    if (featuredTemplates.length <= 1) return;
    const interval = window.setInterval(() => {
      setShowcaseIndex((current) => (current + 1) % featuredTemplates.length);
    }, 5600);
    return () => window.clearInterval(interval);
  }, [featuredTemplates.length]);

  const toggleSkill = (skillId: string) => {
    if (!studioDraft) return;
    setStudioDraft({
      ...studioDraft,
      selectedSkills: studioDraft.selectedSkills.includes(skillId)
        ? studioDraft.selectedSkills.filter((id) => id !== skillId)
        : [...studioDraft.selectedSkills, skillId],
    });
  };

  const toggleToolFamily = (toolFamily: ManagedAgentToolFamily) => {
    if (!studioDraft) return;
    setStudioDraft({
      ...studioDraft,
      selectedToolFamilies: studioDraft.selectedToolFamilies.includes(toolFamily)
        ? studioDraft.selectedToolFamilies.filter((entry) => entry !== toolFamily)
        : [...studioDraft.selectedToolFamilies, toolFamily],
    });
  };

  const handleSelectFiles = async () => {
    if (!studioDraft) return;
    const selectedFiles = await window.electronAPI.selectFiles();
    if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) return;
    const nextRefs = selectedFiles.map((file) => ({
      id: crypto.randomUUID(),
      path: file.path,
      name: file.name || file.path.split(/[\\/]/).pop() || file.path,
    }));
    setStudioDraft({
      ...studioDraft,
      fileRefs: [...studioDraft.fileRefs, ...nextRefs],
    });
  };

  const handleAddSlackTarget = () => {
    if (!studioDraft || slackChannels.length === 0) return;
    const channel = slackChannels[0];
    setStudioDraft({
      ...studioDraft,
      channelTargets: [
        ...studioDraft.channelTargets,
        {
          id: crypto.randomUUID(),
          channelType: "slack",
          channelId: channel.id,
          channelName: channel.name,
          enabled: true,
          replyMode: "default",
          securityMode: channel.securityMode || "pairing",
          progressRelayMode: "minimal",
        },
      ],
    });
  };

  const handleCreateImageProfile = async () => {
    if (!newProfileName.trim()) return;
    const files = await window.electronAPI.selectFiles();
    const profile = await window.electronAPI.createImageGenProfile({
      name: newProfileName.trim(),
      description: newProfileDescription.trim() || undefined,
      isDefault: imageProfiles.length === 0,
      referencePhotoPaths: files.map((file) => file.path),
    });
    setImageProfiles((current) => [profile, ...current.filter((entry) => entry.id !== profile.id)]);
    setNewProfileName("");
    setNewProfileDescription("");
    if (studioDraft && !studioDraft.imageGenProfileId) {
      setStudioDraft({ ...studioDraft, imageGenProfileId: profile.id });
    }
  };

  const handleDraftFromWorkflow = () => {
    const trimmed = workflowComposer.trim();
    if (!trimmed) return;
    setIsCreateComposerOpen(false);
    const draft = buildDraftFromWorkflowBrief(trimmed, templates, workspaces);
    setStudioDraft(
      draft.executionMode === "team" && !draft.teamTemplate
        ? {
            ...draft,
            teamTemplate: buildTeamTemplateFromRoleNames(draft.teamRoleNames, agentRoles),
          }
        : draft,
    );
  };

  const handleGenerateBuilderPlan = async (promptOverride?: string) => {
    const trimmed = (promptOverride ?? workflowComposer).trim();
    if (!trimmed) return;
    setWorkflowComposer(trimmed);
    setBuilderError(null);
    setBuilderStage("thinking");
    setBuilderPlan(null);
    try {
      const plan = await window.electronAPI.generateManagedAgentPlan({
        prompt: trimmed,
        workspaceId: workspaces[0]?.id,
      });
      setBuilderPlan(plan);
      setBuilderStage("plan");
    } catch (planError) {
      setBuilderError(
        planError instanceof Error ? planError.message : "Failed to generate agent plan",
      );
      setBuilderStage("idle");
    }
  };

  const handleCreateFromBuilderPlan = async () => {
    if (!builderPlan) return;
    setBuilderError(null);
    setBuilderStage("creating");
    try {
      const created = await window.electronAPI.createManagedAgentFromPlan({
        plan: builderPlan,
        workspaceId: workspaces[0]?.id,
        activate: true,
      });
      setSelectedAgentId(created.agent.id);
      await loadData();
      setBuilderStage("created");
      setIsCreateComposerOpen(false);
      setWorkflowComposer("");
      setBuilderPlan(null);
    } catch (createError) {
      setBuilderError(
        createError instanceof Error ? createError.message : "Failed to create agent",
      );
      setBuilderStage("plan");
    }
  };

  const handleEditBuilderPlan = () => {
    if (!builderPlan) return;
    setIsCreateComposerOpen(false);
    setStudioDraft(buildDraftFromBuilderPlan(builderPlan, workspaces));
  };

  const handleOpenCreateComposer = () => {
    setBuilderPlan(null);
    setBuilderStage("idle");
    setBuilderError(null);
    setIsCreateComposerOpen(true);
  };

  const persistStudioDraft = async (): Promise<PersistStudioDraftResult | null> => {
    if (!studioDraft) return null;
    const environmentPayload = {
      name: `${studioDraft.name} Environment`,
      config: {
        workspaceId: studioDraft.workspaceId,
        accessProfileId:
          studioDraft.accessProfileId ||
          defaultAccessProfileId ||
          BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
        enableBrowser: studioDraft.enableBrowser,
        enableComputerUse: studioDraft.enableComputerUse,
        allowedMcpServerIds: studioDraft.selectedMcpServers,
        filePaths: studioDraft.fileRefs.map((file) => file.path),
        allowedToolFamilies: studioDraft.selectedToolFamilies,
      },
    };
    const environment = studioDraft.defaultEnvironmentId
      ? await window.electronAPI.updateManagedEnvironment({
          environmentId: studioDraft.defaultEnvironmentId,
          ...environmentPayload,
        })
      : await window.electronAPI.createManagedEnvironment(environmentPayload);
    if (!environment) throw new Error("Failed to save managed environment");

    const studioMetadata: ManagedAgentStudioConfig = {
      templateId: studioDraft.templateId,
      workflowBrief: studioDraft.workflowBrief,
      appearance: {
        icon: studioDraft.icon,
        color: studioDraft.color,
      },
      subtitle: studioDraft.subtitle,
      instructions: {
        operatingNotes: studioDraft.operatingNotes,
      },
      starterPrompts: studioDraft.starterPrompts,
      builderPlan: studioDraft.builderPlan,
      missingConnections: studioDraft.missingConnections,
      skills: studioDraft.selectedSkills,
      apps: {
        mcpServers: studioDraft.selectedMcpServers,
        allowedToolFamilies: studioDraft.selectedToolFamilies,
      },
      fileRefs: studioDraft.fileRefs,
      memoryConfig: studioDraft.memoryConfig,
      channelTargets: studioDraft.channelTargets,
      scheduleConfig: studioDraft.scheduleConfig,
      audioSummaryConfig: {
        enabled: studioDraft.audioSummaryEnabled,
        style: studioDraft.audioSummaryStyle,
      },
      imageGenProfileId: studioDraft.imageGenProfileId,
      approvalPolicy: studioDraft.approvalPolicy,
      sharing: studioDraft.sharing,
      deployment: studioDraft.deployment,
      defaultEnvironmentId: environment.id,
      requiredPackIds: studioDraft.templateRequiredPackIds,
      requiredConnectorIds: studioDraft.templateRequiredConnectorIds,
      expectedArtifacts: studioDraft.expectedArtifacts,
      teamRoleNames: studioDraft.teamRoleNames,
    };

    let savedAgentId = studioDraft.agentId;
    if (studioDraft.agentId) {
      await window.electronAPI.updateManagedAgent({
        agentId: studioDraft.agentId,
        name: studioDraft.name,
        description: studioDraft.description,
        systemPrompt: studioDraft.systemPrompt,
        executionMode: studioDraft.executionMode,
        teamTemplate: studioDraft.executionMode === "team" ? studioDraft.teamTemplate : undefined,
        skills: studioDraft.selectedSkills,
        mcpServers: studioDraft.selectedMcpServers,
        runtimeDefaults: {
          autonomousMode: true,
          allowUserInput: true,
          webSearchMode: "live",
        },
        metadata: { studio: studioMetadata },
      });
    } else {
      const created = await window.electronAPI.createManagedAgent({
        name: studioDraft.name,
        description: studioDraft.description,
        systemPrompt: studioDraft.systemPrompt,
        executionMode: studioDraft.executionMode,
        teamTemplate: studioDraft.executionMode === "team" ? studioDraft.teamTemplate : undefined,
        skills: studioDraft.selectedSkills,
        mcpServers: studioDraft.selectedMcpServers,
        runtimeDefaults: {
          autonomousMode: true,
          allowUserInput: true,
          webSearchMode: "live",
        },
        metadata: { studio: studioMetadata },
      });
      savedAgentId = created.agent.id;
      setSelectedAgentId(created.agent.id);
    }

    if (savedAgentId) {
      const existingRoutines = agentRoutines[savedAgentId] || [];
      const draftRoutineIds = new Set(
        studioDraft.routines.map((routine) => routine.id).filter((id): id is string => Boolean(id)),
      );
      for (const routine of existingRoutines) {
        if (!draftRoutineIds.has(routine.id)) {
          await window.electronAPI.deleteManagedAgentRoutine(savedAgentId, routine.id);
        }
      }
      for (const routine of studioDraft.routines) {
        const payload = {
          agentId: savedAgentId,
          name: routine.name,
          description: routine.description,
          enabled: routine.enabled,
          trigger: routine.trigger,
        };
        if (routine.id) {
          await window.electronAPI.updateManagedAgentRoutine({
            ...payload,
            routineId: routine.id,
          });
        } else {
          await window.electronAPI.createManagedAgentRoutine(payload);
        }
      }
    }

    if (!savedAgentId) {
      throw new Error("Failed to save managed agent");
    }

    const [detail, refreshedRoutines, refreshedEnvironments, refreshedWorkspaces] =
      await Promise.all([
        window.electronAPI.getManagedAgent(savedAgentId),
        window.electronAPI.listManagedAgentRoutines(savedAgentId),
        window.electronAPI.listManagedEnvironments(),
        window.electronAPI.listWorkspaces(),
      ]);
    const refreshedDraft = buildDraftFromAgent(
      detail?.agent || {
        id: savedAgentId,
        name: studioDraft.name,
        description: studioDraft.description,
        status: studioDraft.status || "draft",
        currentVersion: detail?.agent.currentVersion || 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      detail?.currentVersion,
      refreshedEnvironments,
      refreshedWorkspaces,
      refreshedRoutines,
    );
    setStudioDraft(refreshedDraft);
    await loadData();
    return { agentId: savedAgentId, environmentId: environment.id };
  };

  const handleSaveDraft = async () => {
    if (!studioDraft) return;
    try {
      setSaving(true);
      await persistStudioDraft();
      setStudioDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save agent");
    } finally {
      setSaving(false);
    }
  };

  const handleTestDraft = async () => {
    if (!studioDraft) return;
    const prompt =
      studioTestPrompt.trim() || `Run the configured workflow for ${studioDraft.name}.`;
    try {
      setSaving(true);
      setStudioTestRunning(true);
      setStudioTestError(null);
      const persisted = await persistStudioDraft();
      if (!persisted) throw new Error("Failed to save the agent before testing");
      const session = await window.electronAPI.createManagedSession({
        agentId: persisted.agentId,
        environmentId: persisted.environmentId,
        title: `${studioDraft.name} preview`,
        surface: "studio_preview",
        initialEvent: {
          type: "user.message",
          content: [{ type: "text", text: prompt }],
        },
      });
      setStudioTestSessionId(session.id);
      setSelectedAgentId(persisted.agentId);
      setSelectedSessionId(session.id);
      setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)]);
      const [events, workpaper] = await Promise.all([
        window.electronAPI.listManagedSessionEvents(session.id, 120),
        window.electronAPI.getManagedSessionWorkpaper(session.id),
      ]);
      setStudioSessionEvents((current) => ({ ...current, [session.id]: events }));
      setSessionWorkpapers((current) => ({ ...current, [session.id]: workpaper }));
    } catch (testError) {
      setStudioTestError(testError instanceof Error ? testError.message : "Failed to test agent");
      setStudioTestRunning(false);
    } finally {
      setSaving(false);
    }
  };

  const handleRunAgentInMainTask = async (agent: ManagedAgent, prompt: string, title: string) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;
    if (agent.status === "suspended") {
      setAgentRunError("This agent is suspended. Publish it again before running it.");
      return;
    }

    try {
      setAgentRunSubmitting(true);
      setAgentRunError(null);
      const studio = getStudioConfig(agentDetails[agent.id]);
      const environmentId = studio?.defaultEnvironmentId;
      if (!environmentId) {
        throw new Error(
          "This agent does not have a default environment yet. Edit it and save first.",
        );
      }

      const session = await window.electronAPI.createManagedSession({
        agentId: agent.id,
        environmentId,
        title,
        surface: "runtime",
        initialEvent: {
          type: "user.message",
          content: [{ type: "text", text: trimmedPrompt }],
        },
      });
      setSessions((current) => {
        const next = current.filter((entry) => entry.id !== session.id);
        return [session, ...next].sort((left, right) => right.updatedAt - left.updatedAt);
      });
      setSelectedSessionId(session.id);
      if (session.backingTaskId) {
        onOpenTask?.(session.backingTaskId);
      } else {
        setAgentRunError("The agent run started, but no backing task was returned.");
      }
    } catch (panelError) {
      setAgentRunError(
        panelError instanceof Error ? panelError.message : "Failed to run this agent",
      );
    } finally {
      setAgentRunSubmitting(false);
    }
  };

  const handleConvertAgentRole = async (agentRoleId: string) => {
    try {
      const converted = await window.electronAPI.convertAgentRoleToManagedAgent({ agentRoleId });
      setSelectedAgentId(converted.agent.id);
      setConversionPanel(null);
      await loadData();
    } catch (conversionError) {
      setError(
        conversionError instanceof Error
          ? conversionError.message
          : "Failed to convert agent persona",
      );
    }
  };

  const handleConvertAutomationProfile = async (automationProfileId: string) => {
    try {
      const converted = await window.electronAPI.convertAutomationProfileToManagedAgent({
        automationProfileId,
      });
      setSelectedAgentId(converted.agent.id);
      setConversionPanel(null);
      await loadData();
    } catch (conversionError) {
      setError(
        conversionError instanceof Error
          ? conversionError.message
          : "Failed to convert automation profile",
      );
    }
  };

  const handlePublishAgent = async (agentId: string) => {
    await window.electronAPI.publishManagedAgent(agentId);
    await loadData();
  };

  const handleSuspendAgent = async (agentId: string) => {
    await window.electronAPI.suspendManagedAgent(agentId);
    await loadData();
  };

  if (loading) {
    return <div className="agents-panel-loading">Loading agents...</div>;
  }

  if (studioDraft) {
    const approvalPreview = getEffectiveApprovalPreview(
      studioDraft.approvalPolicy,
      studioDraft.deployment,
    );
    const approvalRuntimeMatrix = getApprovalRuntimeMatrix(studioDraft.approvalPolicy);
    const selectableAccessProfiles = Array.from(
      new Map(
        [...BUILTIN_ACCESS_PROFILES, ...accessProfiles].map((profile) => [profile.id, profile]),
      ).values(),
    );
    const selectedAccessProfileId =
      studioDraft.accessProfileId ||
      defaultAccessProfileId ||
      BUILTIN_ACCESS_PROFILE_IDS.askForApproval;
    const draftPermissions = studioDraft.workspaceId
      ? workspacePermissions[studioDraft.workspaceId]
      : undefined;
    const draftSlackHealth = getSlackDeploymentHealth(
      { channelTargets: studioDraft.channelTargets },
      slackChannels,
      studioDraft.agentId,
    );
    const studioTestSession = studioTestSessionId
      ? sessions.find((session) => session.id === studioTestSessionId) || null
      : null;
    const studioTestTranscript = studioTestSessionId
      ? (studioSessionEvents[studioTestSessionId] || []).filter((event) =>
          ["user.message", "assistant.message", "status.changed", "input.requested"].includes(
            event.type,
          ),
        )
      : [];
    const studioTestWorkpaper = studioTestSessionId
      ? sessionWorkpapers[studioTestSessionId]
      : undefined;
    return (
      <div className="agents-studio">
        <div className="agents-toolbar">
          <button className="agents-link-btn" onClick={() => setStudioDraft(null)}>
            <ChevronLeft size={16} />
            Back to Agents
          </button>
          <button className="agents-primary-btn" onClick={handleSaveDraft} disabled={saving}>
            <Save size={16} />
            {saving ? "Saving..." : "Save Agent"}
          </button>
        </div>
        {draftPermissions ? (
          <div className="agents-inline-permission-note">
            Your workspace role is <strong>{draftPermissions.role}</strong>. Builders can edit
            drafts and environments; publishers can publish and manage triggers.
          </div>
        ) : null}

        <div className="agents-studio-grid">
          <section className="agents-section-card agents-studio-test-surface">
            <div className="agents-section-head">
              <div>
                <h3>Preview & Test</h3>
                <span>Run the agent from the studio before you publish it.</span>
              </div>
              {studioTestSession ? (
                <span>
                  {sessionStatusLabel(studioTestSession)} ·{" "}
                  {formatRelative(studioTestSession.updatedAt)}
                </span>
              ) : (
                <span>Save-once preview from the current draft</span>
              )}
            </div>
            <div className="agents-studio-test-grid">
              <div className="agents-studio-test-chat">
                <div className="agents-studio-test-suggestions">
                  <button
                    type="button"
                    className="agents-link-btn"
                    onClick={() => void handleTestDraft()}
                    disabled={saving || studioTestRunning}
                  >
                    <Play size={16} />
                    Test this agent
                  </button>
                  <button type="button" className="agents-link-btn" disabled>
                    <Wrench size={16} />
                    Add advanced logic
                  </button>
                  <button type="button" className="agents-link-btn" disabled>
                    <Bot size={16} />
                    Optimize this agent
                  </button>
                </div>
                <div className="agents-studio-test-transcript">
                  {studioTestTranscript.length > 0 ? (
                    studioTestTranscript.map((event) => {
                      const isAssistant = event.type === "assistant.message";
                      const isUser = event.type === "user.message";
                      return (
                        <div
                          key={event.id}
                          className={`agents-studio-test-bubble ${
                            isAssistant ? "assistant" : isUser ? "user" : "system"
                          }`}
                        >
                          <span className="agents-studio-test-bubble-role">
                            {isAssistant
                              ? "Agent"
                              : isUser
                                ? "You"
                                : event.type.replace(/\./g, " ")}
                          </span>
                          <p>{getManagedSessionEventText(event)}</p>
                        </div>
                      );
                    })
                  ) : (
                    <div className="agents-studio-test-empty">
                      <strong>Test the current draft</strong>
                      <p>
                        Save the agent and run a prompt here to verify instructions, tools,
                        approvals, and deployment posture before publishing.
                      </p>
                    </div>
                  )}
                </div>
                <div className="agents-studio-test-compose">
                  <textarea
                    rows={3}
                    value={studioTestPrompt}
                    placeholder="Ask the agent to handle a realistic request, for example: Review this software request, check policy, and draft the next step."
                    onChange={(event) => setStudioTestPrompt(event.target.value)}
                  />
                  <button
                    className="agents-primary-btn"
                    onClick={() => void handleTestDraft()}
                    disabled={saving || studioTestRunning}
                  >
                    <Play size={16} />
                    {studioTestRunning ? "Running..." : "Run preview"}
                  </button>
                </div>
                {studioTestError ? (
                  <div className="agents-error-banner">{studioTestError}</div>
                ) : null}
              </div>
              <div className="agents-studio-test-summary">
                <div className="agents-studio-test-summary-card">
                  <span>Channels</span>
                  <strong>
                    {(studioDraft.deployment.surfaces || ["chatgpt"])
                      .map((surface) => (surface === "chatgpt" ? "CoWork OS" : "Slack"))
                      .join(" · ")}
                  </strong>
                  <p>
                    {studioDraft.channelTargets.length > 0
                      ? `${studioDraft.channelTargets.length} Slack deployment target(s) configured.`
                      : "No Slack deployment configured yet."}
                  </p>
                </div>
                <div className="agents-studio-test-summary-card">
                  <span>Tools & skills</span>
                  <strong>
                    {studioDraft.selectedToolFamilies.length} tool families ·{" "}
                    {studioDraft.selectedSkills.length} skills
                  </strong>
                  <p>
                    {studioDraft.selectedToolFamilies.length > 0
                      ? studioDraft.selectedToolFamilies.join(", ")
                      : "No built-in tool families selected yet."}
                  </p>
                </div>
                <div className="agents-studio-test-summary-card">
                  <span>Memory & files</span>
                  <strong>
                    {studioDraft.memoryConfig.mode} memory · {studioDraft.fileRefs.length} files
                  </strong>
                  <p>
                    {studioDraft.fileRefs.length > 0
                      ? studioDraft.fileRefs
                          .map((file) => file.name)
                          .slice(0, 3)
                          .join(", ")
                      : "No reference files attached yet."}
                  </p>
                </div>
                <div className="agents-studio-test-summary-card">
                  <span>Instructions</span>
                  <strong>{studioDraft.name || "Untitled agent"}</strong>
                  <p>{studioDraft.description || studioDraft.workflowBrief || "No summary yet."}</p>
                </div>
                {studioTestWorkpaper ? (
                  <div className="agents-studio-test-workpaper">
                    <strong>Latest preview summary</strong>
                    <p>{studioTestWorkpaper.summary}</p>
                    <span>
                      {studioTestWorkpaper.approvals.length} approvals ·{" "}
                      {studioTestWorkpaper.artifacts.length} artifacts
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="agents-section-card agents-hero-card">
            <div className="agents-studio-badge">Agent Studio</div>
            <h2>Turn a team workflow into a shared operator</h2>
            <p>
              Start from the workflow itself, then shape tools, approvals, deployment surfaces,
              memory, and governance in one place. Mission Control and Agent Personas remain
              available in parallel as legacy ops surfaces.
            </p>
          </section>

          <section className="agents-section-card">
            <h3>Workflow</h3>
            <label>
              <span>What job should this agent handle?</span>
              <textarea
                rows={5}
                value={studioDraft.workflowBrief}
                placeholder="Example: Triage software requests from Slack, check policy, ask for approval for paid tools, and file an IT ticket with next steps."
                onChange={(event) =>
                  setStudioDraft({ ...studioDraft, workflowBrief: event.target.value })
                }
              />
            </label>
          </section>

          <section className="agents-section-card">
            <h3>Identity</h3>
            <div className="agents-field-grid">
              <label>
                <span>Name</span>
                <input
                  value={studioDraft.name}
                  onChange={(event) => setStudioDraft({ ...studioDraft, name: event.target.value })}
                />
              </label>
              <label>
                <span>Icon</span>
                <input
                  value={studioDraft.icon}
                  onChange={(event) => setStudioDraft({ ...studioDraft, icon: event.target.value })}
                />
              </label>
            </div>
            <label>
              <span>Description</span>
              <input
                value={studioDraft.description}
                onChange={(event) =>
                  setStudioDraft({ ...studioDraft, description: event.target.value })
                }
              />
            </label>
          </section>

          <section className="agents-section-card">
            <h3>Instructions</h3>
            <label>
              <span>System prompt</span>
              <textarea
                rows={8}
                value={studioDraft.systemPrompt}
                onChange={(event) =>
                  setStudioDraft({ ...studioDraft, systemPrompt: event.target.value })
                }
              />
            </label>
            <label>
              <span>Operating notes</span>
              <textarea
                rows={4}
                value={studioDraft.operatingNotes}
                onChange={(event) =>
                  setStudioDraft({ ...studioDraft, operatingNotes: event.target.value })
                }
              />
            </label>
          </section>

          <section className="agents-section-card">
            <h3>Skills</h3>
            <div className="agents-chip-grid">
              {skills.slice(0, 24).map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className={`agents-chip ${
                    studioDraft.selectedSkills.includes(skill.id) ? "active" : ""
                  }`}
                  onClick={() => toggleSkill(skill.id)}
                >
                  {skill.name || skill.id}
                </button>
              ))}
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Apps & Tools</h3>
            <label>
              <span>MCP servers</span>
              <div className="agents-chip-grid">
                {mcpServerIds.map((server) => (
                  <button
                    key={server.id}
                    type="button"
                    title={server.id}
                    className={`agents-chip ${
                      studioDraft.selectedMcpServers.includes(server.id) ? "active" : ""
                    }`}
                    onClick={() =>
                      setStudioDraft({
                        ...studioDraft,
                        selectedMcpServers: studioDraft.selectedMcpServers.includes(server.id)
                          ? studioDraft.selectedMcpServers.filter((entry) => entry !== server.id)
                          : [...studioDraft.selectedMcpServers, server.id],
                      })
                    }
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            </label>
            <label>
              <span>Built-in tool families</span>
              <div className="agents-chip-grid">
                {TOOL_FAMILY_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`agents-chip ${
                      studioDraft.selectedToolFamilies.includes(option.id) ? "active" : ""
                    }`}
                    onClick={() => toggleToolFamily(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </label>
          </section>

          <section className="agents-section-card">
            <h3>Files</h3>
            <button className="agents-secondary-btn" onClick={handleSelectFiles}>
              <FileText size={16} />
              Add files
            </button>
            <div className="agents-list">
              {studioDraft.fileRefs.map((file) => (
                <div key={file.id} className="agents-list-row">
                  <span>{file.name}</span>
                  <button
                    className="agents-link-btn"
                    onClick={() =>
                      setStudioDraft({
                        ...studioDraft,
                        fileRefs: studioDraft.fileRefs.filter((entry) => entry.id !== file.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {studioDraft.fileRefs.length === 0 && (
                <span className="agents-empty-note">No files attached yet.</span>
              )}
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Memory</h3>
            <label>
              <span>Memory mode</span>
              <select
                value={studioDraft.memoryConfig.mode}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    memoryConfig: {
                      ...studioDraft.memoryConfig,
                      mode: event.target.value as ManagedAgentMemoryConfig["mode"],
                    },
                  })
                }
              >
                <option value="default">Default</option>
                <option value="focused">Focused</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label>
              <span>Scoped sources (comma separated)</span>
              <input
                value={(studioDraft.memoryConfig.sources || []).join(", ")}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    memoryConfig: {
                      ...studioDraft.memoryConfig,
                      sources: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
          </section>

          <section className="agents-section-card">
            <h3>Triggers & Schedule</h3>
            <div className="agents-chip-grid">
              {[
                ["manual", "Manual"],
                ["schedule", "Schedule"],
                ["api", "API"],
                ["channel_event", "Channel"],
                ["mailbox_event", "Mailbox"],
                ["github_event", "GitHub"],
                ["connector_event", "Connector"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="agents-chip"
                  onClick={() =>
                    setStudioDraft({
                      ...studioDraft,
                      routines: [
                        ...studioDraft.routines,
                        makeBlankRoutine(id as ManagedAgentRoutineTriggerConfig["type"]),
                      ],
                    })
                  }
                >
                  Add {label}
                </button>
              ))}
            </div>
            <div className="agents-list">
              {studioDraft.routines.map((routine, index) => (
                <div
                  key={routine.id || `${routine.trigger.type}-${index}`}
                  className="agents-routine-card"
                >
                  <div className="agents-field-grid">
                    <label>
                      <span>Name</span>
                      <input
                        value={routine.name}
                        onChange={(event) =>
                          setStudioDraft({
                            ...studioDraft,
                            routines: studioDraft.routines.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, name: event.target.value } : entry,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Trigger type</span>
                      <select
                        value={routine.trigger.type}
                        onChange={(event) =>
                          setStudioDraft({
                            ...studioDraft,
                            routines: studioDraft.routines.map((entry, entryIndex) =>
                              entryIndex === index
                                ? {
                                    ...makeBlankRoutine(
                                      event.target
                                        .value as ManagedAgentRoutineTriggerConfig["type"],
                                    ),
                                    id: entry.id,
                                    name: entry.name,
                                  }
                                : entry,
                            ),
                          })
                        }
                      >
                        <option value="manual">Manual</option>
                        <option value="schedule">Schedule</option>
                        <option value="api">API</option>
                        <option value="channel_event">Channel event</option>
                        <option value="mailbox_event">Mailbox event</option>
                        <option value="github_event">GitHub event</option>
                        <option value="connector_event">Connector event</option>
                      </select>
                    </label>
                  </div>
                  <div className="agents-field-grid">
                    {routine.trigger.type === "schedule" ? (
                      <label>
                        <span>Cadence minutes</span>
                        <input
                          type="number"
                          min={15}
                          value={routine.trigger.cadenceMinutes || 60}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: {
                                        ...entry.trigger,
                                        cadenceMinutes: Number(event.target.value) || 60,
                                      },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    {routine.trigger.type === "api" ? (
                      <label>
                        <span>Path</span>
                        <input
                          value={routine.trigger.path || ""}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: { ...entry.trigger, path: event.target.value },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    {routine.trigger.type === "channel_event" ? (
                      <label>
                        <span>Channel type</span>
                        <select
                          value={routine.trigger.channelType || "slack"}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: {
                                        ...entry.trigger,
                                        channelType: event.target.value,
                                      },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        >
                          <option value="slack">Slack</option>
                          <option value="discord">Discord</option>
                        </select>
                      </label>
                    ) : null}
                    {routine.trigger.type === "mailbox_event" ? (
                      <label>
                        <span>Provider</span>
                        <input
                          value={routine.trigger.provider || ""}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: { ...entry.trigger, provider: event.target.value },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    {routine.trigger.type === "github_event" ? (
                      <label>
                        <span>Repository</span>
                        <input
                          value={routine.trigger.repository || ""}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: { ...entry.trigger, repository: event.target.value },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    {routine.trigger.type === "connector_event" ? (
                      <label>
                        <span>Connector</span>
                        <input
                          value={routine.trigger.connectorId || ""}
                          onChange={(event) =>
                            setStudioDraft({
                              ...studioDraft,
                              routines: studioDraft.routines.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      trigger: {
                                        ...entry.trigger,
                                        connectorId: event.target.value,
                                      },
                                    }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                  <div className="agents-row-actions">
                    <label className="agents-checkbox">
                      <input
                        type="checkbox"
                        checked={routine.enabled}
                        onChange={(event) =>
                          setStudioDraft({
                            ...studioDraft,
                            routines: studioDraft.routines.map((entry, entryIndex) =>
                              entryIndex === index
                                ? {
                                    ...entry,
                                    enabled: event.target.checked,
                                    trigger: { ...entry.trigger, enabled: event.target.checked },
                                  }
                                : entry,
                            ),
                          })
                        }
                      />
                      <span>Enabled</span>
                    </label>
                    <button
                      className="agents-link-btn"
                      onClick={() =>
                        setStudioDraft({
                          ...studioDraft,
                          routines: studioDraft.routines.filter(
                            (_, entryIndex) => entryIndex !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Deploy</h3>
            <div className="agents-chip-grid">
              {[
                { id: "chatgpt", label: "CoWork OS" },
                { id: "slack", label: "Slack" },
              ].map((surface) => (
                <button
                  key={surface.id}
                  type="button"
                  className={`agents-chip ${
                    (studioDraft.deployment.surfaces || []).includes(
                      surface.id as "chatgpt" | "slack",
                    )
                      ? "active"
                      : ""
                  }`}
                  onClick={() =>
                    setStudioDraft({
                      ...studioDraft,
                      deployment: {
                        surfaces: (studioDraft.deployment.surfaces || []).includes(
                          surface.id as "chatgpt" | "slack",
                        )
                          ? (studioDraft.deployment.surfaces || []).filter(
                              (entry) => entry !== surface.id,
                            )
                          : [
                              ...(studioDraft.deployment.surfaces || []),
                              surface.id as "chatgpt" | "slack",
                            ],
                      },
                    })
                  }
                >
                  {surface.label}
                </button>
              ))}
            </div>
            <button className="agents-secondary-btn" onClick={handleAddSlackTarget}>
              <Slack size={16} />
              Add Slack deployment
            </button>
            <div className="agents-list">
              {studioDraft.channelTargets.map((target) => (
                <div key={target.id} className="agents-slack-target">
                  <select
                    value={target.channelId}
                    onChange={(event) =>
                      setStudioDraft({
                        ...studioDraft,
                        channelTargets: studioDraft.channelTargets.map((entry) =>
                          entry.id === target.id
                            ? {
                                ...entry,
                                channelId: event.target.value,
                                channelName:
                                  slackChannels.find((channel) => channel.id === event.target.value)
                                    ?.name || event.target.value,
                              }
                            : entry,
                        ),
                      })
                    }
                  >
                    {slackChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={target.securityMode || "pairing"}
                    onChange={(event) =>
                      setStudioDraft({
                        ...studioDraft,
                        channelTargets: studioDraft.channelTargets.map((entry) =>
                          entry.id === target.id
                            ? { ...entry, securityMode: event.target.value as SecurityMode }
                            : entry,
                        ),
                      })
                    }
                  >
                    <option value="pairing">Pairing</option>
                    <option value="allowlist">Allowlist</option>
                    <option value="open">Open</option>
                  </select>
                  <select
                    value={target.progressRelayMode || "minimal"}
                    onChange={(event) =>
                      setStudioDraft({
                        ...studioDraft,
                        channelTargets: studioDraft.channelTargets.map((entry) =>
                          entry.id === target.id
                            ? {
                                ...entry,
                                progressRelayMode: event.target.value as "minimal" | "curated",
                              }
                            : entry,
                        ),
                      })
                    }
                  >
                    <option value="minimal">Minimal</option>
                    <option value="curated">Curated</option>
                  </select>
                  <button
                    className="agents-link-btn"
                    onClick={() =>
                      setStudioDraft({
                        ...studioDraft,
                        channelTargets: studioDraft.channelTargets.filter(
                          (entry) => entry.id !== target.id,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {studioDraft.channelTargets.length === 0 && (
                <span className="agents-empty-note">
                  No Slack deployment configured. Add a workspace/channel to publish replies and
                  progress where work already happens.
                </span>
              )}
            </div>
            <div className="agents-inline-permission-note">
              Slack health: {draftSlackHealth.connectedCount} connected,{" "}
              {draftSlackHealth.misconfiguredCount} misconfigured. Use Slack settings for advanced
              connection tests and channel diagnostics.
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Approvals</h3>
            <label className="agents-checkbox">
              <input
                type="checkbox"
                checked={studioDraft.approvalPolicy.autoApproveReadOnly !== false}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    approvalPolicy: {
                      ...studioDraft.approvalPolicy,
                      autoApproveReadOnly: event.target.checked,
                    },
                  })
                }
              />
              <span>Auto-approve read-only and search actions</span>
            </label>
            <div className="agents-chip-grid">
              {APPROVAL_ACTION_OPTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`agents-chip ${
                    (studioDraft.approvalPolicy.requireApprovalFor || []).includes(action)
                      ? "active"
                      : ""
                  }`}
                  onClick={() =>
                    setStudioDraft({
                      ...studioDraft,
                      approvalPolicy: {
                        ...studioDraft.approvalPolicy,
                        requireApprovalFor: (
                          studioDraft.approvalPolicy.requireApprovalFor || []
                        ).includes(action)
                          ? (studioDraft.approvalPolicy.requireApprovalFor || []).filter(
                              (entry) => entry !== action,
                            )
                          : [...(studioDraft.approvalPolicy.requireApprovalFor || []), action],
                      },
                    })
                  }
                >
                  {action}
                </button>
              ))}
            </div>
            <label>
              <span>Escalation channel or owner</span>
              <input
                value={studioDraft.approvalPolicy.escalationChannel || ""}
                placeholder="e.g. #ops-approvals or Finance lead"
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    approvalPolicy: {
                      ...studioDraft.approvalPolicy,
                      escalationChannel: event.target.value || undefined,
                    },
                  })
                }
              />
            </label>
            <div className="agents-approval-preview">
              <div className="agents-approval-preview-card">
                <strong>Effective posture</strong>
                <p>{approvalPreview.sharedSummary}</p>
                <div className="agents-approval-columns">
                  <div>
                    <span>Auto-approved</span>
                    <ul>
                      {approvalPreview.autoApproved.length > 0 ? (
                        approvalPreview.autoApproved.map((item) => <li key={item}>{item}</li>)
                      ) : (
                        <li>Nothing auto-approves by policy</li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <span>Approval-gated</span>
                    <ul>
                      {approvalPreview.gatedActions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
              <div className="agents-approval-preview-card agents-approval-matrix-card">
                <strong>Runtime approval mapping</strong>
                <div className="agents-approval-matrix">
                  <div className="agents-approval-matrix-header">
                    <div className="agents-approval-matrix-head">Action</div>
                    <div className="agents-approval-matrix-head">Runtime class</div>
                    <div className="agents-approval-matrix-head">Behavior</div>
                  </div>
                  {approvalRuntimeMatrix.map((row) => (
                    <div key={row.semanticAction} className="agents-approval-matrix-row">
                      <div className="agents-approval-matrix-cell">
                        <span className="agents-approval-matrix-label">Action</span>
                        <span>{row.semanticAction}</span>
                      </div>
                      <div className="agents-approval-matrix-cell">
                        <span className="agents-approval-matrix-label">Runtime class</span>
                        <code className="agents-approval-runtime-code">{row.runtimeType}</code>
                      </div>
                      <div
                        className={`agents-approval-matrix-cell ${
                          row.behavior === "require_approval" ? "danger" : "safe"
                        }`}
                      >
                        <span className="agents-approval-matrix-label">Behavior</span>
                        <span
                          className={`agents-approval-behavior-pill ${
                            row.behavior === "require_approval" ? "danger" : "safe"
                          }`}
                        >
                          {row.behavior === "require_approval"
                            ? "Requires approval"
                            : "Auto-approves"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Sharing & Governance</h3>
            <label>
              <span>Visibility</span>
              <select
                value={studioDraft.sharing.visibility || "team"}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    sharing: {
                      ...studioDraft.sharing,
                      visibility: event.target.value as ManagedAgentSharingConfig["visibility"],
                    },
                  })
                }
              >
                <option value="private">Private draft</option>
                <option value="team">Shared with team</option>
                <option value="workspace">Workspace directory</option>
              </select>
            </label>
            <label>
              <span>Owner label</span>
              <input
                value={studioDraft.sharing.ownerLabel || ""}
                placeholder="Revenue Ops, Engineering, Founder Office..."
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    sharing: {
                      ...studioDraft.sharing,
                      ownerLabel: event.target.value || undefined,
                    },
                  })
                }
              />
            </label>
            <div className="agents-surface-preview-grid">
              <div className="agents-surface-preview-card">
                <strong>CoWork OS behavior</strong>
                <p>{approvalPreview.chatgptSummary}</p>
              </div>
              <div className="agents-surface-preview-card">
                <strong>Slack behavior</strong>
                <p>{approvalPreview.slackSummary}</p>
              </div>
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Audio Summary</h3>
            <label className="agents-checkbox">
              <input
                type="checkbox"
                checked={studioDraft.audioSummaryEnabled}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    audioSummaryEnabled: event.target.checked,
                  })
                }
              />
              <span>Enable audio summaries</span>
            </label>
            <label>
              <span>Style</span>
              <select
                value={studioDraft.audioSummaryStyle}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    audioSummaryStyle: event.target.value as AgentDraft["audioSummaryStyle"],
                  })
                }
              >
                <option value="public-radio">Public-radio recap</option>
                <option value="executive-briefing">Executive briefing</option>
                <option value="study-guide">Study guide</option>
              </select>
            </label>
          </section>

          <section className="agents-section-card">
            <h3>ImageGen likeness</h3>
            <div className="agents-field-grid">
              <label>
                <span>Reference profile</span>
                <select
                  value={studioDraft.imageGenProfileId || ""}
                  onChange={(event) =>
                    setStudioDraft({
                      ...studioDraft,
                      imageGenProfileId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">None</option>
                  {imageProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.isDefault ? " (Default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="agents-inline-create">
              <input
                placeholder="New profile name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
              />
              <input
                placeholder="Description"
                value={newProfileDescription}
                onChange={(event) => setNewProfileDescription(event.target.value)}
              />
              <button className="agents-secondary-btn" onClick={handleCreateImageProfile}>
                <ImageIcon size={16} />
                Add profile
              </button>
            </div>
          </section>

          <section className="agents-section-card">
            <h3>Runtime</h3>
            <label>
              <span>Workspace</span>
              <select
                value={studioDraft.workspaceId}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    workspaceId: event.target.value,
                  })
                }
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Access profile</span>
              <select
                value={selectedAccessProfileId}
                onChange={(event) =>
                  setStudioDraft({
                    ...studioDraft,
                    accessProfileId: event.target.value as AccessProfileId,
                  })
                }
              >
                {selectableAccessProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label || getAccessProfileLabel(profile.id)}
                  </option>
                ))}
              </select>
              <small className="agents-inline-permission-note">
                Command tools, filesystem access, network access, and approvals follow this profile.
              </small>
            </label>
            <div className="agents-checkbox-row">
              <label className="agents-checkbox">
                <input
                  type="checkbox"
                  checked={studioDraft.enableBrowser}
                  onChange={(event) =>
                    setStudioDraft({ ...studioDraft, enableBrowser: event.target.checked })
                  }
                />
                <span>Browser</span>
              </label>
              <label className="agents-checkbox">
                <input
                  type="checkbox"
                  checked={studioDraft.enableComputerUse}
                  onChange={(event) =>
                    setStudioDraft({ ...studioDraft, enableComputerUse: event.target.checked })
                  }
                />
                <span>Computer Use</span>
              </label>
            </div>
          </section>
        </div>
        {renderAgentsStyles()}
      </div>
    );
  }

  if (isCreateComposerOpen) {
    return (
      <div className="agents-panel agents-create-screen">
        <div className="agents-create-screen-bar">
          <button
            className="agents-link-btn agents-create-screen-back"
            onClick={() => setIsCreateComposerOpen(false)}
          >
            <ArrowLeft size={18} />
            Back
          </button>
          <div className="agents-create-screen-actions">
            <button
              className="agents-link-btn agents-create-screen-blank"
              onClick={() => {
                setIsCreateComposerOpen(false);
                setStudioDraft(makeBlankDraft(workspaces));
              }}
            >
              Start blank
            </button>
            <button
              className="agents-link-btn agents-create-screen-blank"
              onClick={() => {
                if (workflowComposer.trim()) {
                  handleDraftFromWorkflow();
                } else {
                  setIsCreateComposerOpen(false);
                  setStudioDraft(makeBlankDraft(workspaces));
                }
              }}
            >
              Skip to builder
            </button>
          </div>
        </div>

        <section className="agents-create-screen-hero">
          <div className="agents-create-screen-icon">
            <Sparkles size={34} />
          </div>
          <h1>What should your agent do?</h1>
          <div className="agents-create-screen-input">
            <div className="agents-create-screen-input-leading">
              <Plus size={18} />
            </div>
            <input
              value={workflowComposer}
              placeholder="Describe what it should do"
              onChange={(event) => setWorkflowComposer(event.target.value)}
              disabled={builderStage === "thinking" || builderStage === "creating"}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleGenerateBuilderPlan();
                }
              }}
            />
            <button
              className="agents-create-screen-submit"
              onClick={() => void handleGenerateBuilderPlan()}
              disabled={
                !workflowComposer.trim() ||
                builderStage === "thinking" ||
                builderStage === "creating"
              }
              aria-label="Generate agent plan"
            >
              <ArrowUp size={18} />
            </button>
          </div>

          {builderError ? <p className="agents-create-screen-error">{builderError}</p> : null}

          {builderStage === "thinking" || builderStage === "creating" ? (
            <div className="agents-builder-progress-card">
              <div className="agents-builder-progress-heading">
                <Sparkles size={20} />
                <strong>
                  {builderStage === "creating" ? "Creating your agent" : "Designing your agent"}
                </strong>
              </div>
              {[
                "Reading the request",
                "Checking available tools, skills, and integrations",
                "Choosing approval and privacy defaults",
                builderStage === "creating"
                  ? "Saving the runnable agent"
                  : "Preparing the build plan",
              ].map((step, index) => (
                <div key={step} className="agents-builder-progress-row">
                  {builderStage === "creating" || index < 3 ? (
                    <CheckCircle2 size={17} />
                  ) : (
                    <Circle size={17} />
                  )}
                  <span>{step}</span>
                </div>
              ))}
            </div>
          ) : null}

          {builderPlan && builderStage === "plan" ? (
            <div className="agents-builder-plan-card">
              <div className="agents-builder-plan-header">
                <div
                  className="agents-builder-plan-icon"
                  style={{ color: builderPlan.color || "#1570ef" }}
                >
                  <Bot size={28} />
                </div>
                <div>
                  <span>{builderPlan.subtitle || "Private in CoWork OS"}</span>
                  <h2>{builderPlan.name}</h2>
                  <p>{builderPlan.description}</p>
                </div>
              </div>

              <div className="agents-builder-plan-pills">
                {builderPlan.selectedToolFamilies.slice(0, 8).map((family) => (
                  <span key={family}>
                    {TOOL_FAMILY_OPTIONS.find((option) => option.id === family)?.label || family}
                  </span>
                ))}
                {builderPlan.selectedMcpServers.map((serverId) => (
                  <span key={serverId}>Connected: {serverId}</span>
                ))}
              </div>

              <div className="agents-builder-plan-grid">
                <section>
                  <h3>Capabilities</h3>
                  {builderPlan.capabilities.slice(0, 5).map((capability) => (
                    <div key={capability} className="agents-builder-plan-check">
                      <CheckCircle2 size={16} />
                      <span>{capability}</span>
                    </div>
                  ))}
                </section>
                <section>
                  <h3>Approval defaults</h3>
                  <div className="agents-builder-plan-check">
                    <ShieldCheck size={16} />
                    <span>Read-only and search work auto-approved</span>
                  </div>
                  <div className="agents-builder-plan-check">
                    <ShieldCheck size={16} />
                    <span>Write actions ask before running</span>
                  </div>
                  {builderPlan.scheduleSuggestion ? (
                    <div className="agents-builder-plan-check">
                      <CalendarDays size={16} />
                      <span>{builderPlan.scheduleSuggestion}</span>
                    </div>
                  ) : null}
                </section>
              </div>

              {builderPlan.selectionRequirements?.length > 0 ? (
                <section className="agents-builder-choice-list">
                  <h3>Choose before creating</h3>
                  {builderPlan.selectionRequirements.map((requirement) => (
                    <div key={requirement.id} className="agents-builder-choice-group">
                      <div>
                        <strong>{requirement.title}</strong>
                        <span>{requirement.reason}</span>
                      </div>
                      <div className="agents-builder-choice-options">
                        {requirement.options.map((option) => (
                          <button
                            key={option.id}
                            className={requirement.selectedOptionId === option.id ? "active" : ""}
                            onClick={() =>
                              setBuilderPlan(
                                applyBuilderSelectionRequirement(
                                  builderPlan,
                                  requirement.id,
                                  option.id,
                                ),
                              )
                            }
                          >
                            <strong>{option.label}</strong>
                            {option.description ? <span>{option.description}</span> : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ) : null}

              {builderPlan.missingConnections.length > 0 ? (
                <section className="agents-builder-connect-list">
                  <h3>Connect next</h3>
                  {builderPlan.missingConnections.map((connection) => (
                    <div
                      key={`${connection.kind}:${connection.id}`}
                      className="agents-builder-connect-row"
                    >
                      <div>
                        <strong>{connection.label}</strong>
                        <span>{connection.reason}</span>
                      </div>
                      <button onClick={() => handleConnectionRequirementAction(connection)}>
                        {connection.connectAction?.label || "Connect"}
                      </button>
                    </div>
                  ))}
                </section>
              ) : null}

              <section className="agents-builder-starters">
                <h3>Starter prompts</h3>
                <div>
                  {builderPlan.starterPrompts.slice(0, 3).map((starter) => (
                    <button key={starter.id}>{starter.title}</button>
                  ))}
                </div>
              </section>

              <div className="agents-builder-plan-actions">
                <button className="agents-secondary-btn" onClick={handleEditBuilderPlan}>
                  Edit plan
                </button>
                <button
                  className="agents-primary-btn"
                  onClick={() => void handleCreateFromBuilderPlan()}
                  disabled={unresolvedBuilderSelections.length > 0}
                >
                  Create
                </button>
              </div>
              {unresolvedBuilderSelections.length > 0 ? (
                <p className="agents-builder-plan-blocked">
                  {unresolvedBuilderSelections[0]?.title || "Choose an option"} before creating.
                </p>
              ) : null}
            </div>
          ) : null}

          {builderStage === "idle" ? (
            <div className="agents-create-screen-suggestions">
              {quickCreateTemplates.map((template) => {
                const TemplateGlyph = getTemplateGlyph(template);
                return (
                  <button
                    key={template.id}
                    className="agents-create-screen-row"
                    onClick={() => void handleGenerateBuilderPlan(template.description)}
                  >
                    <span className="agents-create-screen-row-icon">
                      <TemplateGlyph size={18} />
                    </span>
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
        {renderAgentsStyles()}
      </div>
    );
  }

  if (selectedAgent) {
    const version = agentDetails[selectedAgent.id];
    const studio = getStudioConfig(version);
    const linkedRoutines = agentRoutines[selectedAgent.id] || [];
    const permissions = selectedAgentWorkspaceId
      ? workspacePermissions[selectedAgentWorkspaceId]
      : undefined;
    const latestAgentSession =
      sessions.find(
        (session) =>
          session.agentId === selectedAgent.id && (session.surface || "runtime") === "runtime",
      ) || null;
    const templateRecord = studio?.templateId
      ? templates.find((entry) => entry.id === studio.templateId) || {
          id: studio.templateId,
          name: studio.templateId,
          description: "",
          icon: "",
          color: "#1570ef",
          category: "operations",
          systemPrompt: "",
          executionMode: "solo",
        }
      : null;
    const AgentGlyph = templateRecord ? getTemplateGlyph(templateRecord) : Bot;
    const customIcon = studio?.appearance?.icon;
    const customColor = studio?.appearance?.color || templateRecord?.color || "#1570ef";
    const starterPrompts = studio?.starterPrompts || [];
    const selectedSkillLabels = (studio?.skills || version?.skills || [])
      .map((skillId) => skills.find((skill) => skill.id === skillId)?.name || skillId)
      .slice(0, 4);
    const runtimeCatalog = runtimeCatalogs[selectedAgent.id];
    const runtimeCatalogError = runtimeCatalogErrors[selectedAgent.id];
    const missingConnectionMap = new Map(
      [...(studio?.missingConnections || []), ...(runtimeCatalog?.missingConnections || [])].map(
        (connection) => [`${connection.kind}:${connection.id}`, connection],
      ),
    );
    const missingConnections = Array.from(missingConnectionMap.values());
    const runtimeToolLabels = sortRuntimeToolCatalogEntries(runtimeCatalog?.chatgpt || [])
      .slice(0, 5)
      .map((tool) => ({
        key: `runtime:${tool.name}`,
        label: tool.name,
      }));
    const toolLabels = runtimeCatalogError || runtimeCatalog === undefined ? [] : runtimeToolLabels;
    const toolStatusNote = runtimeCatalogError
      ? runtimeCatalogError
      : runtimeCatalog === undefined
        ? "Loading real runtime tools..."
        : runtimeToolLabels.length === 0
          ? "No runtime tools available."
          : null;
    const deploymentHealth = normalizeSlackDeploymentHealth(
      slackHealth[selectedAgent.id],
      getSlackDeploymentHealth(studio, slackChannels, selectedAgent.id),
    );
    const slackTargets = deploymentHealth.targets;
    const auditEntries = agentAudit[selectedAgent.id] || [];
    const fileRefs = studio?.fileRefs || [];
    const memoryMode = studio?.memoryConfig?.mode;
    const instructionParagraphs =
      version?.systemPrompt
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean) || [];
    const runAgentPrompt = `Run the configured workflow for ${selectedAgent.name}.`;
    const canRunSelectedAgent =
      selectedAgent.status !== "suspended" && !(permissions ? !permissions.canRunAgents : false);
    const canEditSelectedAgent = !(permissions ? !permissions.canEditDrafts : false);
    const openSelectedAgentDraft = () =>
      setStudioDraft(
        buildDraftFromAgent(
          selectedAgent,
          agentDetails[selectedAgent.id],
          environments,
          workspaces,
          linkedRoutines,
        ),
      );

    return (
      <div className="agents-panel agents-agent-detail-screen">
        <main className="agents-agent-editor">
          <div className="agents-agent-editor-bar">
            <button className="agents-agent-back" onClick={() => setSelectedAgentId(null)}>
              <ArrowLeft size={18} />
              Agents
            </button>
            <div className="agents-agent-editor-bar-actions">
              <span>
                {latestAgentSession
                  ? `Updated ${formatRelative(latestAgentSession.updatedAt)}`
                  : "No runs recorded"}
              </span>
              <button>
                <CalendarDays size={16} />
                Schedule
              </button>
              <button
                onClick={() => void handlePublishAgent(selectedAgent.id)}
                disabled={
                  selectedAgent.status === "active" ||
                  (permissions ? !permissions.canPublishAgents : false)
                }
              >
                Publish
              </button>
              <button
                onClick={() => void handleSuspendAgent(selectedAgent.id)}
                disabled={
                  selectedAgent.status === "suspended" ||
                  (permissions ? !permissions.canPublishAgents : false)
                }
              >
                Suspend
              </button>
              <button
                onClick={() =>
                  void handleRunAgentInMainTask(
                    selectedAgent,
                    runAgentPrompt,
                    `${selectedAgent.name} preview`,
                  )
                }
                disabled={!canRunSelectedAgent || agentRunSubmitting}
              >
                <Play size={16} />
                Preview
              </button>
              <button aria-label="More agent actions">
                <MoreHorizontal size={18} />
              </button>
            </div>
          </div>

          <section className="agents-agent-profile">
            <div className="agents-agent-avatar" style={{ color: customColor }}>
              {customIcon && customIcon !== "Bot" && customIcon.length <= 4 ? (
                <span>{customIcon}</span>
              ) : (
                <AgentGlyph size={34} />
              )}
            </div>
            <h1>{selectedAgent.name}</h1>
            {studio?.subtitle ? <p>{studio.subtitle}</p> : null}
          </section>

          <section className="agents-agent-action-strip" aria-label="Agent actions">
            <h2>Actions</h2>
            <div className="agents-agent-action-buttons">
              <button
                className="agents-agent-action-button primary"
                onClick={() =>
                  void handleRunAgentInMainTask(
                    selectedAgent,
                    runAgentPrompt,
                    `${selectedAgent.name} agent test`,
                  )
                }
                disabled={!canRunSelectedAgent || agentRunSubmitting}
              >
                <Play size={16} />
                Test this agent
              </button>
              <button
                className="agents-agent-action-button"
                onClick={openSelectedAgentDraft}
                disabled={!canEditSelectedAgent}
              >
                <Library size={16} />
                Add advanced logic
              </button>
              <button
                className="agents-agent-action-button"
                onClick={openSelectedAgentDraft}
                disabled={!canEditSelectedAgent}
              >
                <Wrench size={16} />
                Optimize this agent
              </button>
            </div>
            {agentRunError ? <p className="agents-agent-action-error">{agentRunError}</p> : null}
          </section>

          <section className="agents-agent-section">
            <h2>Channels</h2>
            <div className="agents-agent-channel-grid">
              <button className="agents-agent-channel-card">
                <MessageSquare size={20} />
                <strong>CoWork OS</strong>
                <span>Customize and share your agent</span>
              </button>
              {(studio?.deployment?.surfaces || []).includes("slack") && slackTargets[0] ? (
                <button className="agents-agent-channel-card">
                  <Slack size={20} />
                  <strong>{slackTargets[0].channelName}</strong>
                  <span>
                    {slackTargets[0].misconfigured ? "Needs attention" : "Responds to messages"}
                  </span>
                </button>
              ) : (
                <button className="agents-agent-channel-card">
                  <Slack size={20} />
                  <strong>Slack</strong>
                  <span>
                    {(studio?.deployment?.surfaces || []).includes("slack")
                      ? "No channel selected"
                      : "Deployment off"}
                  </span>
                </button>
              )}
              <button className="agents-agent-channel-card">
                <Plus size={20} />
                <strong>Add channel</strong>
                <span>Use your agent in Slack</span>
              </button>
            </div>
          </section>

          {starterPrompts.length > 0 ? (
            <section className="agents-agent-section">
              <h2>Starter prompts</h2>
              <div className="agents-agent-starter-grid">
                {starterPrompts.slice(0, 4).map((starter) => (
                  <button
                    key={starter.id}
                    className="agents-agent-starter-card"
                    onClick={() =>
                      void handleRunAgentInMainTask(
                        selectedAgent,
                        starter.prompt,
                        `${selectedAgent.name} prompt: ${starter.title}`,
                      )
                    }
                    disabled={!canRunSelectedAgent || agentRunSubmitting}
                  >
                    <strong>{starter.title}</strong>
                    <span>{starter.description || starter.prompt}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {missingConnections.length > 0 ? (
            <section className="agents-agent-section">
              <h2>Connect next</h2>
              <div className="agents-agent-connect-list">
                {missingConnections.map((connection) => (
                  <div
                    key={`${connection.kind}:${connection.id}`}
                    className="agents-agent-connect-row"
                  >
                    <div>
                      <strong>{connection.label}</strong>
                      <span>{connection.reason}</span>
                    </div>
                    <button onClick={() => handleConnectionRequirementAction(connection)}>
                      {connection.connectAction?.label || "Connect"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="agents-agent-resource-list">
            <div className="agents-agent-resource-row">
              <span>Tools</span>
              <div>
                {toolLabels.length > 0
                  ? toolLabels.map((tool) => (
                      <button key={tool.key} className="agents-agent-pill">
                        <Wrench size={15} />
                        {tool.label}
                      </button>
                    ))
                  : null}
                <button className="agents-agent-add">
                  <Plus size={15} />
                  Add tool
                </button>
                {toolStatusNote ? (
                  <span className="agents-agent-inline-note">{toolStatusNote}</span>
                ) : null}
              </div>
            </div>
            <div className="agents-agent-resource-row">
              <span>Skills</span>
              <div>
                {selectedSkillLabels.length > 0 ? (
                  selectedSkillLabels.map((skill) => (
                    <button key={skill} className="agents-agent-pill">
                      <Briefcase size={15} />
                      {skill}
                    </button>
                  ))
                ) : (
                  <button className="agents-agent-pill muted">No skills selected</button>
                )}
                <button className="agents-agent-add">
                  <Plus size={15} />
                  Add skill
                </button>
              </div>
            </div>
            <div className="agents-agent-resource-row">
              <span>Files</span>
              <div>
                {fileRefs.map((file) => (
                  <button key={file.id} className="agents-agent-pill">
                    <FileText size={15} />
                    {file.name}
                  </button>
                ))}
                {memoryMode ? (
                  <button className="agents-agent-pill">
                    <FileText size={15} />
                    Memory: {memoryMode}
                  </button>
                ) : null}
                {auditEntries.length > 0 ? (
                  <button className="agents-agent-pill">
                    <Clock3 size={15} />
                    {auditEntries.length} audit updates
                  </button>
                ) : null}
                <button className="agents-agent-add">
                  <Plus size={15} />
                  Add
                </button>
                {fileRefs.length === 0 && !memoryMode ? (
                  <span className="agents-agent-inline-note">No files or memory configured.</span>
                ) : null}
              </div>
            </div>
          </section>

          <section className="agents-agent-instructions">
            <span>Instructions</span>
            <h2>Role</h2>
            {selectedAgent.description || studio?.workflowBrief ? (
              <p>{selectedAgent.description || studio?.workflowBrief}</p>
            ) : (
              <p className="agents-agent-empty">No role description configured.</p>
            )}
            {instructionParagraphs[0] ? <p>{instructionParagraphs[0]}</p> : null}
            {instructionParagraphs.slice(1, 4).length > 0 ? (
              <>
                <h2>What you handle</h2>
                {instructionParagraphs.slice(1, 4).map((paragraph) => {
                  const numberedList = parseNumberedInstructionList(paragraph);
                  if (!numberedList) return <p key={paragraph}>{paragraph}</p>;
                  return (
                    <div className="agents-agent-instruction-block" key={paragraph}>
                      {numberedList.lead ? (
                        <p className="agents-agent-instruction-lead">{numberedList.lead}</p>
                      ) : null}
                      <ol className="agents-agent-instruction-list">
                        {numberedList.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ol>
                    </div>
                  );
                })}
              </>
            ) : (
              <p className="agents-agent-empty">No additional handling instructions configured.</p>
            )}
          </section>
        </main>
        {renderAgentsStyles()}
      </div>
    );
  }

  return (
    <div className="agents-panel">
      {activeShowcaseTemplate ? (
        <section
          className="agents-showcase"
          style={{ ["--agents-showcase-accent" as string]: activeShowcaseTemplate.color }}
        >
          <div className="agents-showcase-copy">
            <span className="agents-showcase-eyebrow">Featured workflow</span>
            <h2>{activeShowcaseTemplate.tagline || "Start with a proven workflow"}</h2>
            <p>{activeShowcaseTemplate.description}</p>
            <div className="agents-showcase-actions">
              <button className="agents-primary-btn" onClick={() => setLibraryTab("templates")}>
                Browse templates
              </button>
              <button className="agents-secondary-btn" onClick={handleOpenCreateComposer}>
                Create agent
              </button>
            </div>
            {featuredTemplates.length > 1 ? (
              <div className="agents-showcase-dots" aria-label="Featured workflow selector">
                {featuredTemplates.map((template, index) => (
                  <button
                    key={template.id}
                    className={`agents-showcase-dot ${index === showcaseIndex ? "active" : ""}`}
                    onClick={() => setShowcaseIndex(index)}
                    aria-label={`Show ${template.name}`}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="agents-showcase-visual">
            <div className="agents-showcase-message">
              {activeShowcaseTemplate.systemPrompt.split(".")[0]}
            </div>
            <div className="agents-showcase-core-card">
              {(() => {
                const TemplateGlyph = getTemplateGlyph(activeShowcaseTemplate);
                return (
                  <>
                    <div className="agents-showcase-core-icon">
                      <TemplateGlyph size={26} />
                    </div>
                    <div>
                      <strong>{activeShowcaseTemplate.name}</strong>
                      <span>{activeShowcaseTemplate.category}</span>
                    </div>
                  </>
                );
              })()}
            </div>
            {showcaseSideTemplates[0] &&
              (() => {
                const template = showcaseSideTemplates[0];
                const TemplateGlyph = getTemplateGlyph(template);
                return (
                  <button
                    key={template.id}
                    className="agents-showcase-side-card"
                    onClick={() =>
                      setStudioDraft(
                        buildDraftFromTemplateWithRoles(template, workspaces, agentRoles),
                      )
                    }
                  >
                    <div className="agents-showcase-side-icon">
                      <TemplateGlyph size={18} />
                    </div>
                    <div>
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </div>
                  </button>
                );
              })()}
            <div className="agents-showcase-status">
              {(
                activeShowcaseTemplate.requiredConnectorIds ||
                activeShowcaseTemplate.studio?.requiredConnectorIds ||
                []
              )
                .slice(0, 1)
                .map((connectorId) => (
                  <span key={connectorId}>{formatIdentifierLabel(connectorId)}</span>
                ))}
              {(
                activeShowcaseTemplate.requiredConnectorIds ||
                activeShowcaseTemplate.studio?.requiredConnectorIds ||
                []
              ).length === 0 ? (
                <span>No connector required</span>
              ) : null}
              <span>
                {activeShowcaseTemplate.studio?.scheduleConfig?.enabled ? "Scheduled" : "On demand"}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {conversionPanel ? (
        <section className="agents-summary-card agents-conversion-card">
          <div className="agents-section-head">
            <h2>
              {conversionPanel === "agent-role"
                ? "Convert Agent Persona"
                : "Convert automation/profile"}
            </h2>
            <span>
              Bring legacy assets into the managed-agent model without deleting the originals.
            </span>
          </div>
          <div className="agents-list">
            {(conversionPanel === "agent-role" ? agentRoles : automationProfiles)
              .slice(0, 8)
              .map((entry) => (
                <div key={entry.id} className="agents-list-row">
                  <div>
                    <strong>{entry.displayName || entry.id}</strong>
                    <span>
                      {entry.description || entry.profile || "No description configured."}
                    </span>
                  </div>
                  <button
                    className="agents-link-btn"
                    onClick={() =>
                      conversionPanel === "agent-role"
                        ? void handleConvertAgentRole(entry.id)
                        : void handleConvertAutomationProfile(entry.id)
                    }
                  >
                    Convert
                  </button>
                </div>
              ))}
          </div>
          <div className="agents-row-actions">
            <button className="agents-link-btn" onClick={() => setConversionPanel(null)}>
              Close
            </button>
            <button className="agents-link-btn" onClick={onOpenAgentPersonas}>
              Open legacy surface
            </button>
          </div>
        </section>
      ) : null}

      {error && <div className="agents-error-banner">{error}</div>}

      <section className="agents-metrics-strip">
        <div className="agents-metric-pill">
          <span>Total agents</span>
          <strong>{visibleAgentCount}</strong>
          {activeMissionControlAgentRoles.length > 0 ? (
            <small>
              {agents.length} managed · {activeMissionControlAgentRoles.length} Mission Control
            </small>
          ) : null}
        </div>
        <div className="agents-metric-pill">
          <span>Managed runs</span>
          <strong>{managedAgentTotalRuns ?? "Unavailable"}</strong>
          {managedAgentTotalRuns === null ? <small>Insights did not load</small> : null}
        </div>
        <div className="agents-metric-pill">
          <span>Slack channel targets</span>
          <strong>{slackChannelTargetCount}</strong>
        </div>
        <div className="agents-metric-pill">
          <span>Scheduled</span>
          <strong>{scheduledAgents.length}</strong>
        </div>
      </section>

      <section className="agents-library-surface">
        <div className="agents-library-header">
          <div className="agents-section-head agents-section-head-stack">
            <h2>Keep work moving 24/7 with workspace agents</h2>
            <span>Build agents that run reports, answer Slack questions, and update systems.</span>
          </div>
          <div className="agents-tab-row agents-tab-row-primary agents-directory-tabs">
            {[
              ["recent", "Recently used"],
              ["mine", "Built by me"],
              ["all", "All agents"],
              ["templates", "Templates"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`agents-tab ${libraryTab === id ? "active" : ""}`}
                onClick={() => setLibraryTab(id as AgentsLibraryTab)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {libraryTab === "templates" ? (
          <div className="agents-template-grid">
            {templates.map((template) => {
              const TemplateGlyph = getTemplateGlyph(template);
              const availablePackIds = new Set(pluginPacks.map((pack) => pack.name));
              const configuredConnectorIds = new Set(mcpServerIds.map((server) => server.id));
              const missingPacks = (template.requiredPackIds || []).filter(
                (packId) => !availablePackIds.has(packId),
              );
              const missingConnectors = (template.requiredConnectorIds || []).filter(
                (connectorId) => !configuredConnectorIds.has(connectorId),
              );
              return (
                <button
                  key={template.id}
                  className="agents-template-card"
                  style={{ ["--template-accent" as string]: template.color }}
                  onClick={() =>
                    setStudioDraft(
                      buildDraftFromTemplateWithRoles(template, workspaces, agentRoles),
                    )
                  }
                >
                  <span className="agents-template-icon">
                    <TemplateGlyph size={22} />
                  </span>
                  <div>
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                    <div className="agents-template-meta">
                      <span>{template.category}</span>
                      {(template.expectedArtifacts || []).slice(0, 3).map((artifact) => (
                        <span key={artifact}>{artifact}</span>
                      ))}
                      {(template.requiredConnectorIds || []).length > 0 ? (
                        <span>{template.requiredConnectorIds?.length || 0} connectors</span>
                      ) : null}
                      {missingPacks.length > 0 || missingConnectors.length > 0 ? (
                        <span className="agents-template-warning">
                          Missing setup: {missingPacks.length + missingConnectors.length}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : visibleLibraryAgents.length > 0 || visibleMissionControlAgentRoles.length > 0 ? (
          <div className="agents-library-grid">
            {visibleLibraryAgents.map((agent) => {
              const studio = getStudioConfig(agentDetails[agent.id]);
              const insights = agentInsights[agent.id];
              const templateRecord = studio?.templateId
                ? templates.find((entry) => entry.id === studio.templateId) || {
                    id: studio.templateId,
                    name: studio.templateId,
                    description: "",
                    icon: "",
                    color: "#1570ef",
                    category: "operations",
                    systemPrompt: "",
                    executionMode: "solo",
                  }
                : null;
              const TemplateGlyph = templateRecord ? getTemplateGlyph(templateRecord) : Bot;
              const cardColor = studio?.appearance?.color || templateRecord?.color || "#1570ef";
              return (
                <button
                  key={agent.id}
                  className="agents-library-card"
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <div className="agents-library-card-top">
                    <span className="agents-library-card-icon" style={{ color: cardColor }}>
                      <TemplateGlyph size={28} />
                    </span>
                  </div>
                  <div className="agents-library-card-copy">
                    <strong>{agent.name}</strong>
                    <p>{agent.description || studio?.workflowBrief || "No description yet."}</p>
                  </div>
                  <div className="agents-library-card-meta">
                    <span>{formatSharingLabel(studio?.sharing)}</span>
                    {insights ? (
                      <span className="agents-library-card-count">
                        <Play size={18} />
                        {formatCountLabel(insights.totalRuns, "run")}
                      </span>
                    ) : (
                      <span className="agents-library-card-count muted">Stats unavailable</span>
                    )}
                  </div>
                </button>
              );
            })}
            {visibleMissionControlAgentRoles.map((agentRole) => {
              const Icon = getEmojiIcon(agentRole.icon || "🤖");
              const cadence =
                agentRole.heartbeatPolicy?.cadenceMinutes || agentRole.pulseEveryMinutes;
              return (
                <button
                  key={`mission-control-${agentRole.id}`}
                  className="agents-library-card legacy"
                  onClick={() => setConversionPanel("agent-role")}
                >
                  <div className="agents-library-card-top">
                    <span className="agents-library-card-icon" style={{ color: agentRole.color }}>
                      <Icon size={28} />
                    </span>
                  </div>
                  <div className="agents-library-card-copy">
                    <strong>{agentRole.displayName}</strong>
                    <p>{agentRole.description || "No description configured."}</p>
                  </div>
                  <div className="agents-library-card-meta">
                    <span>Agent Persona</span>
                    <span className="agents-library-card-count">
                      <Clock3 size={18} />
                      {cadence ? `Every ${cadence}m` : "Heartbeat enabled"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="agents-empty-state">No agents in this view yet.</div>
        )}
      </section>

      <section className="agents-governance-strip">
        <div className="agents-governance-item">
          <ShieldCheck size={16} />
          <span>Approval rules for sensitive actions</span>
        </div>
        <div className="agents-governance-item">
          <Library size={16} />
          <span>Share privately, with a team, or workspace-wide</span>
        </div>
        <div className="agents-governance-item">
          <Send size={16} />
          <span>Deploy into Slack without a separate bot flow</span>
        </div>
      </section>

      {renderAgentsStyles()}
    </div>
  );
}

function renderAgentsStyles() {
  return (
    <style>{`
      .agents-panel,
      .agents-studio {
        --agents-bg: #f6f5f1;
        --agents-surface: rgba(255, 255, 255, 0.82);
        --agents-surface-strong: #ffffff;
        --agents-border: rgba(15, 23, 42, 0.08);
        --agents-border-strong: rgba(15, 23, 42, 0.12);
        --agents-text: #101828;
        --agents-muted: #667085;
        --agents-subtle: #98a2b3;
        --agents-accent: #1570ef;
        --agents-accent-soft: rgba(21, 112, 239, 0.12);
        --agents-shadow: 0 24px 64px -34px rgba(15, 23, 42, 0.22);
        padding: 28px;
        color: var(--agents-text);
        height: 100%;
        overflow-y: auto;
        background:
          radial-gradient(circle at top right, rgba(34, 197, 246, 0.14), transparent 24%),
          linear-gradient(180deg, #fcfbf8 0%, var(--agents-bg) 100%);
        font-family:
          "SF Pro Display",
          "SF Pro Text",
          "Helvetica Neue",
          Arial,
          sans-serif;
      }
      .agents-create-screen {
        min-height: 100%;
        background: #ffffff;
      }
      .agents-panel-loading,
      .agents-empty-state {
        padding: 32px;
        color: var(--agents-muted);
      }
      .agents-agent-detail-screen {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        padding: 0;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        background: #ffffff;
      }
      .agents-agent-back {
        width: fit-content;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        padding: 0;
        color: var(--agents-text);
        background: transparent;
        font-size: 1rem;
      }
      .agents-agent-editor {
        width: 100%;
        min-height: 0;
        height: 100%;
        justify-self: stretch;
        padding: 10px clamp(22px, 5vw, 72px) 84px;
        overflow-y: auto;
      }
      .agents-agent-editor-bar {
        position: sticky;
        top: 0;
        z-index: 2;
        min-height: 34px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 12px 0;
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(12px);
        color: var(--agents-subtle);
        font-size: 0.92rem;
      }
      .agents-agent-editor-bar-actions {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 18px;
        min-width: 0;
      }
      .agents-agent-editor-bar button {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 4px 0;
        background: transparent;
        color: var(--agents-muted);
        font-size: 0.92rem;
      }
      .agents-agent-editor-bar button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .agents-agent-profile {
        display: grid;
        justify-items: center;
        gap: 22px;
        padding: 54px 0 38px;
      }
      .agents-agent-avatar {
        width: 72px;
        height: 72px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 24px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 255, 255, 0.6)),
          rgba(255, 255, 255, 0.82);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.95),
          0 18px 38px -28px rgba(15, 23, 42, 0.3);
      }
      .agents-agent-profile h1 {
        margin: 0;
        font-size: clamp(2.1rem, 3.2vw, 3rem);
        line-height: 1.05;
        letter-spacing: 0;
        font-weight: 500;
      }
      .agents-agent-profile p {
        margin: -12px 0 0;
        color: var(--agents-muted);
        font-size: 0.98rem;
      }
      .agents-agent-avatar span {
        font-size: 2rem;
        line-height: 1;
      }
      .agents-agent-action-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        flex-wrap: wrap;
        border-top: 1px solid rgba(15, 23, 42, 0.08);
        padding: 22px 0 26px;
      }
      .agents-agent-action-strip h2 {
        margin: 0;
        color: var(--agents-subtle);
        font-size: 0.98rem;
        font-weight: 500;
      }
      .agents-agent-action-buttons {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
      }
      .agents-agent-action-button {
        min-height: 38px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px 13px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        background: #ffffff;
        color: var(--agents-text);
        font-size: 0.92rem;
        font-weight: 600;
      }
      .agents-agent-action-button.primary {
        border-color: #111827;
        background: #111827;
        color: #ffffff;
      }
      .agents-agent-action-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .agents-agent-action-error {
        flex-basis: 100%;
        margin: 0;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(180, 35, 24, 0.08);
        color: #b42318;
        font-size: 0.88rem;
      }
      .agents-agent-section,
      .agents-agent-resource-list,
      .agents-agent-instructions {
        border-top: 1px solid rgba(15, 23, 42, 0.08);
        padding: 26px 0;
      }
      .agents-agent-section h2,
      .agents-agent-resource-row > span,
      .agents-agent-instructions > span {
        display: block;
        margin: 0 0 14px;
        color: var(--agents-subtle);
        font-size: 0.98rem;
        font-weight: 500;
      }
      .agents-agent-channel-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .agents-agent-channel-card {
        min-height: 96px;
        display: grid;
        align-content: center;
        justify-items: start;
        justify-content: stretch;
        gap: 5px;
        padding: 18px;
        border-radius: 16px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
        color: var(--agents-text);
        text-align: left;
      }
      .agents-agent-channel-card strong {
        margin-top: 8px;
        font-size: 1rem;
      }
      .agents-agent-channel-card span {
        color: var(--agents-muted);
        font-size: 0.88rem;
      }
      .agents-agent-starter-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        align-items: stretch;
      }
      .agents-agent-starter-card {
        min-height: 116px;
        height: 100%;
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 10px;
        padding: 18px 16px;
        border-radius: 14px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
        color: var(--agents-text);
        text-align: center;
      }
      .agents-agent-starter-card strong {
        font-size: 0.98rem;
        line-height: 1.25;
      }
      .agents-agent-starter-card span {
        color: var(--agents-muted);
        font-size: 0.88rem;
        line-height: 1.45;
        max-width: 28ch;
      }
      .agents-agent-connect-list {
        display: grid;
        gap: 10px;
      }
      .agents-agent-connect-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 16px;
        padding: 14px 16px;
        border-radius: 14px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
      }
      .agents-agent-connect-row div {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .agents-agent-connect-row strong {
        font-size: 0.98rem;
      }
      .agents-agent-connect-row span {
        color: var(--agents-muted);
        font-size: 0.88rem;
      }
      .agents-agent-connect-row button {
        min-height: 34px;
        padding: 0 14px;
        border-radius: 999px;
        background: #111827;
        color: #ffffff;
      }
      .agents-agent-resource-list {
        display: grid;
        gap: 14px;
      }
      .agents-agent-resource-row {
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
        gap: 18px;
        align-items: start;
      }
      .agents-agent-resource-row > span {
        margin: 7px 0 0;
      }
      .agents-agent-resource-row > div {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        min-width: 0;
      }
      .agents-agent-pill,
      .agents-agent-add {
        min-height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        max-width: 100%;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
        color: var(--agents-text);
        white-space: nowrap;
      }
      .agents-agent-pill.muted,
      .agents-agent-add {
        border-color: transparent;
        background: transparent;
        color: var(--agents-subtle);
      }
      .agents-agent-inline-note {
        align-self: center;
        color: var(--agents-muted);
        font-size: 0.84rem;
      }
      .agents-agent-instructions {
        padding-bottom: 0;
      }
      .agents-agent-instructions h2 {
        margin: 26px 0 12px;
        color: var(--agents-text);
        font-size: 1.45rem;
        line-height: 1.2;
        font-weight: 500;
      }
      .agents-agent-instructions h2:first-of-type {
        margin-top: 0;
      }
      .agents-agent-instructions p {
        max-width: 78ch;
        margin: 0 0 18px;
        color: var(--agents-text);
        font-size: 0.96rem;
        line-height: 1.55;
      }
      .agents-agent-instruction-block {
        max-width: 82ch;
      }
      .agents-agent-instructions .agents-agent-instruction-lead {
        margin-bottom: 12px;
        color: var(--agents-muted);
        font-size: 0.9rem;
        line-height: 1.4;
      }
      .agents-agent-instruction-list {
        display: grid;
        gap: 10px;
        margin: 0;
        padding: 0;
        list-style: none;
        counter-reset: instruction-step;
      }
      .agents-agent-instruction-list li {
        counter-increment: instruction-step;
        position: relative;
        min-height: 44px;
        padding: 12px 14px 12px 52px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        border-radius: 14px;
        background: rgba(248, 250, 252, 0.74);
        color: var(--agents-text);
        font-size: 0.92rem;
        line-height: 1.48;
      }
      .agents-agent-instruction-list li::before {
        content: counter(instruction-step);
        position: absolute;
        left: 14px;
        top: 12px;
        display: inline-grid;
        width: 24px;
        height: 24px;
        place-items: center;
        border-radius: 999px;
        background: #111827;
        color: #ffffff;
        font-size: 0.78rem;
        font-weight: 650;
      }
      .agents-agent-instructions .agents-agent-empty {
        color: var(--agents-muted);
      }
      .agents-create-screen-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .agents-create-screen-actions {
        display: inline-flex;
        align-items: center;
        gap: 18px;
      }
      .agents-create-screen-back,
      .agents-create-screen-blank {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--agents-text);
        font-size: 1rem;
      }
      .agents-create-screen-blank {
        color: var(--agents-muted);
      }
      .agents-create-screen-hero {
        max-width: 1040px;
        margin: 0 auto;
        min-height: calc(100dvh - 140px);
        display: grid;
        justify-items: center;
        align-content: start;
        padding-top: clamp(64px, 10vh, 136px);
      }
      .agents-create-screen-icon {
        width: 72px;
        height: 72px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 24px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 255, 255, 0.58)),
          rgba(255, 255, 255, 0.8);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.94),
          0 18px 38px -28px rgba(15, 23, 42, 0.28);
        color: var(--agents-accent);
      }
      .agents-create-screen-hero h1 {
        margin: 22px 0 0;
        font-size: clamp(2.5rem, 2vw + 1.9rem, 3.35rem);
        line-height: 1.04;
        letter-spacing: 0;
        font-weight: 500;
        text-align: center;
      }
      .agents-create-screen-input {
        width: min(100%, 1020px);
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 14px;
        align-items: center;
        margin-top: 38px;
        padding: 12px 12px 12px 22px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: rgba(255, 255, 255, 0.96);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.94),
          0 18px 40px -30px rgba(15, 23, 42, 0.22);
      }
      .agents-create-screen-input-leading {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--agents-text);
      }
      .agents-create-screen-input input {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--agents-text);
        font: inherit;
        font-size: 1.06rem;
        line-height: 1.45;
        padding: 10px 0;
      }
      .agents-create-screen-input input::placeholder {
        color: var(--agents-subtle);
      }
      .agents-create-screen-input input:focus {
        outline: none;
      }
      .agents-create-screen-submit {
        width: 52px;
        height: 52px;
        border: 0;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: #111827;
        color: #ffffff;
        cursor: pointer;
        box-shadow: 0 12px 24px -18px rgba(17, 24, 39, 0.42);
      }
      .agents-create-screen-submit:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .agents-create-screen-error {
        margin: 14px 0 0;
        color: #b42318;
        font-size: 0.95rem;
      }
      .agents-builder-progress-card,
      .agents-builder-plan-card {
        width: min(100%, 880px);
        margin-top: 32px;
        border-radius: 18px;
        border: 1px solid rgba(15, 23, 42, 0.1);
        background: #ffffff;
        box-shadow: 0 18px 56px -38px rgba(15, 23, 42, 0.32);
        text-align: left;
      }
      .agents-builder-progress-card {
        display: grid;
        gap: 12px;
        padding: 22px;
      }
      .agents-builder-progress-heading {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--agents-text);
      }
      .agents-builder-progress-row,
      .agents-builder-plan-check {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--agents-muted);
        line-height: 1.45;
      }
      .agents-builder-progress-row svg,
      .agents-builder-plan-check svg {
        flex: 0 0 auto;
        color: #12b76a;
      }
      .agents-builder-plan-card {
        padding: 24px;
      }
      .agents-builder-plan-header {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      .agents-builder-plan-icon {
        width: 56px;
        height: 56px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 16px;
        background: #f8fafc;
        border: 1px solid rgba(15, 23, 42, 0.08);
      }
      .agents-builder-plan-header span {
        color: var(--agents-muted);
        font-size: 0.9rem;
      }
      .agents-builder-plan-header h2 {
        margin: 4px 0 6px;
        font-size: 1.6rem;
        line-height: 1.16;
        font-weight: 600;
      }
      .agents-builder-plan-header p {
        margin: 0;
        color: var(--agents-muted);
        line-height: 1.5;
      }
      .agents-builder-plan-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 18px;
      }
      .agents-builder-plan-pills span {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        background: #f2f4f7;
        color: var(--agents-text);
        font-size: 0.86rem;
      }
      .agents-builder-plan-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
        margin-top: 22px;
      }
      .agents-builder-plan-grid section,
      .agents-builder-choice-list,
      .agents-builder-connect-list,
      .agents-builder-starters {
        display: grid;
        gap: 10px;
        min-width: 0;
      }
      .agents-builder-plan-grid h3,
      .agents-builder-choice-list h3,
      .agents-builder-connect-list h3,
      .agents-builder-starters h3 {
        margin: 0;
        color: var(--agents-text);
        font-size: 0.98rem;
      }
      .agents-builder-choice-list,
      .agents-builder-connect-list,
      .agents-builder-starters {
        margin-top: 22px;
      }
      .agents-builder-choice-group {
        display: grid;
        gap: 10px;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(124, 58, 237, 0.18);
        background: rgba(250, 245, 255, 0.44);
      }
      .agents-builder-choice-group > div:first-child {
        display: grid;
        gap: 4px;
      }
      .agents-builder-choice-group strong {
        color: var(--agents-text);
        font-size: 0.95rem;
      }
      .agents-builder-choice-group span {
        color: var(--agents-muted);
        font-size: 0.86rem;
        line-height: 1.4;
      }
      .agents-builder-choice-options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
      }
      .agents-builder-choice-options button {
        display: grid;
        gap: 4px;
        min-height: 72px;
        padding: 12px;
        border-radius: 14px;
        border: 1px solid rgba(15, 23, 42, 0.09);
        background: #ffffff;
        color: var(--agents-text);
        text-align: left;
      }
      .agents-builder-choice-options button.active {
        border-color: rgba(124, 58, 237, 0.58);
        box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.13);
      }
      .agents-builder-connect-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 14px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #fcfcfd;
      }
      .agents-builder-connect-row div {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .agents-builder-connect-row strong {
        font-size: 0.95rem;
      }
      .agents-builder-connect-row span {
        color: var(--agents-muted);
        font-size: 0.86rem;
        line-height: 1.4;
      }
      .agents-builder-connect-row button {
        min-height: 34px;
        padding: 0 14px;
        border-radius: 999px;
        background: #111827;
        color: #ffffff;
      }
      .agents-builder-starters > div {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .agents-builder-starters button {
        min-height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: #ffffff;
        color: var(--agents-text);
      }
      .agents-builder-plan-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 24px;
      }
      .agents-builder-plan-blocked {
        margin: 10px 0 0;
        color: var(--agents-muted);
        font-size: 0.86rem;
        text-align: right;
      }
      .agents-create-screen-suggestions {
        width: min(100%, 1020px);
        display: grid;
        gap: 8px;
        margin-top: 44px;
      }
      .agents-create-screen-row {
        display: grid;
        grid-template-columns: auto auto minmax(0, 1fr);
        align-items: center;
        gap: 16px;
        padding: 10px 18px;
        border: 0;
        border-radius: 18px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      .agents-create-screen-row:hover {
        background: rgba(255, 255, 255, 0.42);
      }
      .agents-create-screen-row-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--agents-text);
      }
      .agents-create-screen-row strong {
        font-size: 1rem;
        font-weight: 500;
        color: var(--agents-text);
      }
      .agents-create-screen-row span:last-child {
        color: var(--agents-subtle);
        font-size: 0.98rem;
        line-height: 1.45;
      }
      .agents-empty-state {
        border: 1px dashed var(--agents-border-strong);
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.48);
      }
      .agents-inline-permission-note {
        margin: 0 0 16px;
        padding: 12px 16px;
        border-radius: 18px;
        border: 1px solid var(--agents-border);
        background: var(--agents-surface);
        color: var(--agents-muted);
      }
      .agents-shell-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 20px;
        margin-bottom: 22px;
      }
      .agents-shell-copy h1 {
        margin: 0;
        font-size: 3.1rem;
        line-height: 0.98;
        letter-spacing: -0.04em;
        font-weight: 500;
      }
      .agents-shell-copy p {
        margin: 12px 0 0;
        color: var(--agents-subtle);
        font-size: 1.06rem;
      }
      .agents-shell-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
      }
      .agents-create-surface,
      .agents-showcase,
      .agents-hero-card {
        border-radius: 32px;
        border: 1px solid var(--agents-border);
        background: var(--agents-surface);
        box-shadow: var(--agents-shadow);
      }
      .agents-create-surface {
        padding: 30px;
        margin-bottom: 22px;
      }
      .agents-create-heading {
        display: flex;
        align-items: center;
        gap: 18px;
        margin-bottom: 18px;
      }
      .agents-create-badge,
      .agents-showcase-core-icon,
      .agents-template-icon,
      .agents-library-card-icon,
      .agents-showcase-side-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 22px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.55)),
          rgba(255, 255, 255, 0.76);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.88),
          0 14px 34px -24px rgba(15, 23, 42, 0.35);
        color: var(--agents-accent);
      }
      .agents-create-badge {
        width: 68px;
        height: 68px;
      }
      .agents-create-heading h2,
      .agents-showcase-copy h2 {
        margin: 0;
        font-size: 1.05rem;
        line-height: 1.1;
        letter-spacing: -0.02em;
        font-weight: 500;
      }
      .agents-create-heading h2 {
        font-size: 2rem;
      }
      .agents-create-heading p,
      .agents-showcase-copy p,
      .agents-hero-card p {
        margin: 8px 0 0;
        color: var(--agents-muted);
        max-width: 54ch;
        line-height: 1.6;
      }
      .agents-create-bar {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 14px;
        align-items: center;
        min-height: 80px;
        padding: 10px 12px 10px 18px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: rgba(255, 255, 255, 0.94);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.92),
          0 16px 36px -28px rgba(15, 23, 42, 0.22);
      }
      .agents-create-leading {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--agents-text);
      }
      .agents-create-bar textarea {
        width: 100%;
        min-height: 44px;
        max-height: 132px;
        resize: vertical;
        border: 0;
        background: transparent;
        color: var(--agents-text);
        padding: 10px 0;
        font: inherit;
        font-size: 1.02rem;
        line-height: 1.45;
      }
      .agents-create-bar textarea::placeholder {
        color: var(--agents-subtle);
      }
      .agents-create-bar textarea:focus {
        outline: none;
      }
      .agents-create-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .agents-preset-chip {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        border: 1px solid var(--agents-border);
        border-radius: 999px;
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.88);
        color: var(--agents-text);
        cursor: pointer;
        transition:
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          border-color 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-preset-chip.ghost {
        color: var(--agents-muted);
      }
      .agents-preset-chip:hover {
        transform: translateY(-1px);
        border-color: rgba(21, 112, 239, 0.22);
        background: rgba(255, 255, 255, 0.96);
      }
      .agents-showcase {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1.04fr) minmax(340px, 0.96fr);
        gap: 32px;
        padding: 44px;
        min-height: 480px;
        margin-bottom: 22px;
        overflow: hidden;
        border-color: rgba(125, 211, 252, 0.26);
        background:
          radial-gradient(circle at 18% 22%, rgba(255, 255, 255, 0.26), transparent 26%),
          radial-gradient(circle at 78% 18%, rgba(255, 255, 255, 0.24), transparent 32%),
          linear-gradient(135deg, #1e8df6, #3dbcf5 48%, #7ed8f6 100%);
        color: #ffffff;
      }
      .agents-showcase::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 60% 58%, rgba(255, 255, 255, 0.18), transparent 24%),
          radial-gradient(circle at 72% 32%, rgba(255, 255, 255, 0.14), transparent 20%);
        mix-blend-mode: screen;
        animation: agentsShowcaseGlow 12s ease-in-out infinite alternate;
        pointer-events: none;
      }
      .agents-showcase > * {
        position: relative;
      }
      .agents-showcase-copy {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 16px;
        height: 100%;
      }
      .agents-showcase-eyebrow,
      .agents-eyebrow,
      .agents-studio-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(255, 255, 255, 0.16);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
      }
      .agents-showcase-copy h2 {
        margin: 0;
        font-size: clamp(2rem, 1.6vw + 1.4rem, 2.9rem);
        line-height: 1.08;
        max-width: 14ch;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .agents-showcase-copy p {
        margin: 0;
        color: rgba(255, 255, 255, 0.88);
        max-width: 38ch;
        line-height: 1.5;
      }
      .agents-showcase-actions,
      .agents-hero-actions,
      .agents-toolbar,
      .agents-row-actions,
      .agents-inline-create {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .agents-showcase-actions {
        margin-top: 8px;
      }
      .agents-showcase-dots {
        display: flex;
        gap: 10px;
        margin-top: 8px;
      }
      .agents-showcase-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        border: 0;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.28);
      }
      .agents-showcase-dot.active {
        background: rgba(255, 255, 255, 0.96);
      }
      .agents-showcase-visual {
        min-height: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: stretch;
        gap: 16px;
        padding-left: 4%;
        height: 100%;
      }
      .agents-showcase-message {
        align-self: flex-end;
        padding: 14px 22px;
        border-radius: 22px;
        background: rgba(247, 251, 255, 0.96);
        color: #111827;
        box-shadow: 0 14px 32px -24px rgba(15, 23, 42, 0.42);
        max-width: 360px;
        font-size: 1rem;
        line-height: 1.4;
      }
      .agents-showcase-core-card,
      .agents-showcase-side-card {
        border: 1px solid rgba(255, 255, 255, 0.28);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.88)),
          rgba(255, 255, 255, 0.9);
        color: var(--agents-text);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.4),
          0 28px 48px -32px rgba(15, 23, 42, 0.42);
      }
      .agents-showcase-core-card {
        display: flex;
        align-items: center;
        gap: 18px;
        width: 100%;
        max-width: 400px;
        align-self: flex-end;
        padding: 20px 24px;
        border-radius: 24px;
        animation: agentsFloatCard 6.8s ease-in-out infinite;
      }
      .agents-showcase-core-card strong,
      .agents-showcase-side-card strong {
        display: block;
        font-size: 1.12rem;
        font-weight: 500;
      }
      .agents-showcase-core-card span,
      .agents-showcase-side-card span {
        display: block;
        color: var(--agents-muted);
        margin-top: 6px;
        line-height: 1.45;
      }
      .agents-showcase-core-icon {
        width: 62px;
        height: 62px;
      }
      .agents-showcase-side-card {
        width: 100%;
        max-width: 360px;
        display: flex;
        align-items: flex-start;
        gap: 14px;
        text-align: left;
        padding: 18px 20px;
        border-radius: 22px;
        cursor: pointer;
        align-self: flex-end;
        transition:
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-showcase-side-card.top {
        margin-right: 8%;
      }
      .agents-showcase-side-card.bottom {
        margin-right: 0;
      }
      .agents-showcase-side-card:hover {
        transform: translateY(-2px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.4),
          0 32px 56px -30px rgba(15, 23, 42, 0.5);
      }
      .agents-showcase-side-icon,
      .agents-template-icon,
      .agents-library-card-icon {
        width: 48px;
        height: 48px;
        flex-shrink: 0;
      }
      .agents-showcase-status {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .agents-showcase-status span {
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: rgba(255, 255, 255, 0.94);
        font-size: 0.8rem;
      }
      .agents-toolbar {
        justify-content: space-between;
        margin-bottom: 20px;
      }
      .agents-primary-btn,
      .agents-create-submit,
      .agents-secondary-btn,
      .agents-link-btn,
      .agents-link-card,
      .agents-chip,
      .agents-preset-chip,
      .agents-template-card {
        border: 0;
        cursor: pointer;
      }
      .agents-primary-btn,
      .agents-create-submit,
      .agents-secondary-btn,
      .agents-link-btn,
      .agents-link-card {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 600;
        transition:
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          border-color 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-primary-btn:active,
      .agents-create-submit:active,
      .agents-secondary-btn:active,
      .agents-link-card:active,
      .agents-template-card:active,
      .agents-library-card:active,
      .agents-showcase-side-card:active,
      .agents-preset-chip:active {
        transform: translateY(1px) scale(0.985);
      }
      .agents-primary-btn {
        background: #111827;
        color: white;
        box-shadow: 0 12px 24px -18px rgba(17, 24, 39, 0.45);
      }
      .agents-create-submit {
        width: 52px;
        height: 52px;
        justify-content: center;
        padding: 0;
        background: #111827;
        color: #ffffff;
        box-shadow: 0 12px 24px -18px rgba(17, 24, 39, 0.42);
      }
      .agents-secondary-btn,
      .agents-link-card {
        background: rgba(255, 255, 255, 0.84);
        color: var(--agents-text);
        border: 1px solid var(--agents-border);
      }
      .agents-link-btn {
        background: transparent;
        color: var(--agents-muted);
        padding: 0;
      }
      .agents-link-btn:disabled,
      .agents-primary-btn:disabled,
      .agents-secondary-btn:disabled,
      .agents-create-submit:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }
      .agents-link-card:hover,
      .agents-secondary-btn:hover,
      .agents-primary-btn:hover,
      .agents-create-submit:hover {
        transform: translateY(-1px);
      }
      .agents-routine-card {
        display: grid;
        gap: 12px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.4);
      }
      .agents-error-banner {
        margin: 0 0 16px;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px solid rgba(239, 68, 68, 0.16);
        background: rgba(254, 242, 242, 0.86);
        color: #b42318;
      }
      .agents-summary-card,
      .agents-library-surface,
      .agents-templates,
      .agents-summary-card,
      .agents-section-card,
      .agents-detail-card,
      .agents-detail-surface {
        background: var(--agents-surface);
        border: 1px solid var(--agents-border);
        border-radius: 30px;
        padding: 24px;
        box-shadow: 0 18px 42px -32px rgba(15, 23, 42, 0.18);
      }
      .agents-metrics-strip,
      .agents-summary-grid,
      .agents-detail-grid,
      .agents-studio-grid {
        display: grid;
        gap: 18px;
      }
      .agents-studio-test-surface {
        grid-column: 1 / -1;
      }
      .agents-studio-test-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr);
        gap: 18px;
        margin-top: 18px;
      }
      .agents-studio-test-chat,
      .agents-studio-test-summary {
        min-width: 0;
        display: grid;
        gap: 14px;
      }
      .agents-studio-test-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        color: var(--agents-muted);
      }
      .agents-studio-test-transcript {
        min-height: 360px;
        max-height: 640px;
        overflow: auto;
        display: grid;
        align-content: start;
        gap: 12px;
        padding: 16px;
        border-radius: 24px;
        border: 1px solid var(--agents-border);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(248, 250, 252, 0.78)),
          rgba(255, 255, 255, 0.82);
      }
      .agents-studio-test-empty {
        display: grid;
        place-items: center;
        min-height: 280px;
        text-align: center;
        color: var(--agents-muted);
      }
      .agents-studio-test-empty strong {
        color: var(--agents-text);
        font-size: 1.05rem;
      }
      .agents-studio-test-empty p {
        margin: 8px 0 0;
        max-width: 38ch;
        line-height: 1.6;
      }
      .agents-studio-test-bubble {
        max-width: min(100%, 620px);
        display: grid;
        gap: 6px;
        padding: 14px 16px;
        border-radius: 20px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 14px 28px -24px rgba(15, 23, 42, 0.18);
      }
      .agents-studio-test-bubble.user {
        margin-left: auto;
        background: rgba(21, 112, 239, 0.1);
        border-color: rgba(21, 112, 239, 0.18);
      }
      .agents-studio-test-bubble.assistant {
        margin-right: auto;
      }
      .agents-studio-test-bubble.system {
        max-width: 100%;
        background: rgba(15, 23, 42, 0.04);
      }
      .agents-studio-test-bubble-role {
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--agents-muted);
      }
      .agents-studio-test-bubble p {
        margin: 0;
        line-height: 1.55;
        color: var(--agents-text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .agents-studio-test-compose {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: end;
      }
      .agents-studio-test-compose textarea {
        min-height: 84px;
        resize: vertical;
      }
      .agents-studio-test-summary-card,
      .agents-studio-test-workpaper {
        padding: 16px 18px;
        border-radius: 22px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.74);
      }
      .agents-studio-test-summary-card span,
      .agents-studio-test-workpaper span {
        display: block;
        font-size: 0.75rem;
        color: var(--agents-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .agents-studio-test-summary-card strong,
      .agents-studio-test-workpaper strong {
        display: block;
        margin-top: 6px;
        font-size: 1.02rem;
      }
      .agents-studio-test-summary-card p,
      .agents-studio-test-workpaper p {
        margin: 8px 0 0;
        color: var(--agents-muted);
        line-height: 1.55;
      }
      .agents-metrics-strip {
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin-bottom: 22px;
      }
      .agents-metric-pill {
        padding: 18px 20px;
        border-radius: 24px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.72);
        box-shadow: 0 18px 32px -28px rgba(15, 23, 42, 0.18);
      }
      .agents-metric-pill span,
      .agents-kpi span {
        display: block;
        font-size: 0.78rem;
        color: var(--agents-muted);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .agents-metric-pill strong,
      .agents-kpi strong {
        font-size: 2rem;
        line-height: 1;
        font-weight: 500;
      }
      .agents-metric-pill small {
        display: block;
        margin-top: 8px;
        color: var(--agents-muted);
        font-size: 0.78rem;
        line-height: 1.35;
      }
      .agents-governance-list {
        display: grid;
        gap: 12px;
      }
      .agents-approval-preview {
        margin-top: 14px;
      }
      .agents-approval-preview-card,
      .agents-surface-preview-card {
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.56);
        border: 1px solid var(--agents-border);
      }
      .agents-approval-preview-card strong,
      .agents-surface-preview-card strong {
        display: block;
        margin-bottom: 6px;
      }
      .agents-approval-preview-card p,
      .agents-surface-preview-card p {
        margin: 0;
        color: var(--agents-muted);
      }
      .agents-approval-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-top: 12px;
      }
      .agents-approval-columns span {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        color: var(--agents-muted);
      }
      .agents-approval-columns ul {
        margin: 0;
        padding-left: 18px;
        color: var(--agents-text);
      }
      .agents-approval-columns li {
        margin: 0 0 4px;
      }
      .agents-approval-matrix-card {
        margin-top: 12px;
      }
      .agents-approval-matrix-card-detail {
        margin-top: 14px;
      }
      .agents-approval-matrix {
        margin-top: 10px;
        display: grid;
        gap: 0;
      }
      .agents-approval-matrix-header,
      .agents-approval-matrix-row {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(180px, 0.9fr) minmax(160px, 0.85fr);
        gap: 18px;
        align-items: start;
      }
      .agents-approval-matrix-header {
        padding-bottom: 10px;
        border-bottom: 1px solid var(--agents-border);
      }
      .agents-approval-matrix-head {
        font-size: 12px;
        color: var(--agents-muted);
        font-weight: 600;
      }
      .agents-approval-matrix-row {
        padding: 14px 0;
        border-bottom: 1px solid var(--agents-border);
      }
      .agents-approval-matrix-row:last-child {
        padding-bottom: 0;
        border-bottom: none;
      }
      .agents-approval-matrix-cell {
        color: var(--agents-text);
        font-size: 13px;
        min-width: 0;
        display: grid;
        gap: 6px;
        line-height: 1.45;
      }
      .agents-approval-matrix-label {
        display: none;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--agents-muted);
      }
      .agents-approval-runtime-code {
        width: fit-content;
        max-width: 100%;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.06);
        border: 1px solid rgba(15, 23, 42, 0.08);
        font-size: 12px;
        line-height: 1.3;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .agents-approval-matrix-cell.safe {
        color: #10b981;
      }
      .agents-approval-matrix-cell.danger {
        color: #f59e0b;
      }
      .agents-approval-behavior-pill {
        width: fit-content;
        max-width: 100%;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        line-height: 1.3;
        white-space: normal;
      }
      .agents-approval-behavior-pill.safe {
        background: rgba(16, 185, 129, 0.12);
        color: #059669;
      }
      .agents-approval-behavior-pill.danger {
        background: rgba(245, 158, 11, 0.14);
        color: #b45309;
      }
      .agents-governance-item {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        color: var(--agents-muted);
      }
      .agents-library-surface {
        margin-bottom: 28px;
        padding: 20px;
        border-radius: 24px;
      }
      .agents-library-header {
        display: grid;
        gap: 20px;
        margin-bottom: 18px;
      }
      .agents-library-header .agents-section-head {
        margin-bottom: 0;
      }
      .agents-library-header .agents-section-head h2 {
        max-width: 800px;
        font-size: clamp(1.8rem, 3vw, 3.2rem);
        line-height: 1.08;
        letter-spacing: 0;
        font-weight: 500;
      }
      .agents-library-header .agents-section-head span {
        color: var(--agents-muted);
        font-size: clamp(0.96rem, 1.2vw, 1.18rem);
        line-height: 1.35;
      }
      .agents-tab-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .agents-directory-tabs {
        gap: 12px;
      }
      .agents-tab {
        border: 1px solid transparent;
        background: transparent;
        color: var(--agents-muted);
        padding: 8px 14px;
        border-radius: 999px;
        cursor: pointer;
        font-size: 0.94rem;
        line-height: 1.2;
        transition:
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          border-color 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-tab.active {
        color: var(--agents-text);
        border-color: rgba(17, 24, 39, 0.58);
        background: #ffffff;
        box-shadow: none;
      }
      .agents-tab.subtle {
        background: rgba(255, 255, 255, 0.64);
      }
      .agents-detail-grid,
      .agents-studio-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .agents-library-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(200px, 1fr));
        gap: 14px;
      }
      .agents-library-card {
        display: grid;
        align-content: space-between;
        justify-content: stretch;
        gap: 14px;
        min-height: 190px;
        padding: 22px;
        text-align: left;
        border-radius: 18px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.86);
        box-shadow: none;
        transition:
          transform 0.32s cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 0.32s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-library-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 18px 44px -34px rgba(15, 23, 42, 0.28);
      }
      .agents-library-card.legacy {
        border-style: dashed;
      }
      .agents-library-card-top,
      .agents-library-card-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .agents-library-card-top {
        justify-content: flex-start;
      }
      .agents-library-card-icon {
        width: 44px;
        height: 44px;
        border-radius: 16px;
      }
      .agents-library-card-status {
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(17, 24, 39, 0.05);
        color: var(--agents-muted);
        font-size: 0.78rem;
        text-transform: capitalize;
      }
      .agents-library-card-status.mission-control {
        background: rgba(21, 112, 239, 0.1);
        color: #155eef;
      }
      .agents-library-card-copy strong {
        display: block;
        font-size: 1.16rem;
        line-height: 1.15;
        letter-spacing: 0;
        font-weight: 500;
      }
      .agents-library-card-copy p {
        margin: 9px 0 0;
        color: var(--agents-muted);
        font-size: 0.92rem;
        line-height: 1.38;
      }
      .agents-library-card-meta span {
        color: var(--agents-muted);
        font-size: 0.86rem;
      }
      .agents-library-card-count {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      .agents-library-card-count.muted {
        color: var(--agents-subtle);
      }
      .agents-template-grid,
      .agents-chip-grid {
        display: grid;
        gap: 12px;
      }
      .agents-template-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .agents-template-card {
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        gap: 12px;
        width: 100%;
        min-width: 0;
        padding: 18px;
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.84)),
          radial-gradient(circle at top left, color-mix(in srgb, var(--template-accent), transparent 78%), transparent 42%);
        color: inherit;
        text-align: left;
        border: 1px solid var(--agents-border);
      }
      .agents-template-card > div {
        min-width: 0;
      }
      .agents-template-icon {
        width: 42px;
        height: 42px;
        border-radius: 15px;
      }
      .agents-template-card strong {
        display: block;
        font-size: 1rem;
        line-height: 1.18;
        font-weight: 500;
      }
      .agents-template-card p {
        margin: 8px 0 0;
        color: var(--agents-muted);
        font-size: 0.86rem;
        line-height: 1.38;
      }
      .agents-template-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 10px;
      }
      .agents-template-meta span {
        border: 1px solid rgba(15, 23, 42, 0.1);
        border-radius: 999px;
        padding: 2px 7px;
        background: rgba(255, 255, 255, 0.68);
        color: var(--agents-muted);
        font-size: 0.68rem;
        line-height: 1.2;
      }
      .agents-template-meta .agents-template-warning {
        border-color: rgba(217, 119, 6, 0.28);
        background: rgba(254, 243, 199, 0.72);
        color: #92400e;
      }
      .agents-section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 14px;
      }
      .agents-section-head h2,
      .agents-section-head h3 {
        margin: 0;
        font-size: 1.32rem;
        line-height: 1.12;
        font-weight: 500;
      }
      .agents-section-head span {
        color: var(--agents-muted);
        font-size: 0.88rem;
      }
      .agents-section-head-stack {
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
      }
      .agents-list {
        display: grid;
        gap: 12px;
      }
      .agents-list-row,
      .agents-session-row,
      .agents-slack-target {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        padding: 14px 0;
        border-top: 1px solid var(--agents-border);
      }
      .agents-list-row:first-child,
      .agents-session-row:first-child,
      .agents-slack-target:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .agents-list-row strong,
      .agents-session-row strong {
        display: block;
      }
      .agents-list-row span,
      .agents-session-row span,
      .agents-empty-note {
        color: var(--agents-muted);
        font-size: 13px;
      }
      .agents-detail-surface {
        margin-top: 24px;
      }
      .agents-detail-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 16px;
      }
      .agents-detail-header h3 {
        margin: 0 0 6px;
        font-size: 1.6rem;
        font-weight: 500;
      }
      .agents-detail-header p {
        margin: 0;
        color: var(--agents-muted);
      }
      .agents-detail-meta {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .agents-detail-meta div {
        padding: 14px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.58);
        border: 1px solid var(--agents-border);
      }
      .agents-detail-meta-secondary {
        margin-top: 12px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .agents-detail-meta span {
        display: block;
        color: var(--agents-muted);
        font-size: 12px;
        margin-bottom: 4px;
      }
      .agents-note-card {
        margin-bottom: 14px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid var(--agents-border);
      }
      .agents-note-card strong {
        display: block;
        margin-bottom: 6px;
      }
      .agents-note-card p {
        margin: 0;
        color: var(--agents-muted);
      }
      .agents-surface-preview-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .agents-surface-preview-grid-detail {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .agents-surface-preview-foot {
        margin-top: 10px !important;
        font-size: 12px;
      }
      .agents-audio-player {
        width: 100%;
        margin-top: 10px;
      }
      .agents-field-grid,
      .agents-checkbox-row {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .agents-field-grid + label,
      .agents-field-grid + .agents-chip-grid {
        margin-top: 12px;
      }
      .agents-section-card label {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }
      .agents-section-card label span {
        font-size: 13px;
        color: var(--agents-muted);
      }
      .agents-section-card input,
      .agents-section-card textarea,
      .agents-section-card select {
        width: 100%;
        border-radius: 16px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.88);
        color: var(--agents-text);
        padding: 11px 12px;
        font: inherit;
      }
      .agents-section-card input::placeholder,
      .agents-section-card textarea::placeholder {
        color: var(--agents-subtle);
      }
      .agents-chip-grid {
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        margin-top: 10px;
      }
      .agents-chip {
        padding: 10px 12px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--agents-border);
        color: var(--agents-muted);
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agents-chip.active {
        background: var(--agents-accent-soft);
        color: var(--agents-text);
        border-color: rgba(21, 112, 239, 0.24);
      }
      .agents-checkbox {
        display: inline-flex !important;
        align-items: center;
        gap: 10px;
        margin-top: 0 !important;
      }
      .agents-checkbox input {
        width: auto;
      }
      .agents-inline-create {
        margin-top: 14px;
      }
      .agents-runtime-catalog-card {
        margin-top: 14px;
      }
      .agents-runtime-catalog-copy {
        margin-top: 8px !important;
      }
      .agents-runtime-surface-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .agents-runtime-surface-card {
        min-width: 0;
        padding: 14px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid var(--agents-border);
      }
      .agents-runtime-surface-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      .agents-runtime-surface-head strong {
        min-width: 0;
        margin-bottom: 0;
        overflow-wrap: anywhere;
      }
      .agents-runtime-surface-head span {
        flex: 0 0 auto;
        color: var(--agents-muted);
        font-size: 12px;
        line-height: 1.35;
        text-align: right;
        white-space: nowrap;
      }
      .agents-runtime-tool-list {
        display: grid;
        gap: 10px;
      }
      .agents-runtime-tool-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        padding-top: 10px;
        border-top: 1px solid var(--agents-border);
        min-width: 0;
      }
      .agents-runtime-tool-row:first-child {
        padding-top: 0;
        border-top: 0;
      }
      .agents-runtime-tool-row > div {
        min-width: 0;
      }
      .agents-runtime-tool-title {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 6px;
        min-width: 0;
      }
      .agents-runtime-tool-title code {
        display: inline-block;
        max-width: 100%;
        line-height: 1.3;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .agents-runtime-tool-title span,
      .agents-runtime-meta-line {
        display: inline-block;
        max-width: 100%;
        min-width: 0;
        color: var(--agents-muted);
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .agents-runtime-tool-row p {
        margin: 0;
        color: var(--agents-muted);
        font-size: 13px;
        line-height: 1.45;
        overflow-wrap: break-word;
      }
      .agents-runtime-tool-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
        min-width: 0;
      }
      .agents-runtime-pill {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        max-width: 100%;
        padding: 5px 9px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        border: 1px solid var(--agents-border);
        font-size: 12px;
        line-height: 1.2;
        color: var(--agents-text);
        white-space: nowrap;
      }
      .agents-runtime-pill.safe {
        background: rgba(16, 185, 129, 0.08);
        color: #10b981;
      }
      .agents-runtime-pill.danger {
        background: rgba(245, 158, 11, 0.12);
        color: #f59e0b;
      }
      .agents-governance-strip {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 24px;
      }
      .agents-governance-strip .agents-governance-item {
        padding: 16px 18px;
        border-radius: 22px;
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.72);
        box-shadow: 0 16px 28px -26px rgba(15, 23, 42, 0.14);
      }
      .agents-conversion-card {
        margin-bottom: 20px;
      }
      .agents-section-card,
      .agents-hero-card {
        background: rgba(255, 255, 255, 0.86);
      }
      .agents-hero-card {
        border-radius: 28px;
        padding: 24px;
      }
      .agents-hero-card p {
        color: var(--agents-muted);
      }
      .agents-section-card select,
      .agents-approval-preview-card select {
        border-radius: 14px;
        border: 1px solid var(--agents-border);
        background: #ffffff;
        color: var(--agents-text);
        padding: 10px 12px;
        font: inherit;
      }
      .agents-showcase,
      .agents-library-card,
      .agents-template-card,
      .agents-metric-pill,
      .agents-governance-strip .agents-governance-item,
      .agents-primary-btn,
      .agents-secondary-btn,
      .agents-link-card,
      .agents-tab,
      .agents-preset-chip {
        will-change: transform;
      }
      @keyframes agentsShowcaseGlow {
        0% {
          transform: translate3d(0, 0, 0) scale(1);
        }
        100% {
          transform: translate3d(-1.5%, 1.5%, 0) scale(1.04);
        }
      }
      @keyframes agentsFloatCard {
        0%,
        100% {
          transform: translate3d(0, 0, 0);
        }
        50% {
          transform: translate3d(0, -6px, 0);
        }
      }
      @media (max-width: 1100px) {
        .agents-shell-header,
        .agents-showcase,
        .agents-metrics-strip,
        .agents-governance-strip,
        .agents-library-grid,
        .agents-detail-grid,
        .agents-studio-grid,
        .agents-detail-meta,
        .agents-field-grid,
        .agents-checkbox-row,
        .agents-kpi-grid,
        .agents-surface-preview-grid,
        .agents-surface-preview-grid-detail,
        .agents-runtime-surface-grid,
        .agents-approval-columns,
        .agents-approval-matrix-row,
        .agents-approval-matrix-header,
        .agents-runtime-tool-row,
        .agents-studio-test-grid,
        .agents-studio-test-compose,
        .agents-builder-plan-grid,
        .agents-agent-starter-grid {
          grid-template-columns: 1fr;
        }
        .agents-approval-matrix-header {
          display: none;
        }
        .agents-approval-matrix-label {
          display: block;
        }
        .agents-showcase-visual {
          padding-left: 0;
        }
        .agents-showcase-message,
        .agents-showcase-side-card,
        .agents-showcase-core-card {
          justify-self: stretch;
          width: auto;
          margin-right: 0;
        }
        .agents-showcase {
          height: auto;
          min-height: 0;
          padding: 32px;
        }
        .agents-library-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .agents-template-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .agents-showcase-core-card,
        .agents-showcase-side-card,
        .agents-showcase-message {
          align-self: stretch;
          max-width: none;
          margin-right: 0;
        }
        .agents-agent-detail-screen {
          grid-template-columns: minmax(0, 1fr);
        }
        .agents-agent-editor {
          padding: 10px 28px 64px;
        }
        .agents-agent-editor-bar,
        .agents-agent-editor-bar-actions,
        .agents-agent-action-strip {
          align-items: flex-start;
          justify-content: flex-start;
          flex-wrap: wrap;
        }
      }
      @media (max-width: 768px) {
        .agents-panel,
        .agents-studio {
          padding: 18px;
        }
        .agents-agent-detail-screen {
          padding: 0;
        }
        .agents-agent-editor {
          padding: 8px 18px 48px;
        }
        .agents-agent-editor-bar {
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        .agents-agent-editor-bar-actions {
          width: 100%;
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        .agents-agent-profile {
          padding: 34px 0 28px;
        }
        .agents-agent-channel-grid {
          grid-template-columns: 1fr;
        }
        .agents-agent-resource-row {
          grid-template-columns: 1fr;
          gap: 8px;
        }
        .agents-agent-resource-row > span {
          margin-top: 0;
        }
        .agents-create-screen-bar {
          align-items: flex-start;
          flex-direction: column;
        }
        .agents-create-screen-actions {
          flex-wrap: wrap;
        }
        .agents-create-screen-hero {
          min-height: calc(100dvh - 110px);
          padding-top: 48px;
        }
        .agents-create-screen-input {
          grid-template-columns: auto minmax(0, 1fr);
          border-radius: 28px;
        }
        .agents-create-screen-submit {
          grid-column: 1 / -1;
          width: 100%;
          height: 48px;
        }
        .agents-create-screen-row {
          grid-template-columns: auto 1fr;
          align-items: start;
        }
        .agents-create-screen-row strong {
          grid-column: 2;
        }
        .agents-create-screen-row span:last-child {
          grid-column: 2;
          margin-top: -8px;
        }
        .agents-shell-copy h1 {
          font-size: 2.5rem;
        }
        .agents-create-surface,
        .agents-showcase,
        .agents-library-surface,
        .agents-detail-surface,
        .agents-summary-card,
        .agents-section-card,
        .agents-detail-card {
          padding: 20px;
          border-radius: 28px;
        }
        .agents-showcase {
          height: auto;
          min-height: 0;
        }
        .agents-create-bar {
          min-height: 72px;
          border-radius: 28px;
          grid-template-columns: auto minmax(0, 1fr);
        }
        .agents-create-submit {
          grid-column: 1 / -1;
          width: 100%;
          height: 48px;
        }
        .agents-tab-row-primary,
        .agents-tab-row-secondary,
        .agents-shell-actions {
          justify-content: flex-start;
        }
        .agents-library-grid {
          grid-template-columns: 1fr;
        }
        .agents-template-grid {
          grid-template-columns: 1fr;
        }
        .agents-library-card {
          min-height: 176px;
          padding: 20px;
        }
      }
    `}</style>
  );
}
