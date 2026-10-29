import { describe, expect, it } from "vitest";
import {
  BOT_WORKS_ON_VALUES,
  computerToolKind,
  isComputerToolBlocked,
  type BotWorksOn,
  type ComputerToolKind,
} from "../../../shared/bot-computer";
import { EXPLICIT_CONSENT_KINDS } from "../../../shared/explicit-consent";
import {
  isToolBoundaryAllowedForContainedRun,
  toolBoundaryClass,
} from "../../../shared/tool-boundaries";
import type { BotWorkPage, IntegrationMentionOption } from "../../../shared/types";
import {
  buildBotCapabilitySummary,
  type BotCapabilityInputs,
  type BotCapabilityRole,
} from "../bot-capability-summary";

const ROLE: BotCapabilityRole = { id: "bot-1" };

function option(
  id: string,
  label: string,
  tools: string[],
  source: IntegrationMentionOption["source"] = "builtin",
): IntegrationMentionOption {
  return {
    id,
    label,
    source,
    providerKey: id,
    iconKey: id,
    tools,
    promptHint: "",
    description: "",
    aliases: [],
    status: "connected",
  };
}

const GMAIL = option("gmail", "Gmail", ["gmail_action"]);
const LOCAL_MCP = option("mcp:files", "Files server", ["mcp_read_notes"], "mcp");
const REMOTE_MCP = option("mcp:tracker", "Tracker", ["mcp_create_issue"], "mcp");
const DESKTOP_DRIVER = option("mcp:codex", "Codex computer use", ["mcp_js"], "mcp");

const PAGE: Pick<BotWorkPage, "items" | "scheduleRuntime"> = {
  items: [],
  scheduleRuntime: "running",
};

function inputs(overrides: Partial<BotCapabilityInputs> = {}): BotCapabilityInputs {
  return {
    workspaceId: "ws-1",
    role: ROLE,
    desktopWorkFolder: false,
    mcp: {
      prefix: "mcp_",
      servers: [
        { id: "files", transport: "stdio", desktopDriver: false },
        { id: "tracker", transport: "streamable-http", desktopDriver: false },
        { id: "codex", transport: "stdio", desktopDriver: true },
      ],
    },
    services: [GMAIL, LOCAL_MCP, REMOTE_MCP],
    channels: [],
    schedules: { page: PAGE, responsibilities: [] },
    memory: { available: true, saved: 3 },
    recallPastChats: true,
    access: { label: "Ask for approval", approvalInChats: "on-request" },
    ...overrides,
  };
}

function useOf(summary: ReturnType<typeof buildBotCapabilitySummary>, id: string) {
  return summary.services.items.find((item) => item.id === id);
}

