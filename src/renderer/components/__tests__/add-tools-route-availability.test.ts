import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { getAddToolsRouteAvailability } from "../add-tools-route-availability";
import { AddToolsPanel } from "../AddToolsPanel";

function renderBrowserPanel(...methods: string[]) {
  vi.stubGlobal("window", {
    coworkBrowserHost: true,
    coworkBrowserHostInfo: {
      desktopMethods: Object.fromEntries(methods.map((name) => [name, true])),
    },
  });
  return renderToStaticMarkup(React.createElement(AddToolsPanel, { onNavigate: () => {} }));
}

describe("Add Tools route availability", () => {
  const withMethods =
    (...available: string[]) =>
    (...required: string[]) =>
      required.every((method) => available.includes(method));

  it("keeps native setup routes available", () => {
    expect(getAddToolsRouteAvailability("mcp", false, () => false)).toEqual({
      kind: "available",
      message: "",
      action: "Open setup",
    });
  });

  it("lets the browser open Feature Packs for browsing while explaining writes stay desktop-only", () => {
    expect(
      getAddToolsRouteAvailability(
        "customize",
        true,
        withMethods("listPluginPacks", "searchPackRegistry"),
      ),
    ).toEqual({
      kind: "read_only",
      message:
        "View installed packs and browse the catalog here. Installing or changing packs requires the desktop app.",
      action: "View packs",
    });
  });

  it("disables a catalog route if its required read methods are missing", () => {
    expect(
      getAddToolsRouteAvailability("customize", true, withMethods("listPluginPacks")),
    ).toMatchObject({ kind: "unavailable", action: "Unavailable here" });
  });

  it("labels readable skill and connector destinations as read-only", () => {
    expect(
      getAddToolsRouteAvailability(
        "skills",
        true,
        withMethods(
          "listSkills",
          "getSkill",
          "getSkillStatus",
          "listQuarantinedImports",
          "searchSkillRegistry",
          "searchClawHubSkills",
        ),
      ),
    ).toMatchObject({ kind: "read_only", action: "Browse skills" });
    expect(
      getAddToolsRouteAvailability("integrations", true, withMethods("getConnectorSettings")),
    ).toMatchObject({ kind: "read_only", action: "View connectors" });
  });

  it("disables unsupported configuration and channel routes with an explanation", () => {
    for (const route of ["mcp", "tools", "slack", "system"]) {
      expect(getAddToolsRouteAvailability(route, true, () => false)).toMatchObject({
        kind: "unavailable",
      });
    }
  });

  it("renders browser destinations as disabled or read-only according to their available methods", () => {
    const markup = renderBrowserPanel(
      "listPluginPacks",
      "searchPackRegistry",
      "getConnectorSettings",
    );

    expect(markup).toContain("View installed packs and browse the catalog here");
    expect(markup).toContain("Installing or changing packs requires the desktop app.");
    expect(markup).toContain("MCP catalog and status are readable here");
    expect(markup).toContain(
      "Connector setup and account changes are available in the desktop app.",
    );

    const paths = [
      ...markup.matchAll(/<button[^>]*class="add-tools-path"[^>]*>[\s\S]*?<\/button>/g),
    ];
    const packPath = paths.find(([markup]) => markup.includes("Feature Packs &amp; Plugins"))?.[0];
    const mcpPath = paths.find(([markup]) => markup.includes("MCP servers"))?.[0];
    expect(packPath).toBeDefined();
    expect(packPath).not.toContain("disabled");
    expect(mcpPath).toContain("disabled");
  });
});
