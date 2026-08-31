import { randomUUID } from "crypto";
import type {
  AgentBuilderConnectionRequirement,
  AgentBuilderPlan,
  AgentBuilderPlanRequest,
  AgentBuilderRoutinePlan,
  AgentBuilderSelectionOption,
  AgentBuilderSelectionRequirement,
  AgentRole,
  AgentStarterPrompt,
  AgentTemplate,
  CustomSkill,
  ManagedAgentApprovalPolicy,
  ManagedAgentMemoryConfig,
  ManagedAgentScheduleConfig,
  ManagedAgentToolFamily,
  Workspace,
} from "../../shared/types";
import { LLMProviderFactory } from "../agent/llm";
import type { LLMProvider } from "../agent/llm/types";
import type { LoadedPlugin } from "../extensions/types";
import type { MCPServerConfig } from "../mcp/types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";

type AgentBuilderChannelInventoryEntry = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: string;
};

const VALID_TOOL_FAMILIES = new Set<ManagedAgentToolFamily>([
  "browser",
  "computer-use",
  "files",
  "memory",
  "documents",
  "images",
  "search",
  "communication",
]);

const DEFAULT_APPROVAL_POLICY: ManagedAgentApprovalPolicy = {
  autoApproveReadOnly: true,
  requireApprovalFor: [
    "send email",
    "post message",
    "edit spreadsheet",
    "create calendar event",
    "file external ticket",
  ],
};

const DEFAULT_MEMORY_CONFIG: ManagedAgentMemoryConfig = {
  mode: "default",
  sources: ["workspace"],
};

type IntegrationKey = "slack" | "gmail" | "calendar" | "github" | "linear" | "notion" | "drive";

type IntegrationDescriptor = {
  key: IntegrationKey;
  label: string;
  explicitKeywords: string[];
  genericKeywords: string[];
  genericLabel: string;
  serverAliases: string[];
  toolFamilies: ManagedAgentToolFamily[];
};

const INTEGRATIONS: IntegrationDescriptor[] = [
  {
    key: "slack",
    label: "Slack",
    explicitKeywords: ["slack"],
    genericKeywords: ["channel", "team chat", "chat"],
    genericLabel: "Chat integration",
    serverAliases: ["slack"],
    toolFamilies: ["communication", "search"],
  },
  {
    key: "gmail",
    label: "Gmail",
    explicitKeywords: ["gmail", "google mail"],
    genericKeywords: ["email", "emails", "inbox", "inboxes", "mail"],
    genericLabel: "Email integration",
    serverAliases: ["gmail", "google-mail", "email", "mail", "outlook-mail", "outlook-email"],
    toolFamilies: ["communication", "search"],
  },
  {
    key: "calendar",
    label: "Calendar",
    explicitKeywords: ["google calendar", "outlook calendar"],
    genericKeywords: ["calendar", "meeting", "schedule", "availability"],
    genericLabel: "Calendar integration",
    serverAliases: ["calendar", "google-calendar", "outlook-calendar"],
    toolFamilies: ["communication"],
  },
  {
    key: "github",
    label: "GitHub",
    explicitKeywords: ["github"],
    genericKeywords: ["pull request", "repo", "repository"],
    genericLabel: "Code host integration",
    serverAliases: ["github"],
    toolFamilies: ["files", "search"],
  },
  {
    key: "linear",
    label: "Linear",
    explicitKeywords: ["linear"],
    genericKeywords: ["ticket", "issue tracker"],
    genericLabel: "Issue tracker integration",
    serverAliases: ["linear"],
    toolFamilies: ["communication", "search"],
  },
  {
    key: "notion",
    label: "Notion",
    explicitKeywords: ["notion"],
    genericKeywords: ["wiki", "docs database"],
    genericLabel: "Knowledge base integration",
    serverAliases: ["notion"],
    toolFamilies: ["documents", "search"],
  },
  {
    key: "drive",
    label: "Google Drive",
    explicitKeywords: ["google drive", "google docs", "google sheets", "google slides"],
    genericKeywords: ["drive", "docs", "documents", "sheets", "slides"],
    genericLabel: "Document storage integration",
    serverAliases: ["google-drive", "drive", "docs", "sheets", "slides"],
    toolFamilies: ["documents", "files", "search"],
  },
];

export interface AgentBuilderInventory {
  templates: AgentTemplate[];
  skills: CustomSkill[];
  pluginPacks: LoadedPlugin[];
  mcpServers: MCPServerConfig[];
  channels: AgentBuilderChannelInventoryEntry[];
  workspaces: Workspace[];
  agentRoles: AgentRole[];
  runtimeToolFamilies?: ManagedAgentToolFamily[];
  files?: Array<{ name: string; path: string }>;
}

