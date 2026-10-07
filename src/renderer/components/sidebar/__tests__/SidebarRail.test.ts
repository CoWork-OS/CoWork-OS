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
    const order = ["Home", "Inbox", "Bots", "Automations", "More", "Devices", "Settings"].map(
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

  it("shows icons only, naming each destination in its tooltip", () => {
    const markup = renderRail({ initialPinnedIds: ["missionControl"] });
    expect(markup).not.toContain("sidebar-rail-label");
    expect(markup).toMatch(/aria-label="Mission Control"[^>]*data-tooltip="Mission Control \(Ctrl\+5\)"/);
    expect(markup).toMatch(/aria-label="More"[^>]*data-tooltip="More"/);
  });

  it("numbers the rail for Ctrl+1–9, pinned items included", () => {
    const markup = renderRail();
    expect(markup).toMatch(/aria-keyshortcuts="Control\+1" data-tooltip="Home \(Ctrl\+1\)"/);
    expect(markup).toMatch(/aria-keyshortcuts="Control\+5" data-tooltip="Devices \(Ctrl\+5\)"/);
    // More and Settings aren't destinations to number.
    expect(markup).not.toMatch(/aria-label="More"[^>]*aria-keyshortcuts/);
    expect(markup).not.toMatch(/aria-label="Settings"[^>]*aria-keyshortcuts/);
  });

  it("uses ⌘ on macOS", () => {
    vi.stubGlobal("window", { electronAPI: { getPlatform: () => "darwin" } });
    const markup = renderRail();
    expect(markup).toMatch(/aria-keyshortcuts="Meta\+2" data-tooltip="Inbox \(⌘2\)"/);
  });

  it("follows a saved order, and the shortcuts follow it", () => {
    const markup = renderRail({ initialRailOrder: ["automations", "home"] });
    const order = ["Automations", "Home", "Inbox", "Bots"].map((label) =>
      markup.indexOf(`aria-label="${label}"`),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toMatch(/data-tooltip="Automations \(Ctrl\+1\)"/);
  });

  it("marks Settings as the current page while Settings is open", () => {
    const open = renderRail({ activeId: null, settingsActive: true });
    expect(open).toMatch(
      /class="sidebar-rail-btn active"[^>]*aria-current="page"[^>]*aria-label="Settings"/,
    );
    expect(renderRail()).not.toMatch(/aria-current="page"[^>]*aria-label="Settings"/);
  });

  it("lets destinations be dragged, but not More or Settings", () => {
    const markup = renderRail();
    expect(markup).toMatch(/draggable="true"[^>]*aria-label="Home"/);
    expect(markup).not.toMatch(/draggable="true"[^>]*aria-label="More"/);
    expect(markup).not.toMatch(/draggable="true"[^>]*aria-label="Settings"/);
  });
});
