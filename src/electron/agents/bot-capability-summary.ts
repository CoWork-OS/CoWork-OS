/**
 * The "What it can do" card in a bot's details panel. Every line is computed with the checks
 * that enforce it (tool registry, bot containment, task computers, permission engine), so the
 * card never claims more than the bot's tasks are allowed to do.
 */
import type { AccessApprovalPolicy } from "../../shared/access-profiles";
import type {
  BotCapabilitySection,
  BotCapabilitySummary,
  BotLinkedChannel,
  BotServiceCapability,
  BotServiceUse,
} from "../../shared/bot-capabilities";
import {
  computerToolKind,
  isComputerToolBlocked,
  normalizeBotDesktopNetwork,
  normalizeBotWorksOn,
  type BotWorksOn,
  type ComputerToolKind,
} from "../../shared/bot-computer";
import { normalizeBotFileAccess } from "../../shared/bot-containment";
import {
  isEnvironmentTool,
  isToolSupportedInEnvironment,
} from "../../shared/execution-environment";
import { EXPLICIT_CONSENT_KINDS } from "../../shared/explicit-consent";
import {
  isToolBoundaryAllowedForContainedRun,
  toolBoundaryClass,
} from "../../shared/tool-boundaries";
import {
  isToolDeniedByRestrictions,
  parseToolRestrictions,
  type ParsedToolRestrictions,
} from "../../shared/tool-restrictions";
import type { AgentRole, BotWorkPage, IntegrationMentionOption } from "../../shared/types";
import type { BotResponsibility } from "../../shared/bot-responsibility";

const COMPUTER_KINDS: readonly ComputerToolKind[] = ["host", "browser", "desktop", "handoff"];
/** Codex computer use exposes these tools; the registry treats them as driving this computer. */
const DESKTOP_DRIVER_TOOLS = new Set(["js", "js_reset"]);
const DEFAULT_CHECK_IN_MINUTES = 15;

export type BotCapabilityRole = Pick<
  AgentRole,
  | "id"
  | "worksOn"
  | "fileAccess"
  | "desktopHost"
  | "desktopGroup"
  | "desktopNetwork"
  | "executionEnvironment"
  | "accessProfileId"
  | "toolRestrictions"
  | "heartbeatEnabled"
  | "heartbeatPolicy"
  | "pulseEveryMinutes"
  | "heartbeatIntervalMinutes"
  | "lastPulseAt"
>;

export interface BotCapabilityMcpServer {
  id: string;
  transport: string;
  /** A desktop driver such as Codex computer use: its tools act on this computer. */
  desktopDriver: boolean;
}

export interface BotCapabilityChannel {
  id: string;
  type: string;
  name?: string;
  /** Read for defaultAgentRoleId and allowedAgentRoleIds. */
  config?: Record<string, unknown>;
}

/** What the service read; a missing optional section means its read failed. */
export interface BotCapabilityInputs {
  workspaceId: string;
  role: BotCapabilityRole;
  /** Runs nobody started by hand use the desktop's work folder instead of its own folder. */
  desktopWorkFolder: boolean;
  mcp: { prefix: string; servers: BotCapabilityMcpServer[] };
  services?: IntegrationMentionOption[];
  channels?: BotCapabilityChannel[];
  schedules?: {
    page: Pick<BotWorkPage, "items" | "scheduleRuntime">;
    responsibilities: Array<Pick<BotResponsibility, "state" | "futurePaused" | "botFuturePaused">>;
  };
  memory?: { available: boolean; saved: number };
  recallPastChats?: boolean;
  access?: { label: string; approvalInChats: AccessApprovalPolicy | undefined };
}

interface ToolContext {
  worksOn: BotWorksOn;
  computerMode: boolean;
  contained: boolean;
  restrictions: ParsedToolRestrictions;
  prefix: string;
  servers: Map<string, BotCapabilityMcpServer>;
}

/** The MCP server behind an integration option id (`mcp:<server>` or `mcp:<server>:<service>`). */
function mcpServerOf(option: IntegrationMentionOption, ctx: ToolContext) {
  if (option.source !== "mcp") return undefined;
  return ctx.servers.get(option.id.split(":")[1] ?? "");
}

