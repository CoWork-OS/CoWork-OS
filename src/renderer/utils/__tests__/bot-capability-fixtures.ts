import type { BotCapabilitySummary } from "../../../shared/bot-capabilities";
import { EXPLICIT_CONSENT_KINDS } from "../../../shared/explicit-consent";

/** A bot capability summary for copy and rendering tests. */
export function capabilitySummary(
  overrides: Partial<BotCapabilitySummary> = {},
): BotCapabilitySummary {
  return {
    workspaceId: "ws-1",
    agentRoleId: "bot-1",
    where: {
      worksOn: "auto",
      reach: { host: true, browser: true, desktop: false, handoff: true },
    },
    files: { fileAccess: "own_folder", onItsOwn: "own_folder" },
    services: {
      items: [
        {
          id: "gmail",
          label: "Gmail",
          source: "builtin",
          connected: true,
          use: "yes",
          limited: false,
        },
        {
          id: "cal",
          label: "Calendar",
          source: "builtin",
          connected: true,
          use: "yes",
          limited: false,
        },
        {
          id: "mcp:files",
          label: "Files",
          source: "mcp",
          connected: true,
          use: "chats_you_start_only",
          limited: false,
        },
        {
          id: "mcp:linear",
          label: "Linear",
          source: "mcp",
          connected: true,
          use: "yes",
          limited: true,
        },
        {
          id: "box",
          label: "Box",
          source: "builtin",
          connected: false,
          use: "denied_for_bot",
          limited: false,
        },
      ],
      channels: [{ id: "c1", label: "Team Slack", link: "default" }],
    },
    schedules: {
      runtime: "running",
      scheduled: 2,
      responsibilities: { active: 2, paused: 1 },
      checkIns: { enabled: false },
    },
    memory: { available: true, saved: 12, recallPastChats: true },
    safeguards: {
      mayDoAlone: { label: "No limit: each session's own access" },
      inChats: "asks",
      needsOk: EXPLICIT_CONSENT_KINDS,
      deniedTools: [],
      denyAll: false,
    },
    partial: [],
    ...overrides,
  };
}
