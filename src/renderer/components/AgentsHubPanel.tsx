import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Bot,
  Briefcase,
  Bug,
  CalendarDays,
  ChevronLeft,
  FileText,
  Image as ImageIcon,
  Inbox,
  Library,
  MessageSquare,
  Play,
  Plus,
  Save,
  Search,
  Send,
  ShieldCheck,
  Slack,
  Volume2,
  Wrench,
} from "lucide-react";
import type {
  AgentTemplate,
  AgentWorkspaceMembership,
  AgentWorkspacePermissionSnapshot,
  ApprovalType,
  AudioSummaryResult,
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
  ManagedAgentToolFamily,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionEvent,
  ManagedSessionWorkpaper,
  SecurityMode,
  Workspace,
} from "../../shared/types";

type SkillLite = {
  id: string;
  name: string;
  description?: string;
};

type AgentsLibraryTab = "library" | "recent" | "shared" | "scheduled" | "templates";

type AgentDraft = {
  agentId?: string;
  status?: ManagedAgent["status"];
  templateId?: string;
  workflowBrief: string;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  operatingNotes: string;
  executionMode: ManagedAgentVersion["executionMode"];
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

interface AgentsHubPanelProps {
  onOpenMissionControl?: () => void;
  onOpenAgentPersonas?: () => void;
  onOpenSlackSettings?: () => void;
}

const TOOL_FAMILY_OPTIONS: Array<{ id: ManagedAgentToolFamily; label: string }> = [
  { id: "communication", label: "Communication" },
  { id: "search", label: "Search" },
  { id: "files", label: "Files" },
  { id: "documents", label: "Documents" },
  { id: "memory", label: "Memory" },
  { id: "shell", label: "Shell" },
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

const APPROVAL_ACTION_RUNTIME_TYPE: Record<
  (typeof APPROVAL_ACTION_OPTIONS)[number],
  ApprovalType
> = {
  "send email": "external_service",
  "post message": "external_service",
  "edit spreadsheet": "data_export",
  "create calendar event": "external_service",
  "file external ticket": "external_service",
};

const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  delete_file: "Delete file",
  delete_multiple: "Delete multiple",
  bulk_rename: "Bulk rename",
  network_access: "Network access",
  data_export: "Data export",
  external_service: "External service",
  run_command: "Run command",
  risk_gate: "Risk gate",
  computer_use: "Computer use",
};

const RUNTIME_APPROVAL_KIND_LABELS = {
  none: "No runtime gate",
  workspace_policy: "Workspace policy",
  external_service: "External service",
  data_export: "Data export",
  destructive: "Destructive",
  shell_sensitive: "Shell sensitive",
} as const;

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
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function isTerminalManagedSessionStatus(status?: ManagedSession["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getManagedSessionEventText(event: ManagedSessionEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  const fromMessage = typeof payload?.message === "string" ? payload.message : undefined;
  const fromContent = typeof payload?.content === "string" ? payload.content : undefined;
  const fromSummary = typeof payload?.summary === "string" ? payload.summary : undefined;
  return fromMessage || fromContent || fromSummary || event.type.replace(/\./g, " ");
}

export function buildDraftFromTemplate(template: AgentTemplate, workspaces: Workspace[]): AgentDraft {
  const defaultWorkspaceId = workspaces[0]?.id || "";
  return {
    templateId: template.id,
    workflowBrief: template.description,
    name: template.name,
    description: template.description,
    icon: template.icon,
    systemPrompt: template.systemPrompt,
    operatingNotes: template.studio?.instructions?.operatingNotes || "",
    executionMode: template.executionMode,
    selectedSkills: template.skills || template.studio?.skills || [],
    selectedMcpServers: template.mcpServers || template.studio?.apps?.mcpServers || [],
    selectedToolFamilies: template.studio?.apps?.allowedToolFamilies || [],
    fileRefs: template.studio?.fileRefs || [],
    memoryConfig: template.studio?.memoryConfig || { mode: "default", sources: ["workspace"] },
    scheduleConfig:
      template.studio?.scheduleConfig || {
        enabled: false,
        mode: "manual",
      },
    channelTargets: template.studio?.channelTargets || [],
    audioSummaryEnabled: template.studio?.audioSummaryConfig?.enabled || false,
    audioSummaryStyle: template.studio?.audioSummaryConfig?.style || "executive-briefing",
    imageGenProfileId: template.studio?.imageGenProfileId,
    sharing: template.studio?.sharing || { visibility: "team" },
    approvalPolicy:
      template.studio?.approvalPolicy || {
        autoApproveReadOnly: true,
        requireApprovalFor: [],
      },
    deployment: template.studio?.deployment || { surfaces: ["chatgpt"] },
    workspaceId: defaultWorkspaceId,
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
    description: agent.description || "",
    icon: studio?.templateId ? "🤖" : "🤖",
    systemPrompt: version?.systemPrompt || "",
    operatingNotes: studio?.instructions?.operatingNotes || "",
    executionMode: version?.executionMode || "solo",
    selectedSkills: studio?.skills || version?.skills || [],
    selectedMcpServers: studio?.apps?.mcpServers || version?.mcpServers || [],
    selectedToolFamilies: studio?.apps?.allowedToolFamilies || [],
    fileRefs: studio?.fileRefs || [],
    memoryConfig: studio?.memoryConfig || { mode: "default", sources: ["workspace"] },
    scheduleConfig:
      studio?.scheduleConfig || {
        enabled: false,
        mode: "manual",
      },
    channelTargets: studio?.channelTargets || [],
    audioSummaryEnabled: studio?.audioSummaryConfig?.enabled || false,
    audioSummaryStyle: studio?.audioSummaryConfig?.style || "executive-briefing",
    imageGenProfileId: studio?.imageGenProfileId,
    sharing: studio?.sharing || { visibility: "team" },
    approvalPolicy:
      studio?.approvalPolicy || {
        autoApproveReadOnly: true,
        requireApprovalFor: [],
      },
    deployment: studio?.deployment || {
      surfaces: (studio?.channelTargets?.length || 0) > 0 ? ["chatgpt", "slack"] : ["chatgpt"],
    },
    workspaceId: environment?.config.workspaceId || workspaces[0]?.id || "",
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
    description: "",
    icon: "🤖",
    systemPrompt: "You are a focused CoWork OS agent.",
    operatingNotes: "",
    executionMode: "solo",
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

export function getApprovalRuntimeMatrix(
  approvalPolicy?: ManagedAgentApprovalPolicy,
): Array<{
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

function getAgentAnalytics(
  agent: ManagedAgent,
  sessions: ManagedSession[],
  studio: ManagedAgentStudioConfig | undefined,
) {
  const agentSessions = sessions.filter((session) => session.agentId === agent.id);
  const completedRuns = agentSessions.filter((session) => session.status === "completed").length;
  const activeRuns = agentSessions.filter(
    (session) => session.status === "pending" || session.status === "running",
  ).length;
  const latestRunAt = agentSessions[0]?.updatedAt;

  return {
    totalRuns: agentSessions.length,
    completedRuns,
    activeRuns,
    successRate:
      agentSessions.length > 0 ? Math.round((completedRuns / agentSessions.length) * 100) : 0,
    latestRunAt,
    slackTargets: studio?.channelTargets?.length || 0,
    approvalActions: studio?.approvalPolicy?.requireApprovalFor?.length || 0,
    surfaces: studio?.deployment?.surfaces || ["chatgpt"],
  };
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
        default:
          return Bot;
      }
  }
}

export function AgentsHubPanel({
  onOpenMissionControl,
  onOpenAgentPersonas,
  onOpenSlackSettings,
}: AgentsHubPanelProps) {
  void onOpenMissionControl;
  void onOpenSlackSettings;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [agentDetails, setAgentDetails] = useState<Record<string, ManagedAgentVersion | undefined>>({});
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [skills, setSkills] = useState<SkillLite[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [slackChannels, setSlackChannels] = useState<ChannelData[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<Array<{ id: string; name: string }>>([]);
  const [imageProfiles, setImageProfiles] = useState<ImageGenProfile[]>([]);
  const [studioDraft, setStudioDraft] = useState<AgentDraft | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [audioResults, setAudioResults] = useState<Record<string, AudioSummaryResult>>({});
  const [agentRoutines, setAgentRoutines] = useState<Record<string, ManagedAgentRoutineRecord[]>>({});
  const [agentInsights, setAgentInsights] = useState<Record<string, ManagedAgentInsights>>({});
  const [agentAudit, setAgentAudit] = useState<Record<string, ManagedAgentAuditEntry[]>>({});
  const [slackHealth, setSlackHealth] = useState<Record<string, ManagedAgentSlackDeploymentHealth>>({});
  const [sessionWorkpapers, setSessionWorkpapers] = useState<Record<string, ManagedSessionWorkpaper>>(
    {},
  );
  const [runtimeCatalogs, setRuntimeCatalogs] = useState<
    Record<string, ManagedAgentRuntimeToolCatalog | null | undefined>
  >({});
  const [runtimeCatalogErrors, setRuntimeCatalogErrors] = useState<Record<string, string>>({});
  const [runtimeCatalogLoadingId, setRuntimeCatalogLoadingId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState<AgentsLibraryTab>("library");
  const [workflowComposer, setWorkflowComposer] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDescription, setNewProfileDescription] = useState("");
  const [workspaceMemberships, setWorkspaceMemberships] = useState<AgentWorkspaceMembership[]>([]);
  const [workspacePermissions, setWorkspacePermissions] = useState<
    Record<string, AgentWorkspacePermissionSnapshot>
  >({});
  const [agentRoles, setAgentRoles] = useState<Any[]>([]);
  const [automationProfiles, setAutomationProfiles] = useState<Any[]>([]);
  const [conversionPanel, setConversionPanel] = useState<ConversionPanel>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showcaseIndex, setShowcaseIndex] = useState(0);
  const [isCreateComposerOpen, setIsCreateComposerOpen] = useState(false);
  const [studioTestPrompt, setStudioTestPrompt] = useState("");
  const [studioTestSessionId, setStudioTestSessionId] = useState<string | null>(null);
  const [studioSessionEvents, setStudioSessionEvents] = useState<Record<string, ManagedSessionEvent[]>>({});
  const [studioTestRunning, setStudioTestRunning] = useState(false);
  const [studioTestError, setStudioTestError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [
        managedAgents,
        managedSessions,
        agentTemplates,
        availableSkills,
        availableWorkspaces,
        gatewayChannels,
        imageGenProfiles,
        managedEnvironments,
        mcpSettings,
        legacyAgentRoles,
        legacyAutomationProfiles,
        memberships,
      ] = await Promise.all([
        window.electronAPI.listManagedAgents(),
        window.electronAPI.listManagedSessions({ limit: 40 }),
        window.electronAPI.listAgentTemplates(),
        window.electronAPI.listSkills(),
        window.electronAPI.listWorkspaces(),
        window.electronAPI.getGatewayChannels(),
        window.electronAPI.listImageGenProfiles(),
        window.electronAPI.listManagedEnvironments(),
        window.electronAPI.getMCPSettings(),
        window.electronAPI.getAgentRoles(true),
        window.electronAPI.listAutomationProfiles(),
        window.electronAPI.listAgentWorkspaceMemberships(),
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
      setAgents(managedAgents);
      setSessions(managedSessions);
      setTemplates(agentTemplates);
      setSkills((availableSkills || []) as SkillLite[]);
      setWorkspaces(availableWorkspaces);
      setEnvironments(managedEnvironments);
      setSlackChannels((gatewayChannels || []).filter((channel) => channel.type === "slack"));
      setImageProfiles(imageGenProfiles);
      setAgentDetails(Object.fromEntries(detailEntries));
      setAgentRoutines(Object.fromEntries(routineEntries));
      setSelectedAgentId((current) => current || managedAgents[0]?.id || null);
      setRuntimeCatalogs({});
      setRuntimeCatalogErrors({});
      setRuntimeCatalogLoadingId(null);
      setAgentRoles(legacyAgentRoles || []);
      setAutomationProfiles(legacyAutomationProfiles || []);
      setWorkspaceMemberships(memberships || []);

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
        const version = existing ? detailEntries.find(([id]) => id === existing.id)?.[1] : undefined;
        const routines = existing ? routineEntries.find(([id]) => id === existing.id)?.[1] || [] : [];
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
      sessions.find((session) => session.agentId === selectedAgentId)?.id ||
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
        const currentSession = session || sessions.find((entry) => entry.id === studioTestSessionId);
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
    const ordered = sessions.map((session) => session.agentId);
    return Array.from(new Set(ordered));
  }, [sessions]);

  const recentlyUsedAgents = recentAgentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is ManagedAgent => Boolean(agent));
  const scheduledAgents = agents.filter((agent) => {
    const studio = getStudioConfig(agentDetails[agent.id]);
    return !!studio?.scheduleConfig?.enabled;
  });
  const sharedAgents = agents.filter((agent) => {
    const visibility = getStudioConfig(agentDetails[agent.id])?.sharing?.visibility;
    return visibility === "team" || visibility === "workspace";
  });
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
      case "shared":
        return sharedAgents;
      case "scheduled":
        return scheduledAgents;
      case "templates":
        return [];
      default:
        return agents;
    }
  }, [agents, libraryTab, recentlyUsedAgents, scheduledAgents, sharedAgents]);

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
    setStudioDraft(buildDraftFromWorkflowBrief(trimmed, templates, workspaces));
  };

  const handleOpenCreateComposer = () => {
    setIsCreateComposerOpen(true);
  };

  const persistStudioDraft = async (): Promise<PersistStudioDraftResult | null> => {
    if (!studioDraft) return null;
    const environmentPayload = {
      name: `${studioDraft.name} Environment`,
      config: {
        workspaceId: studioDraft.workspaceId,
        enableShell: studioDraft.enableShell,
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
      instructions: {
        operatingNotes: studioDraft.operatingNotes,
      },
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
    };

    let savedAgentId = studioDraft.agentId;
    if (studioDraft.agentId) {
      await window.electronAPI.updateManagedAgent({
        agentId: studioDraft.agentId,
        name: studioDraft.name,
        description: studioDraft.description,
        systemPrompt: studioDraft.systemPrompt,
        executionMode: studioDraft.executionMode,
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

    const [detail, refreshedRoutines, refreshedEnvironments, refreshedWorkspaces] = await Promise.all([
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
    const prompt = studioTestPrompt.trim() || `Run the configured workflow for ${studioDraft.name}.`;
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

  const handleRunAgent = async (agent: ManagedAgent) => {
    if (agent.status === "suspended") {
      setError("This agent is suspended. Publish it again before running.");
      return;
    }
    const detail = await window.electronAPI.getManagedAgent(agent.id);
    const studio = getStudioConfig(detail?.currentVersion);
    const environmentId = studio?.defaultEnvironmentId;
    if (!environmentId) {
      setError("This agent does not have a default environment yet. Edit it and save first.");
      return;
    }
    await window.electronAPI.createManagedSession({
      agentId: agent.id,
      environmentId,
      title: `${agent.name} run`,
      initialEvent: {
        type: "user.message",
        content: [{ type: "text", text: `Run the configured workflow for ${agent.name}.` }],
      },
    });
    await loadData();
  };

  const handleGenerateAudio = async (session: ManagedSession) => {
    try {
      const result = await window.electronAPI.generateManagedSessionAudioSummary(session.id);
      setAudioResults((current) => ({ ...current, [session.id]: result }));
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : "Failed to generate audio summary");
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
          ["user.message", "assistant.message", "status.changed", "input.requested"].includes(event.type),
        )
      : [];
    const studioTestWorkpaper = studioTestSessionId ? sessionWorkpapers[studioTestSessionId] : undefined;
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
                  {sessionStatusLabel(studioTestSession)} · {formatRelative(studioTestSession.updatedAt)}
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
                            {isAssistant ? "Agent" : isUser ? "You" : event.type.replace(/\./g, " ")}
                          </span>
                          <p>{getManagedSessionEventText(event)}</p>
                        </div>
                      );
                    })
                  ) : (
                    <div className="agents-studio-test-empty">
                      <strong>Test the current draft</strong>
                      <p>
                        Save the agent and run a prompt here to verify instructions, tools, approvals,
                        and deployment posture before publishing.
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
                {studioTestError ? <div className="agents-error-banner">{studioTestError}</div> : null}
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
                    {studioDraft.selectedToolFamilies.length} tool families · {studioDraft.selectedSkills.length} skills
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
                      ? studioDraft.fileRefs.map((file) => file.name).slice(0, 3).join(", ")
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
              {studioDraft.fileRefs.length === 0 && <span className="agents-empty-note">No files attached yet.</span>}
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
                <div key={routine.id || `${routine.trigger.type}-${index}`} className="agents-routine-card">
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
                                      event.target.value as ManagedAgentRoutineTriggerConfig["type"],
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
                                      trigger: { ...entry.trigger, channelType: event.target.value },
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
                                      trigger: { ...entry.trigger, connectorId: event.target.value },
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
                          routines: studioDraft.routines.filter((_, entryIndex) => entryIndex !== index),
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
                          : [...(studioDraft.deployment.surfaces || []), surface.id as "chatgpt" | "slack"],
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
                        channelTargets: studioDraft.channelTargets.filter((entry) => entry.id !== target.id),
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
                        requireApprovalFor: (studioDraft.approvalPolicy.requireApprovalFor || []).includes(
                          action,
                        )
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
                          {row.behavior === "require_approval" ? "Requires approval" : "Auto-approves"}
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
            <div className="agents-checkbox-row">
              <label className="agents-checkbox">
                <input
                  type="checkbox"
                  checked={studioDraft.enableShell}
                  onChange={(event) =>
                    setStudioDraft({ ...studioDraft, enableShell: event.target.checked })
                  }
                />
                <span>Shell</span>
              </label>
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
          <button className="agents-link-btn agents-create-screen-back" onClick={() => setIsCreateComposerOpen(false)}>
            <ArrowLeft size={18} />
            Back
          </button>
          <button
            className="agents-link-btn agents-create-screen-blank"
            onClick={() => {
              setIsCreateComposerOpen(false);
              setStudioDraft(makeBlankDraft(workspaces));
            }}
          >
            Start blank
          </button>
        </div>

        <section className="agents-create-screen-hero">
          <div className="agents-create-screen-icon">
            <Bot size={34} />
          </div>
          <h1>Build a new agent</h1>
          <div className="agents-create-screen-input">
            <div className="agents-create-screen-input-leading">
              <Plus size={18} />
            </div>
            <input
              value={workflowComposer}
              placeholder="Describe what it should do"
              onChange={(event) => setWorkflowComposer(event.target.value)}
            />
            <button
              className="agents-create-screen-submit"
              onClick={handleDraftFromWorkflow}
              disabled={!workflowComposer.trim()}
              aria-label="Create agent draft"
            >
              <ArrowUp size={18} />
            </button>
          </div>

          <div className="agents-create-screen-suggestions">
            {quickCreateTemplates.map((template) => {
              const TemplateGlyph = getTemplateGlyph(template);
              return (
                <button
                  key={template.id}
                  className="agents-create-screen-row"
                  onClick={() => {
                    setIsCreateComposerOpen(false);
                    setStudioDraft(buildDraftFromTemplate(template, workspaces));
                  }}
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
        </section>
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
            <div className="agents-showcase-message">{activeShowcaseTemplate.systemPrompt.split(".")[0]}</div>
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
            {showcaseSideTemplates[0] && (() => {
              const template = showcaseSideTemplates[0];
              const TemplateGlyph = getTemplateGlyph(template);
              return (
                <button
                  key={template.id}
                  className="agents-showcase-side-card"
                  onClick={() => setStudioDraft(buildDraftFromTemplate(template, workspaces))}
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
              <span>Slack</span>
              <span>{activeShowcaseTemplate.studio?.scheduleConfig?.enabled ? "Scheduled" : "On demand"}</span>
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
            <span>Bring legacy assets into the managed-agent model without deleting the originals.</span>
          </div>
          <div className="agents-list">
            {(conversionPanel === "agent-role" ? agentRoles : automationProfiles)
              .slice(0, 8)
              .map((entry) => (
                <div key={entry.id} className="agents-list-row">
                  <div>
                    <strong>{entry.displayName || entry.id}</strong>
                    <span>{entry.description || entry.profile || "Legacy configuration"}</span>
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
          <strong>{agents.length}</strong>
        </div>
        <div className="agents-metric-pill">
          <span>Total runs</span>
          <strong>{sessions.length}</strong>
        </div>
        <div className="agents-metric-pill">
          <span>Slack deployments</span>
          <strong>
            {agents.reduce(
              (count, agent) => count + (getStudioConfig(agentDetails[agent.id])?.channelTargets?.length || 0),
              0,
            )}
          </strong>
        </div>
        <div className="agents-metric-pill">
          <span>Scheduled</span>
          <strong>{scheduledAgents.length}</strong>
        </div>
      </section>

      <section className="agents-library-surface">
        <div className="agents-library-header">
          <div className="agents-section-head agents-section-head-stack">
            <h2>Shared workflow library</h2>
            <span>Templates, recent runs, and reusable operators for the workspace.</span>
          </div>
          <div className="agents-tab-row agents-tab-row-primary">
            {[
              ["recent", "Recently used"],
              ["library", "Built by me"],
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
          <div className="agents-tab-row agents-tab-row-secondary">
            {[
              ["shared", "Shared"],
              ["scheduled", "Scheduled"],
              ["templates", "Templates"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`agents-tab subtle ${libraryTab === id ? "active" : ""}`}
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
              return (
                <button
                  key={template.id}
                  className="agents-template-card"
                  style={{ ["--template-accent" as string]: template.color }}
                  onClick={() => setStudioDraft(buildDraftFromTemplate(template, workspaces))}
                >
                  <span className="agents-template-icon">
                    <TemplateGlyph size={22} />
                  </span>
                  <div>
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : libraryAgents.length > 0 ? (
          <div className="agents-library-grid">
            {libraryAgents.slice(0, 6).map((agent, index) => {
              const studio = getStudioConfig(agentDetails[agent.id]);
              const analytics = getAgentAnalytics(agent, sessions, studio);
              const TemplateGlyph = studio?.templateId
                ? getTemplateGlyph(
                    templates.find((entry) => entry.id === studio.templateId) || {
                      id: studio.templateId,
                      name: studio.templateId,
                      description: "",
                      icon: "",
                      color: "#1570ef",
                      category: "operations",
                      systemPrompt: "",
                      executionMode: "solo",
                    },
                  )
                : Bot;
              return (
                <button
                  key={agent.id}
                  className={`agents-library-card ${index === 0 ? "feature" : ""}`}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <div className="agents-library-card-top">
                    <span className="agents-library-card-icon">
                      <TemplateGlyph size={index === 0 ? 20 : 18} />
                    </span>
                    <span className="agents-library-card-status">{agent.status}</span>
                  </div>
                  <div className="agents-library-card-copy">
                    <strong>{agent.name}</strong>
                    <p>{agent.description || studio?.workflowBrief || "No description yet."}</p>
                  </div>
                  <div className="agents-library-card-meta">
                    <span>{studio?.sharing?.ownerLabel || studio?.sharing?.visibility || "team"}</span>
                    <span>{analytics.latestRunAt ? formatRelative(analytics.latestRunAt) : "No runs yet"}</span>
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
        <div className="agents-governance-item">
          <BarChart3 size={16} />
          <span>{workspaceMemberships.length} workspace membership rules loaded</span>
        </div>
      </section>

      <section className="agents-detail-surface">
        <div className="agents-section-head">
          <h2>Agent detail</h2>
          <span>Deployment, controls, analytics, and recent runs.</span>
        </div>
        {selectedAgent ? (
          <div className="agents-detail-grid">
            <div className="agents-detail-card">
              {(() => {
                const studio = getStudioConfig(agentDetails[selectedAgent.id]);
                const fallbackAnalytics = getAgentAnalytics(selectedAgent, sessions, studio);
                const insights = agentInsights[selectedAgent.id];
                const analytics = insights
                  ? {
                      ...fallbackAnalytics,
                      totalRuns: insights.totalRuns,
                      successRate:
                        insights.totalRuns > 0
                          ? Math.round((insights.successCount / insights.totalRuns) * 100)
                          : 0,
                    }
                  : fallbackAnalytics;
                const approvalPreview = getEffectiveApprovalPreview(
                  studio?.approvalPolicy,
                  studio?.deployment,
                );
                const approvalRuntimeMatrix = getApprovalRuntimeMatrix(studio?.approvalPolicy);
                const runtimeCatalog = runtimeCatalogs[selectedAgent.id];
                const runtimeCatalogError = runtimeCatalogErrors[selectedAgent.id];
                const runtimeCatalogLoading = runtimeCatalogLoadingId === selectedAgent.id;
                const chatgptTools = sortRuntimeToolCatalogEntries(runtimeCatalog?.chatgpt || []);
                const slackTools = sortRuntimeToolCatalogEntries(runtimeCatalog?.slack || []);
                const linkedRoutines = agentRoutines[selectedAgent.id] || [];
                const deploymentHealth = normalizeSlackDeploymentHealth(
                  slackHealth[selectedAgent.id],
                  getSlackDeploymentHealth(studio, slackChannels, selectedAgent.id),
                );
                const permissions = selectedAgentWorkspaceId
                  ? workspacePermissions[selectedAgentWorkspaceId]
                  : undefined;
                const memberships = selectedAgentWorkspaceId
                  ? workspaceMemberships.filter(
                      (membership) => membership.workspaceId === selectedAgentWorkspaceId,
                    )
                  : [];
                return (
                  <>
              <div className="agents-detail-header">
                <div>
                  <h3>{selectedAgent.name}</h3>
                  <p>{selectedAgent.description || "No description yet."}</p>
                </div>
                <div className="agents-row-actions">
                  <button
                    className="agents-secondary-btn"
                    onClick={() =>
                      setStudioDraft(
                        buildDraftFromAgent(
                          selectedAgent,
                          agentDetails[selectedAgent.id],
                          environments,
                          workspaces,
                          linkedRoutines,
                        ),
                      )
                    }
                    disabled={permissions ? !permissions.canEditDrafts : false}
                  >
                    <Wrench size={16} />
                    Edit
                  </button>
                  <button
                    className="agents-secondary-btn"
                    onClick={() => void handlePublishAgent(selectedAgent.id)}
                    disabled={
                      selectedAgent.status === "active" || (permissions ? !permissions.canPublishAgents : false)
                    }
                  >
                    Publish
                  </button>
                  <button
                    className="agents-secondary-btn"
                    onClick={() => void handleSuspendAgent(selectedAgent.id)}
                    disabled={
                      selectedAgent.status === "suspended" ||
                      (permissions ? !permissions.canPublishAgents : false)
                    }
                  >
                    Suspend
                  </button>
                  <button
                    className="agents-primary-btn"
                    onClick={() => handleRunAgent(selectedAgent)}
                    disabled={
                      selectedAgent.status === "suspended" || (permissions ? !permissions.canRunAgents : false)
                    }
                  >
                    <Play size={16} />
                    Run now
                  </button>
                </div>
              </div>

              {studio?.workflowBrief && (
                <div className="agents-note-card">
                  <strong>Workflow</strong>
                  <p>{studio.workflowBrief}</p>
                </div>
              )}

              <div className="agents-detail-meta">
                <div>
                  <span>Template</span>
                  <strong>{studio?.templateId || "Blank"}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{selectedAgent.status}</strong>
                </div>
                <div>
                  <span>Total runs</span>
                  <strong>{analytics.totalRuns}</strong>
                </div>
                <div>
                  <span>Success rate</span>
                  <strong>{analytics.successRate}%</strong>
                </div>
                <div>
                  <span>Active runs</span>
                  <strong>{analytics.activeRuns}</strong>
                </div>
              </div>

              <div className="agents-detail-meta agents-detail-meta-secondary">
                <div>
                  <span>Deploys to</span>
                  <strong>{analytics.surfaces.join(", ")}</strong>
                </div>
                <div>
                  <span>Slack targets</span>
                  <strong>{analytics.slackTargets}</strong>
                </div>
                <div>
                  <span>Approvals</span>
                  <strong>{analytics.approvalActions || 0}</strong>
                </div>
                <div>
                  <span>Shared as</span>
                  <strong>{studio?.sharing?.visibility || "team"}</strong>
                </div>
                <div>
                  <span>Owner</span>
                  <strong>{studio?.sharing?.ownerLabel || "Unassigned"}</strong>
                </div>
                <div>
                  <span>Latest run</span>
                  <strong>{analytics.latestRunAt ? formatRelative(analytics.latestRunAt) : "No runs yet"}</strong>
                </div>
                <div>
                  <span>Approvals resolved</span>
                  <strong>{insights ? `${insights.approvalRate}%` : "N/A"}</strong>
                </div>
                <div>
                  <span>Audio summary</span>
                  <strong>
                    {studio?.audioSummaryConfig?.enabled ? "Enabled" : "Off"}
                  </strong>
                </div>
                <div>
                  <span>Auto-approve read-only</span>
                  <strong>{studio?.approvalPolicy?.autoApproveReadOnly === false ? "No" : "Yes"}</strong>
                </div>
              </div>

              <div className="agents-surface-preview-grid agents-surface-preview-grid-detail">
                <div className="agents-surface-preview-card">
                  <strong>Effective approvals</strong>
                  <p>{approvalPreview.sharedSummary}</p>
                  <p className="agents-surface-preview-foot">
                    Auto-approved:{" "}
                    {approvalPreview.autoApproved.length > 0
                      ? approvalPreview.autoApproved.join(", ")
                      : "none"}
                  </p>
                </div>
                <div className="agents-surface-preview-card">
                  <strong>CoWork OS</strong>
                  <p>{approvalPreview.chatgptSummary}</p>
                </div>
                <div className="agents-surface-preview-card">
                  <strong>Slack</strong>
                  <p>{approvalPreview.slackSummary}</p>
                </div>
              </div>

              <div className="agents-approval-preview-card agents-approval-matrix-card agents-approval-matrix-card-detail">
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
                          {row.behavior === "require_approval" ? "Requires approval" : "Auto-approves"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="agents-note-card">
                <strong>Governance and deployment</strong>
                <p>
                  Workspace role: {permissions?.role || "loading"} · Slack channels using agent:{" "}
                  {deploymentHealth.targets.length} · Connected: {deploymentHealth.connectedCount} · Misconfigured:{" "}
                  {deploymentHealth.misconfiguredCount}
                </p>
              </div>

              <div className="agents-approval-preview-card">
                <strong>Workspace access</strong>
                <div className="agents-list">
                  {memberships.map((membership) => (
                    <div key={membership.id} className="agents-list-row">
                      <div>
                        <strong>{membership.principalId}</strong>
                        <span>{membership.role}</span>
                      </div>
                      {permissions?.canManageMemberships ? (
                        <select
                          value={membership.role}
                          onChange={(event) =>
                            void window.electronAPI
                              .updateAgentWorkspaceMembership({
                                workspaceId: membership.workspaceId,
                                principalId: membership.principalId,
                                role: event.target.value as AgentWorkspaceMembership["role"],
                              })
                              .then((updated) =>
                                setWorkspaceMemberships((current) =>
                                  current.map((entry) => (entry.id === updated.id ? updated : entry)),
                                ),
                              )
                          }
                        >
                          <option value="viewer">viewer</option>
                          <option value="operator">operator</option>
                          <option value="builder">builder</option>
                          <option value="publisher">publisher</option>
                          <option value="admin">admin</option>
                        </select>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="agents-approval-preview-card">
                <strong>Linked routines</strong>
                <div className="agents-list">
                  {linkedRoutines.map((routine) => (
                    <div key={routine.id} className="agents-list-row">
                      <div>
                        <strong>{routine.name}</strong>
                        <span>
                          {routine.trigger.type.replace(/_/g, " ")} · {routine.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                      <code>{routine.trigger.type}</code>
                    </div>
                  ))}
                  {linkedRoutines.length === 0 ? (
                    <span className="agents-empty-note">No linked routines yet.</span>
                  ) : null}
                </div>
              </div>

              {insights ? (
                <div className="agents-approval-preview-card">
                  <strong>Insights</strong>
                  <div className="agents-detail-meta agents-detail-meta-secondary">
                    <div>
                      <span>Unique users</span>
                      <strong>{insights.uniqueUsers}</strong>
                    </div>
                    <div>
                      <span>Failures</span>
                      <strong>{insights.failureCount}</strong>
                    </div>
                    <div>
                      <span>Avg completion</span>
                      <strong>
                        {insights.averageCompletionTimeMs > 0
                          ? `${Math.round(insights.averageCompletionTimeMs / 60000)}m`
                          : "N/A"}
                      </strong>
                    </div>
                  </div>
                  <div className="agents-surface-preview-grid agents-surface-preview-grid-detail">
                    <div className="agents-surface-preview-card">
                      <strong>Top tools</strong>
                      <p>
                        {insights.topTools.length > 0
                          ? insights.topTools.map((tool) => `${tool.toolName} (${tool.count})`).join(", ")
                          : "No tool usage yet."}
                      </p>
                    </div>
                    <div className="agents-surface-preview-card">
                      <strong>Trigger sources</strong>
                      <p>
                        {insights.triggerBreakdown.length > 0
                          ? insights.triggerBreakdown.map((entry) => `${entry.key} (${entry.count})`).join(", ")
                          : "No trigger history yet."}
                      </p>
                    </div>
                    <div className="agents-surface-preview-card">
                      <strong>Recent errors</strong>
                      <p>
                        {insights.recentErrors.length > 0
                          ? insights.recentErrors.map((entry) => entry.message).join(" · ")
                          : "No recent errors."}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="agents-approval-preview-card">
                <strong>Slack deployment health</strong>
                <p>
                  {deploymentHealth.lastSuccessfulRoutedRunAt
                    ? `Last successful routed run ${formatRelative(deploymentHealth.lastSuccessfulRoutedRunAt)}.`
                    : "No successful routed Slack run recorded yet."}
                </p>
                <p>
                  {deploymentHealth.lastDeploymentError
                    ? `Latest deployment issue: ${deploymentHealth.lastDeploymentError}`
                    : "No deployment errors currently recorded."}
                </p>
                <div className="agents-list">
                  {deploymentHealth.targets.map((target) => (
                    <div key={target.channelId} className="agents-list-row">
                      <div>
                        <strong>{target.channelName}</strong>
                        <span>
                          {target.status} · {target.securityMode || "pairing"} ·{" "}
                          {target.progressRelayMode || "minimal"}
                        </span>
                      </div>
                      <span>{target.misconfigured ? "Needs attention" : "Healthy"}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="agents-approval-preview-card agents-runtime-catalog-card">
                <strong>Live runtime tool catalog</strong>
                <p className="agents-runtime-catalog-copy">
                  This list comes from the real runtime registry after workspace permissions,
                  managed-environment limits, tool families, MCP allowlists, and deployment
                  surface rules are applied.
                </p>
                {runtimeCatalogLoading ? (
                  <div className="agents-empty-note">Loading runtime tools...</div>
                ) : runtimeCatalogError ? (
                  <div className="agents-empty-note">{runtimeCatalogError}</div>
                ) : (
                  <div className="agents-runtime-surface-grid">
                    {[
                      {
                        key: "chatgpt",
                        title: "CoWork OS surface",
                        enabled: (studio?.deployment?.surfaces || ["chatgpt"]).includes("chatgpt"),
                        tools: chatgptTools,
                      },
                      {
                        key: "slack",
                        title: "Slack surface",
                        enabled: (studio?.deployment?.surfaces || []).includes("slack"),
                        tools: slackTools,
                      },
                    ].map((surface) => (
                      <div key={surface.key} className="agents-runtime-surface-card">
                        <div className="agents-runtime-surface-head">
                          <strong>{surface.title}</strong>
                          <span>
                            {surface.enabled ? `${surface.tools.length} tools` : "Deployment off"}
                          </span>
                        </div>
                        {!surface.enabled ? (
                          <div className="agents-empty-note">
                            Enable this deployment surface to publish the agent there.
                          </div>
                        ) : surface.tools.length === 0 ? (
                          <div className="agents-empty-note">
                            No tools are currently exposed on this surface.
                          </div>
                        ) : (
                          <div className="agents-runtime-tool-list">
                            {surface.tools.slice(0, 18).map((tool) => (
                              <div key={`${surface.key}:${tool.name}`} className="agents-runtime-tool-row">
                                <div>
                                  <div className="agents-runtime-tool-title">
                                    <code>{tool.name}</code>
                                    {tool.family ? <span>{tool.family}</span> : null}
                                    {tool.mcpServerName ? <span>{tool.mcpServerName}</span> : null}
                                  </div>
                                  <p>{tool.description}</p>
                                </div>
                                <div className="agents-runtime-tool-meta">
                                  <span
                                    className={`agents-runtime-pill ${
                                      tool.approvalBehavior === "require_approval"
                                        ? "danger"
                                        : tool.approvalBehavior === "auto_approve"
                                          ? "safe"
                                          : ""
                                    }`}
                                  >
                                    {tool.approvalBehavior === "require_approval"
                                      ? "Requires approval"
                                      : tool.approvalBehavior === "auto_approve"
                                        ? "Auto-approves"
                                        : tool.approvalBehavior === "workspace_policy"
                                          ? "Workspace policy"
                                          : "No approval gate"}
                                  </span>
                                  <span className="agents-runtime-meta-line">
                                    Runtime kind:{" "}
                                    {RUNTIME_APPROVAL_KIND_LABELS[tool.approvalKind]}
                                  </span>
                                  <span className="agents-runtime-meta-line">
                                    Approval type:{" "}
                                    {tool.approvalType
                                      ? APPROVAL_TYPE_LABELS[tool.approvalType]
                                      : "None"}
                                  </span>
                                  <span className="agents-runtime-meta-line">
                                    Side effects: {tool.sideEffectLevel}
                                  </span>
                                </div>
                              </div>
                            ))}
                            {surface.tools.length > 18 ? (
                              <div className="agents-empty-note">
                                Showing the first 18 tools by approval severity.
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
                  </>
                );
              })()}
            </div>

            <div className="agents-detail-card">
              <div className="agents-section-head">
                <h3>Recent runs</h3>
                <span>Managed sessions for this agent</span>
              </div>
              <div className="agents-list">
                {sessions
                  .filter((session) => session.agentId === selectedAgent.id)
                  .slice(0, 6)
                  .map((session) => (
                    <div key={session.id} className="agents-session-row">
                      <div>
                        <strong>{session.title}</strong>
                        <span>
                          {sessionStatusLabel(session)} · {formatRelative(session.updatedAt)}
                        </span>
                      </div>
                      <div className="agents-row-actions">
                        <button
                          className="agents-link-btn"
                          onClick={() => {
                            setSelectedSessionId(session.id);
                            void window.electronAPI
                              .getManagedSessionWorkpaper(session.id)
                              .then((workpaper) =>
                                setSessionWorkpapers((current) => ({
                                  ...current,
                                  [session.id]: workpaper,
                                })),
                              );
                          }}
                        >
                          Workpaper
                        </button>
                        <button
                          className="agents-link-btn"
                          onClick={() => handleGenerateAudio(session)}
                        >
                          <Volume2 size={16} />
                          Audio
                        </button>
                        <button
                          className="agents-link-btn"
                          onClick={() => void window.electronAPI.resumeManagedSession(session.id)}
                        >
                          Resume
                        </button>
                      </div>
                      {audioResults[session.id]?.playbackUrl && (
                        <audio
                          controls
                          src={audioResults[session.id].playbackUrl}
                          className="agents-audio-player"
                        />
                      )}
                    </div>
                  ))}
              </div>
              {selectedSessionId && sessionWorkpapers[selectedSessionId] ? (
                <div className="agents-approval-preview-card">
                  <strong>Run workpaper</strong>
                  <p>{sessionWorkpapers[selectedSessionId].summary}</p>
                  <div className="agents-list">
                    <div className="agents-list-row">
                      <div>
                        <strong>Decisions</strong>
                        <span>
                          {sessionWorkpapers[selectedSessionId].decisions.length > 0
                            ? sessionWorkpapers[selectedSessionId].decisions
                                .map((entry) => entry.summary)
                                .join(" · ")
                            : "No decision trail yet."}
                        </span>
                      </div>
                    </div>
                    <div className="agents-list-row">
                      <div>
                        <strong>Approvals</strong>
                        <span>
                          {sessionWorkpapers[selectedSessionId].approvals.length > 0
                            ? sessionWorkpapers[selectedSessionId].approvals
                                .map((entry) => `${entry.status}: ${entry.summary}`)
                                .join(" · ")
                            : "No approval requests."}
                        </span>
                      </div>
                    </div>
                    <div className="agents-list-row">
                      <div>
                        <strong>Artifacts</strong>
                        <span>
                          {sessionWorkpapers[selectedSessionId].artifacts.length > 0
                            ? sessionWorkpapers[selectedSessionId].artifacts
                                .map((entry) => entry.label)
                                .join(", ")
                            : "No artifacts recorded."}
                        </span>
                      </div>
                    </div>
                    <div className="agents-list-row">
                      <div>
                        <strong>Audit trail</strong>
                        <span>
                          {(agentAudit[selectedAgent.id] || []).length > 0
                            ? (agentAudit[selectedAgent.id] || [])
                                .map((entry) => entry.summary)
                                .join(" · ")
                            : "No audit history yet."}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="agents-empty-state">Create or select an agent to see the detail view.</div>
        )}
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
      }
      .agents-panel-loading,
      .agents-empty-state {
        padding: 32px;
        color: var(--agents-muted);
      }
      .agents-create-screen-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
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
        letter-spacing: -0.04em;
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
        margin-bottom: 22px;
      }
      .agents-library-header {
        display: grid;
        gap: 10px;
        margin-bottom: 18px;
      }
      .agents-tab-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .agents-tab {
        border: 1px solid var(--agents-border);
        background: rgba(255, 255, 255, 0.88);
        color: var(--agents-muted);
        padding: 11px 16px;
        border-radius: 999px;
        cursor: pointer;
        transition:
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          border-color 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          background 0.28s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-tab.active {
        color: var(--agents-text);
        border-color: rgba(17, 24, 39, 0.14);
        background: #ffffff;
        box-shadow: 0 10px 22px -20px rgba(15, 23, 42, 0.22);
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
        grid-template-columns: minmax(0, 1.16fr) minmax(0, 0.84fr);
        gap: 16px;
      }
      .agents-library-card {
        display: grid;
        gap: 16px;
        padding: 22px;
        text-align: left;
        border-radius: 28px;
        border: 1px solid var(--agents-border);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 255, 255, 0.78)),
          rgba(255, 255, 255, 0.88);
        box-shadow: 0 18px 42px -30px rgba(15, 23, 42, 0.16);
        transition:
          transform 0.32s cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 0.32s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .agents-library-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 28px 54px -36px rgba(15, 23, 42, 0.22);
      }
      .agents-library-card.feature {
        grid-row: span 2;
        min-height: 260px;
        align-content: space-between;
        background:
          radial-gradient(circle at top right, rgba(21, 112, 239, 0.12), transparent 28%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.86));
      }
      .agents-library-card-top,
      .agents-library-card-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .agents-library-card-status {
        border-radius: 999px;
        padding: 8px 12px;
        background: rgba(17, 24, 39, 0.05);
        color: var(--agents-muted);
        font-size: 0.78rem;
        text-transform: capitalize;
      }
      .agents-library-card-copy strong {
        display: block;
        font-size: 1.18rem;
        line-height: 1.15;
        letter-spacing: -0.02em;
        font-weight: 500;
      }
      .agents-library-card-copy p {
        margin: 10px 0 0;
        color: var(--agents-muted);
        line-height: 1.58;
      }
      .agents-library-card-meta span {
        color: var(--agents-muted);
        font-size: 0.82rem;
      }
      .agents-template-grid,
      .agents-chip-grid {
        display: grid;
        gap: 12px;
      }
      .agents-template-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .agents-template-card {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        padding: 22px;
        border-radius: 26px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.84)),
          radial-gradient(circle at top left, color-mix(in srgb, var(--template-accent), transparent 78%), transparent 42%);
        color: inherit;
        text-align: left;
        border: 1px solid var(--agents-border);
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
        .agents-studio-test-compose {
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
        .agents-showcase-core-card,
        .agents-showcase-side-card,
        .agents-showcase-message {
          align-self: stretch;
          max-width: none;
          margin-right: 0;
        }
      }
      @media (max-width: 768px) {
        .agents-panel,
        .agents-studio {
          padding: 18px;
        }
        .agents-create-screen-bar {
          align-items: flex-start;
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
      }
    `}</style>
  );
}