type ToolVerdict = "ok" | "denied" | "computer_mode" | "works_on" | "contained";

/** The registry's checks for one tool, in its order: denied tools, task computer, Works on, containment. */
function toolVerdict(
  tool: string,
  server: BotCapabilityMcpServer | undefined,
  ctx: ToolContext,
): ToolVerdict {
  if (isToolDeniedByRestrictions(tool, ctx.restrictions)) return "denied";
  if (ctx.computerMode && !isToolSupportedInEnvironment(tool)) return "computer_mode";
  // Tools a task computer runs are dispatched to the guest, past Works on and containment.
  if (ctx.computerMode && isEnvironmentTool(tool)) return "ok";
  const restricted =
    ctx.worksOn === "browser" || ctx.worksOn === "off" || ctx.worksOn === "own_desktop";
  const hostDesktopMcp =
    restricted &&
    Boolean(server?.desktopDriver) &&
    tool.startsWith(ctx.prefix) &&
    DESKTOP_DRIVER_TOOLS.has(tool.slice(ctx.prefix.length));
  if (isComputerToolBlocked(ctx.worksOn, computerToolKind(tool, { hostDesktopMcp }))) {
    return "works_on";
  }
  if (ctx.contained) {
    const boundary = toolBoundaryClass(tool, { mcpToolNamePrefix: ctx.prefix });
    // A connector whose server is unknown counts as local, as the registry does.
    const localConnector = boundary === "connector" && (!server || server.transport === "stdio");
    if (!isToolBoundaryAllowedForContainedRun(boundary, { worksOn: ctx.worksOn, localConnector })) {
      return "contained";
    }
  }
  return "ok";
}

function serviceCapability(
  option: IntegrationMentionOption,
  ctx: ToolContext,
): BotServiceCapability {
  const server = mcpServerOf(option, ctx);
  const tools = option.tools.length ? option.tools : [];
  const inChats = tools.map((tool) => toolVerdict(tool, server, { ...ctx, contained: false }));
  const onItsOwn = ctx.contained ? tools.map((tool) => toolVerdict(tool, server, ctx)) : inChats;
  let use: BotServiceUse = "yes";
  let limited = false;
  if (tools.length > 0) {
    const usableInChats = inChats.filter((verdict) => verdict === "ok").length;
    if (usableInChats === 0) {
      use = inChats.every((verdict) => verdict === "denied")
        ? "denied_for_bot"
        : inChats.includes("computer_mode")
          ? "not_in_computer_mode"
          : inChats.includes("works_on")
            ? "not_with_works_on"
            : "denied_for_bot";
    } else if (!onItsOwn.includes("ok")) {
      use = "chats_you_start_only";
    }
    limited = use !== "denied_for_bot" && usableInChats > 0 && usableInChats < tools.length;
  } else if (
    ctx.contained &&
    option.source === "mcp" &&
    (!server || server.transport === "stdio")
  ) {
    use = "chats_you_start_only";
  }
  return {
    id: option.id,
    label: option.label,
    source: option.source,
    connected: option.status === "connected",
    use,
    limited,
  };
}

function linkedChannels(channels: BotCapabilityChannel[], roleId: string): BotLinkedChannel[] {
  const linked: BotLinkedChannel[] = [];
  for (const channel of channels) {
    const config = channel.config ?? {};
    const allowed = Array.isArray(config.allowedAgentRoleIds) ? config.allowedAgentRoleIds : [];
    const label = channel.name || channel.type;
    // An empty allowed list means every bot may be used, which says nothing about this one.
    if (config.defaultAgentRoleId === roleId)
      linked.push({ id: channel.id, label, link: "default" });
    else if (allowed.includes(roleId)) linked.push({ id: channel.id, label, link: "allowed" });
  }
  return linked;
}

