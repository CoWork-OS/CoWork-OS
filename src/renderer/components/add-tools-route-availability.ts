export type AddToolsRouteAvailability = {
  kind: "available" | "read_only" | "unavailable";
  message: string;
  action: string;
};

export function getAddToolsRouteAvailability(
  tab: string,
  isBrowserHost: boolean,
  hasMethods: (...methods: string[]) => boolean,
): AddToolsRouteAvailability {
  if (!isBrowserHost) {
    return { kind: "available", message: "", action: "Open setup" };
  }

  switch (tab) {
    case "customize":
      return hasMethods("listPluginPacks", "searchPackRegistry")
        ? {
            kind: "read_only",
            message: hasMethods("togglePluginPack", "togglePluginPackSkill")
              ? "View and enable installed packs and skills here. Installing or importing packs requires the desktop app."
              : "View installed packs and browse the catalog here. Installing or changing packs requires the desktop app.",
            action: "View packs",
          }
        : {
            kind: "unavailable",
            message: "Feature Pack details are unavailable on this browser host.",
            action: "Unavailable here",
          };
    case "skills":
      return hasMethods(
        "listSkills",
        "getSkill",
        "getSkillStatus",
        "listQuarantinedImports",
        "searchSkillRegistry",
        "searchClawHubSkills",
      )
        ? {
            kind: "read_only",
            message:
              "Browse skills and check requirements here. Install, import, or remove skills in the desktop app.",
            action: "Browse skills",
          }
        : {
            kind: "unavailable",
            message: "Skill browsing is unavailable on this browser host.",
            action: "Unavailable here",
          };
    case "integrations":
      return hasMethods("getConnectorSettings")
        ? {
            kind: "read_only",
            message: "Connector setup and account changes are available in the desktop app.",
            action: "View connectors",
          }
        : {
            kind: "unavailable",
            message: "Connector and native integration setup is unavailable on this browser host.",
            action: "Unavailable here",
          };
    case "mcp":
      return hasMethods("getMCPSettings", "saveMCPSettings")
        ? { kind: "available", message: "", action: "Open setup" }
        : {
            kind: "unavailable",
            message:
              "MCP catalog and status are readable here, but install and configuration require the desktop app.",
            action: "Desktop setup required",
          };
    case "tools":
      return hasMethods("getBuiltinToolsSettings", "saveBuiltinToolsSettings")
        ? { kind: "available", message: "", action: "Open setup" }
        : {
            kind: "unavailable",
            message: "Built-in tool settings are unavailable on this browser host.",
            action: "Unavailable here",
          };
    default:
      return {
        kind: "unavailable",
        message: "Channel and system settings are available in the desktop app.",
        action: "Desktop setup required",
      };
  }
}