export interface CompressedAgentBuilderInventory {
  templates: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    toolFamilies: ManagedAgentToolFamily[];
    skills: string[];
    mcpServers: string[];
  }>;
  skills: Array<{ id: string; name: string; description: string; enabled: boolean }>;
  pluginPacks: Array<{
    name: string;
    displayName: string;
    description: string;
    recommendedConnectors: string[];
    bestFitWorkflows: string[];
    skills: string[];
  }>;
  mcpServers: Array<{
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    tools: string[];
  }>;
  channels: Array<{ id: string; type: string; name: string; enabled: boolean; status: string }>;
  workspaces: Array<{ id: string; name: string; path: string }>;
  memoryModes: Array<ManagedAgentMemoryConfig["mode"]>;
  runtimeToolFamilies: ManagedAgentToolFamily[];
  agentRoles: Array<{
    id: string;
    displayName: string;
    description?: string;
    capabilities: string[];
  }>;
}

type AgentBuilderServiceOptions = {
  createProvider?: () => LLMProvider;
  getSelectedModel?: () => string;
  now?: () => number;
  randomId?: () => string;
};

function normalizeText(value: unknown): string {
  return String(value || "").trim();
}

function lowercaseWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((word) => word.trim())
    .filter(Boolean);
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 40): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = normalizeText(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function uniqueToolFamilies(values: Array<string | undefined | null>): ManagedAgentToolFamily[] {
  const result: ManagedAgentToolFamily[] = [];
  for (const value of values) {
    if (!value || !VALID_TOOL_FAMILIES.has(value as ManagedAgentToolFamily)) continue;
    if (!result.includes(value as ManagedAgentToolFamily))
      result.push(value as ManagedAgentToolFamily);
  }
  return result;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function titleizeAgentName(prompt: string, fallback = "Personal Agent"): string {
  const cleaned = prompt
    .replace(/\b(agent|assistant|bot)\b/gi, "")
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return fallback;
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return title.endsWith("Agent") ? title : `${title} Agent`;
}

function keywordMatches(prompt: string, keyword: string): boolean {
  const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(prompt);
}

function explicitIntegrationPromptMatches(
  prompt: string,
  descriptor: IntegrationDescriptor,
): boolean {
  return descriptor.explicitKeywords.some((keyword) => keywordMatches(prompt, keyword));
}

function genericIntegrationPromptMatches(
  prompt: string,
  descriptor: IntegrationDescriptor,
): boolean {
  const lower = prompt.toLowerCase();
  if (explicitIntegrationPromptMatches(prompt, descriptor)) return false;
  if (descriptor.genericKeywords.some((keyword) => keywordMatches(prompt, keyword))) return true;
  if (descriptor.key === "linear" && /\bissues?\b/.test(lower) && !/\bgithub\b/.test(lower))
    return true;
  return false;
}

function serverMatchesAliases(server: MCPServerConfig, aliases: string[]): boolean {
  const haystack = `${server.id} ${server.name} ${server.description || ""}`.toLowerCase();
  return aliases.some((alias) => haystack.includes(alias.toLowerCase()));
}

function findConnectedServers(
  inventory: AgentBuilderInventory,
  descriptor: IntegrationDescriptor,
): MCPServerConfig[] {
  return inventory.mcpServers.filter(
    (server) => server.enabled && serverMatchesAliases(server, descriptor.serverAliases),
  );
}

function makeMissingConnection(
  id: string,
  label: string,
  reason: string,
  kind: AgentBuilderConnectionRequirement["kind"] = "connector",
  status: AgentBuilderConnectionRequirement["status"] = "needs_auth",
): AgentBuilderConnectionRequirement {
  return {
    id,
    kind,
    label,
    status,
    reason,
    connectAction: {
      type: kind === "channel" ? "channel" : "connector",
      targetId: id,
      label: kind === "channel" ? "Add channel" : "Connect",
    },
  };
}

function dedupeConnections(
  values: AgentBuilderConnectionRequirement[],
): AgentBuilderConnectionRequirement[] {
  const seen = new Set<string>();
  const result: AgentBuilderConnectionRequirement[] = [];
  for (const value of values) {
    const key = `${value.kind}:${value.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function dedupeSelectionRequirements(
  values: AgentBuilderSelectionRequirement[],
): AgentBuilderSelectionRequirement[] {
  const seen = new Set<string>();
  const result: AgentBuilderSelectionRequirement[] = [];
  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    result.push(value);
  }
  return result;
}

function connectionOptionFromServer(
  server: MCPServerConfig,
  descriptor: IntegrationDescriptor,
): AgentBuilderSelectionOption {
  return {
    id: server.id,
    label: server.name || descriptor.label,
    description:
      server.description || `Use the enabled ${server.name || descriptor.label} integration.`,
    status: "available",
    selectedMcpServers: [server.id],
    selectedToolFamilies: descriptor.toolFamilies,
  };
}

function inferIntegrations(
  prompt: string,
  inventory: AgentBuilderInventory,
): {
  selectedMcpServers: string[];
  missingConnections: AgentBuilderConnectionRequirement[];
  toolFamilies: ManagedAgentToolFamily[];
  selectionRequirements: AgentBuilderSelectionRequirement[];
} {
  const selectedMcpServers: string[] = [];
  const missingConnections: AgentBuilderConnectionRequirement[] = [];
  const toolFamilies: ManagedAgentToolFamily[] = [];
  const selectionRequirements: AgentBuilderSelectionRequirement[] = [];

  for (const descriptor of INTEGRATIONS) {
    const explicitMatch = explicitIntegrationPromptMatches(prompt, descriptor);
    const genericMatch = genericIntegrationPromptMatches(prompt, descriptor);
    if (!explicitMatch && !genericMatch) continue;
    toolFamilies.push(...descriptor.toolFamilies);

    const connectedServers = findConnectedServers(inventory, descriptor);
    if (explicitMatch) {
      if (connectedServers.length > 0) {
        selectedMcpServers.push(connectedServers[0].id);
      } else {
        missingConnections.push(
          makeMissingConnection(
            descriptor.key,
            descriptor.label,
            `${descriptor.label} was named in the prompt, but it is not connected yet.`,
          ),
        );
      }
    } else if (connectedServers.length === 1) {
      selectedMcpServers.push(connectedServers[0].id);
    } else if (connectedServers.length > 1) {
      selectionRequirements.push({
        id: `${descriptor.key}-integration-choice`,
        kind: "integration",
        title: `Choose ${descriptor.genericLabel.toLowerCase()}`,
        reason: `The prompt asks for ${descriptor.genericLabel.toLowerCase()}, but more than one enabled option is available.`,
        required: true,
        options: connectedServers.map((server) => connectionOptionFromServer(server, descriptor)),
      });
    } else {
      missingConnections.push(
        makeMissingConnection(
          descriptor.key === "gmail" ? "email" : descriptor.key,
          explicitMatch ? descriptor.label : descriptor.genericLabel,
          `${explicitMatch ? descriptor.label : descriptor.genericLabel} looks useful for this agent, but it is not connected yet.`,
        ),
      );
    }
    if (descriptor.key === "slack" && explicitMatch) {
      missingConnections.push(
        makeMissingConnection(
          "slack-channel",
          "Slack channel",
          "Choose the Slack channel before this agent responds in Slack.",
          "channel",
          inventory.channels.some((channel) => channel.type === "slack" && channel.enabled)
            ? "missing"
            : "needs_auth",
        ),
      );
    }
  }

  return {
    selectedMcpServers: uniqueStrings(selectedMcpServers),
    missingConnections: dedupeConnections(missingConnections),
    toolFamilies: uniqueToolFamilies(toolFamilies),
    selectionRequirements: dedupeSelectionRequirements(selectionRequirements),
  };
}

function templateScore(prompt: string, template: AgentTemplate): number {
  const promptWords = new Set(lowercaseWords(prompt));
  if (promptWords.size === 0) return 0;
  const haystack = [
    template.name,
    template.description,
    template.tagline,
    template.category,
    ...(template.skills || []),
    ...(template.mcpServers || []),
  ].join(" ");
  return lowercaseWords(haystack).reduce(
    (score, word) => score + (promptWords.has(word) ? 1 : 0),
    0,
  );
}

function suggestTemplate(prompt: string, templates: AgentTemplate[]): AgentTemplate | undefined {
  let best: AgentTemplate | undefined;
  let bestScore = 0;
  for (const template of templates) {
    const score = templateScore(prompt, template);
    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : undefined;
}

export function inferExplicitSchedule(prompt: string): ManagedAgentScheduleConfig {
  const lower = prompt.toLowerCase();
  const everyMatch = lower.match(/\bevery\s+(\d+)\s*(minute|minutes|min|hour|hours|day|days)\b/);
  if (everyMatch) {
    const amount = Math.max(1, Number(everyMatch[1] || 1));
    const unit = everyMatch[2] || "hours";
    const cadenceMinutes = unit.startsWith("min")
      ? Math.max(15, amount)
      : unit.startsWith("hour")
        ? amount * 60
        : amount * 24 * 60;
    return {
      enabled: true,
      mode: "recurring",
      cadenceMinutes,
      label: `Every ${amount} ${unit}`,
      activeHours: null,
    };
  }
  if (/\b(hourly|every hour|each hour)\b/.test(lower)) {
    return {
      enabled: true,
      mode: "recurring",
      cadenceMinutes: 60,
      label: "Hourly",
      activeHours: null,
    };
  }
  if (
    /\b(daily|every day|each day|every morning|each morning|every weekday|weekday mornings)\b/.test(
      lower,
    )
  ) {
    return {
      enabled: true,
      mode: "recurring",
      cadenceMinutes: 24 * 60,
      label: lower.includes("weekday") ? "Every weekday morning" : "Daily",
      activeHours: null,
    };
  }
  if (/\b(weekly|every week|each week)\b/.test(lower)) {
    return {
      enabled: true,
      mode: "recurring",
      cadenceMinutes: 7 * 24 * 60,
      label: "Weekly",
      activeHours: null,
    };
  }
  return { enabled: false, mode: "manual" };
}

function skillPromptMatchesExact(prompt: string, skill: CustomSkill): boolean {
  const lower = prompt.toLowerCase();
  return [skill.id, skill.name]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .some((value) => lower.includes(value));
}

function inferSkills(
  prompt: string,
  inventory: AgentBuilderInventory,
  template?: AgentTemplate,
): {
  selectedSkills: string[];
  selectionRequirements: AgentBuilderSelectionRequirement[];
} {
  const promptWords = new Set(lowercaseWords(prompt));
  const enabledSkills = inventory.skills.filter((skill) => skill.enabled !== false);
  const exact = enabledSkills.filter((skill) => skillPromptMatchesExact(prompt, skill));
  if (exact.length > 0) {
    return {
      selectedSkills: uniqueStrings(
        [...(template?.skills || []), ...exact.map((skill) => skill.id)],
        8,
      ),
      selectionRequirements: [],
    };
  }
  const scored = inventory.skills
    .filter((skill) => skill.enabled !== false)
    .map((skill) => {
      const haystack = `${skill.id} ${skill.name} ${skill.description || ""} ${skill.category || ""}`;
      const score = lowercaseWords(haystack).reduce(
        (total, word) => total + (promptWords.has(word) ? 1 : 0),
        0,
      );
      return { skill, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score || 0;
  const viable = scored.filter((entry) => entry.score === bestScore);
  if (viable.length === 1) {
    return {
      selectedSkills: uniqueStrings([...(template?.skills || []), viable[0].skill.id], 8),
      selectionRequirements: [],
    };
  }
  if (viable.length > 1) {
    return {
      selectedSkills: uniqueStrings(template?.skills || [], 8),
      selectionRequirements: [
        {
          id: "skill-choice",
          kind: "skill",
          title: "Choose a skill",
          reason: "More than one enabled skill appears relevant to this agent.",
          required: true,
          options: viable.slice(0, 8).map((entry) => ({
            id: entry.skill.id,
            label: entry.skill.name || entry.skill.id,
            description: entry.skill.description,
            status: "available",
            selectedSkills: [entry.skill.id],
          })),
        },
      ],
    };
  }
  return {
    selectedSkills: uniqueStrings(template?.skills || [], 8),
    selectionRequirements: [],
  };
}

function defaultStarterPrompts(planName: string, prompt: string): AgentStarterPrompt[] {
  return [
    {
      id: "run-now",
      title: "Run this now",
      prompt: prompt || `Start the configured workflow for ${planName}.`,
      description: "Use the generated setup immediately.",
      icon: "play",
    },
    {
      id: "summarize-sources",
      title: "Summarize sources",
      prompt: `Find the current context for ${planName} and summarize what matters before taking action.`,
      description: "Gather context before follow-through.",
      icon: "search",
    },
    {
      id: "draft-next-steps",
      title: "Draft next steps",
      prompt: `Turn the latest findings for ${planName} into clear next steps and ask before any write action.`,
      description: "Prepare work for review.",
      icon: "checklist",
    },
  ];
}

function buildInstructions(planName: string, prompt: string, missingCount: number): string {
  const missingLine =
    missingCount > 0
      ? "If a required integration is missing, explain what is blocked and continue with available context."
      : "Use the connected tools and workspace context to complete the request.";
  return [
    `You are ${planName}, a private CoWork OS managed agent created for personal use.`,
    "",
    "Mission:",
    prompt || "Help the user run a focused workflow inside CoWork OS.",
    "",
    "Operating rules:",
    "- Use only tools, skills, files, and integrations that are explicitly enabled in the managed environment.",
    "- Read-only research, search, and lookup work may proceed without asking.",
    "- Ask for approval before sending messages, editing files, creating calendar events, filing external tickets, or changing outside systems.",
    `- ${missingLine}`,
    "- Keep outputs concise, source-backed, and ready for the user to inspect.",
  ].join("\n");
}

export function buildFallbackAgentPlan(
  request: AgentBuilderPlanRequest,
  inventory: AgentBuilderInventory,
  options: Pick<AgentBuilderServiceOptions, "now" | "randomId"> = {},
): AgentBuilderPlan {
  const prompt = request.prompt.trim();
  const now = options.now?.() ?? Date.now();
  const id = options.randomId?.() ?? randomUUID();
  const template = suggestTemplate(prompt, inventory.templates);
  const inferred = inferIntegrations(prompt, inventory);
  const inferredSkills = inferSkills(prompt, inventory, template);
  const explicitSchedule = inferExplicitSchedule(prompt);
  const promptWords = prompt.toLowerCase();
  const selectedToolFamilies = uniqueToolFamilies([
    ...(template?.studio?.apps?.allowedToolFamilies || []),
    ...(template?.environmentConfig?.allowedToolFamilies || []),
    ...inferred.toolFamilies,
    promptWords.includes("image") || promptWords.includes("design") ? "images" : undefined,
    promptWords.includes("file") || promptWords.includes("folder") ? "files" : undefined,
    promptWords.includes("doc") || promptWords.includes("report") ? "documents" : undefined,
    "search",
    "files",
    "memory",
  ]);
  const selectedMcpServers = uniqueStrings([
    ...(template?.mcpServers || []),
    ...(template?.studio?.apps?.mcpServers || []),
    ...inferred.selectedMcpServers,
  ]).filter((serverId) =>
    inventory.mcpServers.some((server) => server.id === serverId && server.enabled),
  );
  const name = titleizeAgentName(prompt, template?.name || "Personal Agent");
  const description = prompt || template?.description || "A private CoWork OS agent.";
  const missingConnections = inferred.missingConnections;
  const selectionRequirements = dedupeSelectionRequirements([
    ...inferred.selectionRequirements,
    ...inferredSkills.selectionRequirements,
  ]);
  const instructions = buildInstructions(name, prompt, missingConnections.length);
  const starterPrompts = defaultStarterPrompts(name, prompt);
  const routines: AgentBuilderRoutinePlan[] = [
    {
      name: `${name} manual run`,
      description,
      enabled: true,
      trigger: { type: "manual" as const, enabled: true },
    },
    ...(explicitSchedule.enabled
      ? [
          {
            name: explicitSchedule.label
              ? `${name} ${explicitSchedule.label}`
              : `${name} scheduled run`,
            description,
            enabled: true,
            trigger: {
              type: "schedule" as const,
              enabled: true,
              cadenceMinutes: explicitSchedule.cadenceMinutes,
            },
          },
        ]
      : []),
  ];

  return {
    id,
    sourcePrompt: prompt,
    name,
    subtitle: "Private in CoWork OS",
    description,
    icon: template?.icon || "Bot",
    color: template?.color || "#1570ef",
    templateId: template?.id,
    workflowBrief: description,
    capabilities: uniqueStrings(
      [
        "Answer and act from your CoWork OS context",
        selectedToolFamilies.includes("communication")
          ? "Draft communication for approval"
          : undefined,
        selectedToolFamilies.includes("documents") ? "Prepare documents and reports" : undefined,
        selectedToolFamilies.includes("search")
          ? "Search and summarize current context"
          : undefined,
        explicitSchedule.enabled ? "Run on an explicit recurring schedule" : "Run on demand",
      ],
      6,
    ),
    selectedToolFamilies,
    selectedMcpServers,
    connectedMcpServers: selectedMcpServers,
    recommendedMissingIntegrations: missingConnections,
    missingConnections,
    selectedSkills: inferredSkills.selectedSkills,
    selectionRequirements,
    instructions,
    operatingNotes:
      "Created from a prompt-first builder plan. Keep unavailable integrations as connect items and ask before write actions.",
    starterPrompts,
    scheduleSuggestion: explicitSchedule.enabled
      ? explicitSchedule.label || "Recurring schedule requested"
      : promptWords.includes("morning")
        ? "You mentioned morning timing; add a schedule when you want unattended runs."
        : undefined,
    scheduleConfig: explicitSchedule,
    routines,
    memoryConfig: template?.studio?.memoryConfig || DEFAULT_MEMORY_CONFIG,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    sharing: { visibility: "private", ownerLabel: "You" },
    deployment: { surfaces: ["chatgpt"] },
    accessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    // Kept only so older consumers can deserialize the plan shape. Command
    // tools are controlled by accessProfileId and are never inferred here.
    enableShell: false,
    enableBrowser: template?.environmentConfig?.enableBrowser !== false,
    enableComputerUse:
      selectedToolFamilies.includes("computer-use") ||
      !!template?.environmentConfig?.enableComputerUse,
    rationale: [
      template
        ? `Matched the prompt to the ${template.name} template.`
        : "Built a private personal agent from the prompt.",
      "Enabled only connected MCP servers and built-in tool families.",
      missingConnections.length > 0
        ? "Kept disconnected integrations as Connect checklist items."
        : selectionRequirements.length > 0
          ? "Asked the user to choose between available tools, integrations, or skills before creation."
          : "No missing integration was required to create this agent.",
    ],
    checklist: [
      "Understand the requested workflow",
      "Inspect available tools, skills, templates, and integrations",
      "Choose safe defaults for approvals and privacy",
      "Prepare the agent for one-click creation",
    ],
    generatedAt: now,
    fallbackUsed: true,
  };
}

export function extractFirstJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] || text;
  const start = source.indexOf("{");
  if (start === -1) throw new Error("No JSON object found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(start, index + 1));
      }
    }
  }
  throw new Error("JSON object was incomplete");
}

export function compressAgentBuilderInventory(
  inventory: AgentBuilderInventory,
): CompressedAgentBuilderInventory {
  return {
    templates: inventory.templates.slice(0, 24).map((template) => ({
      id: template.id,
      name: template.name,
      description: truncate(template.description, 220),
      category: template.category,
      toolFamilies: uniqueToolFamilies([
        ...(template.studio?.apps?.allowedToolFamilies || []),
        ...(template.environmentConfig?.allowedToolFamilies || []),
      ]),
      skills: (template.skills || template.studio?.skills || []).slice(0, 12),
      mcpServers: (template.mcpServers || template.studio?.apps?.mcpServers || []).slice(0, 12),
    })),
    skills: inventory.skills.slice(0, 60).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: truncate(skill.description || "", 180),
      enabled: skill.enabled !== false,
    })),
    pluginPacks: inventory.pluginPacks.slice(0, 30).map((plugin) => ({
      name: plugin.manifest.name,
      displayName: plugin.manifest.displayName,
      description: truncate(plugin.manifest.description || "", 180),
      recommendedConnectors: plugin.manifest.recommendedConnectors || [],
      bestFitWorkflows: plugin.manifest.bestFitWorkflows || [],
      skills: (plugin.manifest.skills || []).map((skill) => skill.id).slice(0, 12),
    })),
    mcpServers: inventory.mcpServers.slice(0, 60).map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description ? truncate(server.description, 180) : undefined,
      enabled: server.enabled,
      tools: (server.tools || []).map((tool) => tool.name).slice(0, 24),
    })),
    channels: inventory.channels.slice(0, 40).map((channel) => ({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      status: channel.status,
    })),
    workspaces: inventory.workspaces.slice(0, 20).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
    })),
    memoryModes: ["default", "focused", "disabled"],
    runtimeToolFamilies: (
      inventory.runtimeToolFamilies || [
        "communication",
        "search",
        "files",
        "documents",
        "memory",
        "browser",
        "images",
        "computer-use",
      ]
    ).filter((family) => family !== "shell"),
    agentRoles: inventory.agentRoles.slice(0, 30).map((role) => ({
      id: role.id,
      displayName: role.displayName,
      description: role.description,
      capabilities: role.capabilities,
    })),
  };
}

function readPlanObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plan JSON must be an object");
  }
  const record = value as Record<string, unknown>;
  const nested = record.plan;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

function normalizeStringArray(value: unknown, limit = 20): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.map((entry) => (typeof entry === "string" ? entry : undefined)),
    limit,
  );
}

function normalizeConnections(value: unknown): AgentBuilderConnectionRequirement[] {
  if (!Array.isArray(value)) return [];
  const connections: AgentBuilderConnectionRequirement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeText(record.id);
    const label = normalizeText(record.label);
    const reason = normalizeText(record.reason);
    if (!id || !label) continue;
    const rawKind = normalizeText(record.kind);
    const kind: AgentBuilderConnectionRequirement["kind"] = [
      "connector",
      "mcp_server",
      "channel",
      "skill",
      "app",
    ].includes(rawKind)
      ? (rawKind as AgentBuilderConnectionRequirement["kind"])
      : "connector";
    const rawStatus = normalizeText(record.status);
    const status: AgentBuilderConnectionRequirement["status"] = [
      "missing",
      "needs_auth",
      "disabled",
      "not_installed",
    ].includes(rawStatus)
      ? (rawStatus as AgentBuilderConnectionRequirement["status"])
      : "needs_auth";
    connections.push({
      id,
      label,
      reason: reason || `${label} needs to be connected.`,
      kind,
      status,
      connectAction: {
        type: kind === "channel" ? "channel" : "connector",
        targetId: id,
        label: kind === "channel" ? "Add channel" : "Connect",
      },
    });
  }
  return dedupeConnections(connections);
}

function normalizeSelectionRequirements(value: unknown): AgentBuilderSelectionRequirement[] {
  if (!Array.isArray(value)) return [];
  const requirements: AgentBuilderSelectionRequirement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeText(record.id);
    const rawKind = normalizeText(record.kind);
    const kind: AgentBuilderSelectionRequirement["kind"] = [
      "integration",
      "tool",
      "skill",
    ].includes(rawKind)
      ? (rawKind as AgentBuilderSelectionRequirement["kind"])
      : "integration";
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options: AgentBuilderSelectionOption[] = rawOptions
      .map((option): AgentBuilderSelectionOption | null => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return null;
        const optionRecord = option as Record<string, unknown>;
        const optionId = normalizeText(optionRecord.id);
        const label = normalizeText(optionRecord.label);
        if (!optionId || !label) return null;
        const rawStatus = normalizeText(optionRecord.status);
        const status: AgentBuilderSelectionOption["status"] = [
          "available",
          "missing",
          "needs_auth",
          "disabled",
        ].includes(rawStatus)
          ? (rawStatus as AgentBuilderSelectionOption["status"])
          : "available";
        return {
          id: optionId,
          label,
          description: normalizeText(optionRecord.description) || undefined,
          status,
          selectedToolFamilies: uniqueToolFamilies(
            normalizeStringArray(optionRecord.selectedToolFamilies),
          ),
          selectedMcpServers: normalizeStringArray(optionRecord.selectedMcpServers),
          selectedSkills: normalizeStringArray(optionRecord.selectedSkills),
          missingConnections: normalizeConnections(optionRecord.missingConnections),
        };
      })
      .filter((option): option is AgentBuilderSelectionOption => !!option);
    if (!id || options.length === 0) continue;
    const selectedOptionId = normalizeText(record.selectedOptionId);
    requirements.push({
      id,
      kind,
      title: normalizeText(record.title) || "Choose an option",
      reason: normalizeText(record.reason) || "This choice is required before creating the agent.",
      required: record.required !== false,
      options,
      selectedOptionId: options.some((option) => option.id === selectedOptionId)
        ? selectedOptionId
        : undefined,
    });
  }
  return dedupeSelectionRequirements(requirements);
}

function unresolvedOptionServerIds(requirements: AgentBuilderSelectionRequirement[]): Set<string> {
  const serverIds = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.required || requirement.selectedOptionId) continue;
    for (const option of requirement.options) {
      for (const serverId of option.selectedMcpServers || []) serverIds.add(serverId);
    }
  }
  return serverIds;
}

function unresolvedOptionSkillIds(requirements: AgentBuilderSelectionRequirement[]): Set<string> {
  const skillIds = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.required || requirement.selectedOptionId) continue;
    for (const option of requirement.options) {
      for (const skillId of option.selectedSkills || []) skillIds.add(skillId);
    }
  }
  return skillIds;
}

function normalizePlanFromJson(
  parsed: unknown,
  request: AgentBuilderPlanRequest,
  inventory: AgentBuilderInventory,
  fallback: AgentBuilderPlan,
  options: Pick<AgentBuilderServiceOptions, "now" | "randomId">,
): AgentBuilderPlan {
  const record = readPlanObject(parsed);
  const enabledServers = new Set(
    inventory.mcpServers.filter((server) => server.enabled).map((server) => server.id),
  );
  const skillIds = new Set(
    inventory.skills.filter((skill) => skill.enabled !== false).map((skill) => skill.id),
  );
  const prompt = request.prompt.trim();
  const inferred = inferIntegrations(prompt, inventory);
  const inferredSkills = inferSkills(
    prompt,
    inventory,
    fallback.templateId
      ? inventory.templates.find((template) => template.id === fallback.templateId)
      : undefined,
  );
  const explicitSchedule = inferExplicitSchedule(prompt);
  const selectionRequirements = dedupeSelectionRequirements([
    ...normalizeSelectionRequirements(record.selectionRequirements),
    ...inferred.selectionRequirements,
    ...inferredSkills.selectionRequirements,
  ]);
  const unresolvedServerIds = unresolvedOptionServerIds(selectionRequirements);
  const unresolvedSkillIds = unresolvedOptionSkillIds(selectionRequirements);
  const llmMcpServers = normalizeStringArray(
    record.selectedMcpServers || record.connectedMcpServers,
  );
  const selectedMcpServers = uniqueStrings([
    ...llmMcpServers.filter(
      (serverId) => enabledServers.has(serverId) && !unresolvedServerIds.has(serverId),
    ),
    ...inferred.selectedMcpServers,
  ]);
  const missingConnections = dedupeConnections([
    ...normalizeConnections(record.missingConnections),
    ...normalizeConnections(record.recommendedMissingIntegrations),
    ...inferred.missingConnections,
  ]);
  const selectedToolFamilies = uniqueToolFamilies([
    ...normalizeStringArray(record.selectedToolFamilies),
    ...inferred.toolFamilies,
    ...(fallback.selectedToolFamilies || []),
  ]);
  const selectedSkills = uniqueStrings(
    [
      ...normalizeStringArray(record.selectedSkills || record.skills).filter(
        (skillId) => skillIds.has(skillId) && !unresolvedSkillIds.has(skillId),
      ),
      ...inferredSkills.selectedSkills,
    ],
    8,
  );
  const name = truncate(normalizeText(record.name) || fallback.name, 80);
  const scheduleConfig = explicitSchedule.enabled ? explicitSchedule : fallback.scheduleConfig;
  const routines = [
    {
      name: `${name} manual run`,
      description: prompt,
      enabled: true,
      trigger: { type: "manual" as const, enabled: true },
    },
    ...(scheduleConfig.enabled
      ? [
          {
            name: scheduleConfig.label
              ? `${name} ${scheduleConfig.label}`
              : `${name} scheduled run`,
            description: prompt,
            enabled: true,
            trigger: {
              type: "schedule" as const,
              enabled: true,
              cadenceMinutes: scheduleConfig.cadenceMinutes,
            },
          },
        ]
      : []),
  ];

  return {
    ...fallback,
    id: normalizeText(record.id) || options.randomId?.() || randomUUID(),
    sourcePrompt: prompt,
    name,
    subtitle: truncate(normalizeText(record.subtitle) || "Private in CoWork OS", 120),
    description: truncate(normalizeText(record.description) || fallback.description, 500),
    icon: truncate(normalizeText(record.icon) || fallback.icon, 40),
    color: normalizeText(record.color) || fallback.color,
    templateId: normalizeText(record.templateId) || fallback.templateId,
    workflowBrief: truncate(
      normalizeText(record.workflowBrief) || prompt || fallback.workflowBrief,
      1000,
    ),
    capabilities: uniqueStrings(
      [...normalizeStringArray(record.capabilities, 8), ...fallback.capabilities],
      8,
    ),
    selectedToolFamilies,
    selectedMcpServers,
    connectedMcpServers: selectedMcpServers,
    recommendedMissingIntegrations: missingConnections,
    missingConnections,
    selectedSkills,
    selectionRequirements,
    instructions:
      normalizeText(record.instructions) ||
      normalizeText(record.systemPrompt) ||
      buildInstructions(name, prompt, missingConnections.length),
    operatingNotes: normalizeText(record.operatingNotes) || fallback.operatingNotes,
    starterPrompts: fallback.starterPrompts,
    scheduleSuggestion: scheduleConfig.enabled
      ? scheduleConfig.label || "Recurring schedule requested"
      : normalizeText(record.scheduleSuggestion) || fallback.scheduleSuggestion,
    scheduleConfig,
    routines,
    memoryConfig: fallback.memoryConfig,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
    sharing: { visibility: "private", ownerLabel: "You" },
    deployment: { surfaces: ["chatgpt"] },
    accessProfileId: fallback.accessProfileId || BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    enableShell: false,
    enableBrowser: fallback.enableBrowser,
    enableComputerUse: selectedToolFamilies.includes("computer-use"),
    rationale: uniqueStrings(
      [...normalizeStringArray(record.rationale, 6), ...fallback.rationale],
      6,
    ),
    checklist: uniqueStrings(
      [...normalizeStringArray(record.checklist, 6), ...fallback.checklist],
      6,
    ),
    generatedAt: options.now?.() ?? Date.now(),
    fallbackUsed: false,
  };
}

function responseTextFromContent(
  content: Awaited<ReturnType<LLMProvider["createMessage"]>>["content"],
): string {
  return content
    .map((entry) => (entry.type === "text" ? entry.text : ""))
    .join("\n")
    .trim();
}

export class AgentBuilderService {
  constructor(private readonly options: AgentBuilderServiceOptions = {}) {}

  async generatePlan(
    request: AgentBuilderPlanRequest,
    inventory: AgentBuilderInventory,
  ): Promise<AgentBuilderPlan> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Prompt is required");
    const fallback = buildFallbackAgentPlan(request, inventory, this.options);
    try {
      const provider = this.options.createProvider?.() || LLMProviderFactory.createProvider();
      const model = this.options.getSelectedModel?.() || LLMProviderFactory.getSelectedModel();
      const compressedInventory = compressAgentBuilderInventory(inventory);
      const response = await provider.createMessage({
        model,
        maxTokens: 2600,
        system: [
          "You create private personal CoWork OS managed agents from a user's prompt.",
          "Return exactly one JSON object. Do not include markdown.",
          "Only select tools, skills, and MCP servers that appear enabled in the inventory.",
          "Do not select a specific integration or skill from generic wording when multiple enabled options fit.",
          "If multiple enabled options fit a generic request, return a required selectionRequirements choice group instead of choosing.",
          "Disconnected inferred integrations must be returned as missingConnections, not selectedMcpServers.",
          "Do not select arbitrary Slack channels. If Slack is needed, add a Slack channel missing connection.",
          "Only enable scheduleConfig when the prompt clearly asks for recurrence.",
          "Use private sharing, ownerLabel You, CoWork OS surface, read-only auto approval, write approval gates.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              prompt,
              workspaceId: request.workspaceId,
              inventory: compressedInventory,
              requiredShape: {
                name: "string",
                subtitle: "string",
                description: "string",
                icon: "string",
                color: "hex string",
                capabilities: "string[]",
                selectedToolFamilies: "ManagedAgentToolFamily[]",
                selectedMcpServers: "enabled MCP server ids only",
                missingConnections: "connection requirement[]",
                selectedSkills: "enabled skill ids only",
                selectionRequirements:
                  "required choice groups for ambiguous integration/tool/skill choices",
                instructions: "system prompt",
                operatingNotes: "string",
                scheduleSuggestion: "string optional",
                rationale: "string[]",
                checklist: "string[]",
              },
            }),
          },
        ],
      });
      const parsed = extractFirstJsonObject(responseTextFromContent(response.content));
      return normalizePlanFromJson(parsed, request, inventory, fallback, this.options);
    } catch {
      return fallback;
    }
  }
}