export function buildBotCapabilitySummary(inputs: BotCapabilityInputs): BotCapabilitySummary {
  const { role } = inputs;
  const partial: BotCapabilitySection[] = [];
  const worksOn = normalizeBotWorksOn(role.worksOn);
  const fileAccess = normalizeBotFileAccess(role.fileAccess);
  const environment = role.executionEnvironment;
  const restrictions = parseToolRestrictions(role.toolRestrictions?.deniedTools);
  const ctx: ToolContext = {
    worksOn,
    computerMode: Boolean(environment),
    // Containment needs own_folder; runs a person starts are never contained (shouldContainBotRun).
    contained: fileAccess === "own_folder",
    restrictions,
    prefix: inputs.mcp.prefix,
    servers: new Map(inputs.mcp.servers.map((server) => [server.id, server])),
  };

  const reach = Object.fromEntries(
    COMPUTER_KINDS.map((kind) => [kind, !isComputerToolBlocked(worksOn, kind)]),
  ) as Record<ComputerToolKind, boolean>;

  if (!inputs.services) partial.push("services");
  if (!inputs.schedules) partial.push("schedules");
  if (!inputs.memory) partial.push("memory");
  if (!inputs.access) partial.push("safeguards");

  // Only saved schedules: the view also lists queued tasks, such as an idle bot chat.
  const scheduledItems = (inputs.schedules?.page.items ?? []).filter((item) => item.scheduleId);
  const nextRuns = scheduledItems
    .filter((item) => !item.schedulePaused && typeof item.nextWakeAt === "number")
    .map((item) => item.nextWakeAt as number);
  const responsibilities = inputs.schedules?.responsibilities ?? [];
  const activeResponsibilities = responsibilities.filter(
    (entry) => entry.state === "active" && !entry.futurePaused && !entry.botFuturePaused,
  ).length;

  const checkInsEnabled = Boolean(role.heartbeatPolicy?.enabled || role.heartbeatEnabled);
  const everyMinutes =
    role.heartbeatPolicy?.cadenceMinutes ||
    role.pulseEveryMinutes ||
    role.heartbeatIntervalMinutes ||
    DEFAULT_CHECK_IN_MINUTES;

  return {
    workspaceId: inputs.workspaceId,
    agentRoleId: role.id,
    where: {
      worksOn,
      reach,
      ...(worksOn === "own_desktop"
        ? {
            desktop: {
              ...(role.desktopHost ? { host: role.desktopHost } : {}),
              ...(role.desktopGroup ? { group: role.desktopGroup } : {}),
              network: normalizeBotDesktopNetwork(role.desktopNetwork),
            },
          }
        : {}),
      ...(environment
        ? { computer: { backend: environment.backend, lifetime: environment.lifetime } }
        : {}),
    },
    files: {
      fileAccess,
      onItsOwn:
        fileAccess === "workspace"
          ? "workspace"
          : inputs.desktopWorkFolder
            ? "desktop_folder"
            : "own_folder",
    },
    services: {
      items: (inputs.services ?? []).map((option) => serviceCapability(option, ctx)),
      channels: linkedChannels(inputs.channels ?? [], role.id),
    },
    schedules: {
      runtime: inputs.schedules?.page.scheduleRuntime ?? "unavailable",
      scheduled: scheduledItems.length,
      ...(nextRuns.length ? { nextRunAt: Math.min(...nextRuns) } : {}),
      responsibilities: {
        active: activeResponsibilities,
        paused: responsibilities.length - activeResponsibilities,
      },
      checkIns: {
        enabled: checkInsEnabled,
        ...(checkInsEnabled ? { everyMinutes } : {}),
        ...(checkInsEnabled && role.lastPulseAt
          ? { nextAt: role.lastPulseAt + everyMinutes * 60_000 }
          : {}),
      },
    },
    memory: {
      available: inputs.memory?.available ?? false,
      saved: inputs.memory?.saved ?? 0,
      recallPastChats: inputs.recallPastChats ?? false,
    },
    safeguards: {
      mayDoAlone: {
        ...(role.accessProfileId ? { id: role.accessProfileId } : {}),
        label: inputs.access?.label ?? "Unavailable",
      },
      // Under an access profile that never asks, a step that needs your OK is refused.
      inChats: inputs.access?.approvalInChats === "never" ? "refuses" : "asks",
      needsOk: EXPLICIT_CONSENT_KINDS,
      deniedTools: [...Array.from(restrictions.groups), ...Array.from(restrictions.tools)].sort(),
      denyAll: restrictions.denyAll,
    },
    partial,
  };
}