describe("buildBotCapabilitySummary", () => {
  it.each(BOT_WORKS_ON_VALUES)(
    "reach for Works on %s matches the registry's computer check",
    (worksOn) => {
      const summary = buildBotCapabilitySummary(inputs({ role: { ...ROLE, worksOn } }));
      for (const kind of ["host", "browser", "desktop", "handoff"] as ComputerToolKind[]) {
        expect(summary.where.reach[kind]).toBe(!isComputerToolBlocked(worksOn, kind));
      }
    },
  );

  it("treats a missing Works on as Auto and a missing file access as its own folder", () => {
    const summary = buildBotCapabilitySummary(inputs());
    expect(summary.where.worksOn).toBe("auto");
    expect(summary.where.reach).toEqual({
      host: true,
      browser: true,
      desktop: false,
      handoff: true,
    });
    expect(summary.files).toEqual({ fileAccess: "own_folder", onItsOwn: "own_folder" });
  });

  it("describes its own desktop: host, shared group, network", () => {
    const summary = buildBotCapabilitySummary(
      inputs({
        role: {
          ...ROLE,
          worksOn: "own_desktop",
          desktopHost: "my-server",
          desktopGroup: "research",
          desktopNetwork: "off",
        },
        desktopWorkFolder: true,
      }),
    );
    expect(summary.where.desktop).toEqual({ host: "my-server", group: "research", network: "off" });
    expect(summary.files.onItsOwn).toBe("desktop_folder");
  });

  it("leaves desktop details out unless the bot works on its own desktop", () => {
    const summary = buildBotCapabilitySummary(
      inputs({ role: { ...ROLE, worksOn: "browser", desktopHost: "my-server" } }),
    );
    expect(summary.where.desktop).toBeUndefined();
  });

  it("says runs work in the given project when file access is the workspace", () => {
    const summary = buildBotCapabilitySummary(
      inputs({ role: { ...ROLE, fileAccess: "workspace" }, desktopWorkFolder: true }),
    );
    expect(summary.files.onItsOwn).toBe("workspace");
    // Nothing is contained, so a local connector works in every run.
    expect(useOf(summary, "mcp:files")?.use).toBe("yes");
  });

  it("limits local connectors to chats you start when the bot is contained", () => {
    const summary = buildBotCapabilitySummary(inputs());
    expect(useOf(summary, "mcp:files")?.use).toBe("chats_you_start_only");
    expect(useOf(summary, "mcp:tracker")?.use).toBe("yes");
    expect(useOf(summary, "gmail")?.use).toBe("yes");
  });

  it("treats a connector whose server is unknown as local, like the registry", () => {
    const orphan = option("mcp:gone", "Gone", ["mcp_gone_tool"], "mcp");
    const summary = buildBotCapabilitySummary(inputs({ services: [orphan] }));
    expect(useOf(summary, "mcp:gone")?.use).toBe("chats_you_start_only");
  });

  it("marks services the bot's denied tools cover, by name or group", () => {
    const byName = buildBotCapabilitySummary(
      inputs({ role: { ...ROLE, toolRestrictions: { deniedTools: ["gmail_action"] } } }),
    );
    expect(useOf(byName, "gmail")?.use).toBe("denied_for_bot");
    expect(byName.safeguards.deniedTools).toEqual(["gmail_action"]);

    const all = buildBotCapabilitySummary(
      inputs({ role: { ...ROLE, toolRestrictions: { deniedTools: ["*"] } } }),
    );
    expect(all.services.items.every((item) => item.use === "denied_for_bot")).toBe(true);
    expect(all.safeguards.denyAll).toBe(true);

    const group = buildBotCapabilitySummary(
      inputs({ role: { ...ROLE, toolRestrictions: { deniedTools: ["group:network"] } } }),
    );
    expect(group.safeguards.deniedTools).toEqual(["group:network"]);
  });

  it("marks a service limited when only some of its tools are refused", () => {
    const mixed = option("mcp:tracker", "Tracker", ["mcp_create_issue", "mcp_list_issues"], "mcp");
    const summary = buildBotCapabilitySummary(
      inputs({
        services: [mixed],
        role: { ...ROLE, toolRestrictions: { deniedTools: ["mcp_create_issue"] } },
      }),
    );
    expect(useOf(summary, "mcp:tracker")).toMatchObject({ use: "yes", limited: true });
  });

  it("refuses connectors while all work runs in a task computer", () => {
    const summary = buildBotCapabilitySummary(
      inputs({
        role: {
          ...ROLE,
          worksOn: "own_desktop",
          executionEnvironment: {
            backend: "bot-desktop",
            lifetime: "task",
            inputPaths: [],
            outputPaths: [],
          },
        },
      }),
    );
    expect(summary.where.computer).toEqual({ backend: "bot-desktop", lifetime: "task" });
    expect(useOf(summary, "mcp:tracker")?.use).toBe("not_in_computer_mode");
    // Service actions run on the host beside the computer.
    expect(useOf(summary, "gmail")?.use).toBe("yes");
  });

  it("takes a desktop driver away when Works on keeps the bot off this Mac", () => {
    const services = [DESKTOP_DRIVER];
    for (const worksOn of ["browser", "off", "own_desktop"] as BotWorksOn[]) {
      const summary = buildBotCapabilitySummary(
        inputs({ services, role: { ...ROLE, worksOn, fileAccess: "workspace" } }),
      );
      expect(useOf(summary, "mcp:codex")?.use).toBe("not_with_works_on");
    }
    const auto = buildBotCapabilitySummary(
      inputs({ services, role: { ...ROLE, fileAccess: "workspace" } }),
    );
    expect(useOf(auto, "mcp:codex")?.use).toBe("yes");
  });

  it("agrees with the containment check for every service it calls chats-only", () => {
    const summary = buildBotCapabilitySummary(inputs());
    const servers = new Map(inputs().mcp.servers.map((server) => [server.id, server]));
    for (const item of summary.services.items) {
      const tools = inputs().services!.find((entry) => entry.id === item.id)!.tools;
      const refused = tools.some((tool) => {
        const boundary = toolBoundaryClass(tool, { mcpToolNamePrefix: "mcp_" });
        const server = servers.get(item.id.split(":")[1] ?? "");
        return !isToolBoundaryAllowedForContainedRun(boundary, {
          worksOn: "auto",
          localConnector: boundary === "connector" && (!server || server.transport === "stdio"),
        });
      });
      expect(item.use === "chats_you_start_only").toBe(refused);
    }
  });

  it("finds the next unpaused run and counts active responsibilities", () => {
    const summary = buildBotCapabilitySummary(
      inputs({
        schedules: {
          page: {
            ...PAGE,
            items: [
              { scheduleId: "a", nextWakeAt: 3_000, schedulePaused: "bot" as const },
              { scheduleId: "b", nextWakeAt: 5_000 },
              { scheduleId: "c", nextWakeAt: 4_000 },
              // A queued task, such as an idle bot chat, is not a schedule.
              { taskId: "chat", nextWakeAt: 1_000 },
            ].map((extra, index) => ({
              id: `s${index}`,
              title: "Run",
              view: "scheduled" as const,
              status: "scheduled" as const,
              ownership: "assigned" as const,
              conversation: false,
              updatedAt: 0,
              verification: "unverified" as const,
              delivery: "unknown" as const,
              ...extra,
            })),
          },
          responsibilities: [
            { state: "active" },
            { state: "active", futurePaused: true },
            { state: "paused" },
          ],
        },
      }),
    );
    expect(summary.schedules).toMatchObject({
      runtime: "running",
      scheduled: 3,
      nextRunAt: 4_000,
      responsibilities: { active: 1, paused: 2 },
    });
  });

  it("reports check-ins from the role's cadence", () => {
    const summary = buildBotCapabilitySummary(
      inputs({
        role: {
          ...ROLE,
          heartbeatPolicy: {
            enabled: true,
            cadenceMinutes: 30,
          } as BotCapabilityRole["heartbeatPolicy"],
          lastPulseAt: 1_000,
        },
      }),
    );
    expect(summary.schedules.checkIns).toEqual({
      enabled: true,
      everyMinutes: 30,
      nextAt: 1_000 + 30 * 60_000,
    });
  });

  it("lists channels that route to the bot, never an open allow list", () => {
    const summary = buildBotCapabilitySummary(
      inputs({
        channels: [
          { id: "c1", type: "slack", name: "Team", config: { defaultAgentRoleId: "bot-1" } },
          { id: "c2", type: "telegram", config: { allowedAgentRoleIds: ["bot-1", "bot-2"] } },
          { id: "c3", type: "teams", config: { allowedAgentRoleIds: [] } },
          { id: "c4", type: "discord", config: { defaultAgentRoleId: "bot-2" } },
        ],
      }),
    );
    expect(summary.services.channels).toEqual([
      { id: "c1", label: "Team", link: "default" },
      { id: "c2", label: "telegram", link: "allowed" },
    ]);
  });

  it("says chats are refused when the access never asks", () => {
    const summary = buildBotCapabilitySummary(
      inputs({ access: { label: "Full access", approvalInChats: "never" } }),
    );
    expect(summary.safeguards.inChats).toBe("refuses");
    expect(summary.safeguards.needsOk).toEqual(EXPLICIT_CONSENT_KINDS);
  });

  it("marks the sections whose reads failed", () => {
    const summary = buildBotCapabilitySummary(
      inputs({ services: undefined, schedules: undefined, memory: undefined, access: undefined }),
    );
    expect(summary.partial).toEqual(["services", "schedules", "memory", "safeguards"]);
    expect(summary.schedules.runtime).toBe("unavailable");
    expect(summary.memory).toEqual({ available: false, saved: 0, recallPastChats: true });
  });

  it("classifies the computer tools it reasons about like the registry", () => {
    expect(computerToolKind("browser_click")).toBe("browser");
    expect(computerToolKind("desktop_click")).toBe("desktop");
    expect(computerToolKind("mcp_js", { hostDesktopMcp: true })).toBe("host");
  });
});
