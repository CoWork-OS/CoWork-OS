import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SidebarRail } from "../SidebarRail";
import type { SidebarRailProps } from "../SidebarRail";

function renderRail(props: Partial<SidebarRailProps> = {}) {
  return renderToStaticMarkup(
    React.createElement(SidebarRail, {
      activeId: "home",
      onNavigate: () => {},
      onOpenSettings: () => {},
      initialPinnedIds: ["devices"],
      ...props,
    }),
  );
}

describe("SidebarRail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders fixed destinations, then More, then pinned items, with Settings last", () => {
    const markup = renderRail();
    const order = ["Home", "Inbox", "Agents", "Automations", "More", "Devices", "Settings"].map(
      (label) => markup.indexOf(`aria-label="${label}"`),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain('class="sidebar-rail-divider"');
    expect(markup).not.toContain('aria-label="Mission Control"');
    expect(markup).not.toContain('aria-label="Library"');
  });

  it("marks the active destination as the current page", () => {
    const markup = renderRail({ activeId: "automations" });
    expect(markup).toMatch(
      /class="sidebar-rail-btn active"[^>]*aria-current="page"[^>]*aria-label="Automations"/,
    );
  });

  it("highlights More while an unpinned More destination is open", () => {
    const markup = renderRail({ activeId: "missionControl", initialPinnedIds: [] });
    expect(markup).toMatch(/class="sidebar-rail-btn active"[^>]*aria-expanded="false"/);
    expect(markup).not.toContain("sidebar-rail-divider");
  });

  it("shows an installable update as its own item above Settings", () => {
    const markup = renderRail({ updateAvailable: true, onViewUpdate: () => {} });
    expect(markup).toMatch(
      /class="sidebar-rail-btn sidebar-rail-update"[^>]*aria-label="Update available"[\s\S]*aria-label="Settings"/,
    );
    expect(markup).not.toContain("sidebar-rail-dot");
  });

  it("only flags Settings when the update can't be installed here", () => {
    const markup = renderRail({
      updateAvailable: true,
      updateSupported: false,
      onViewUpdate: () => {},
    });
    expect(markup).not.toContain("sidebar-rail-update");
    expect(markup).toContain('aria-label="Settings, update available"');
    expect(markup).toContain("sidebar-rail-dot");
  });

  it("adds Library in the Calm theme", () => {
    vi.stubGlobal("document", {
      documentElement: { classList: { contains: (name: string) => name === "visual-calm" } },
    });
    const markup = renderRail();
    expect(markup).toContain('aria-label="Library"');
  });

  it("captions each destination under its icon, using the short rail label", () => {
    const markup = renderRail({ initialPinnedIds: ["missionControl"] });
    expect(markup).toContain('class="sidebar-rail-label" aria-hidden="true">Home</span>');
    expect(markup).toContain('class="sidebar-rail-label" aria-hidden="true">Missions</span>');
    expect(markup).toMatch(/aria-label="Mission Control"[^>]*title="Mission Control"/);
  });
});
