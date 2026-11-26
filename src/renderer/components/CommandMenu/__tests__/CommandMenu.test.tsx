import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "../../../../shared/types";
import { CommandMenu, type CommandMenuProps } from "../CommandMenu";

function render(overrides: Partial<CommandMenuProps> = {}): string {
  const noop = () => {};
  return renderToStaticMarkup(
    createElement(CommandMenu, {
      tasks: [{ id: "t1", title: "Quarterly report", prompt: "", updatedAt: 1 } as Task],
      workspaceId: "ws-1",
      actions: [
        { id: "new", title: "New session", shortcut: "⌘N", action: { type: "new-session" } },
      ],
      settingsIndex: [{ tab: "voice", label: "Voice Mode", group: "General", terms: [] }],
      onClose: noop,
      onRunAction: noop,
      onOpenSession: noop,
      onOpenMessageHit: noop,
      onOpenSettingsTab: noop,
      ...overrides,
    }),
  );
}

describe("CommandMenu", () => {
  it("renders a modal dialog with a search box, the first row selected, and scope tabs", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Command menu"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-activedescendant="command-menu-action:new"');
    expect(html).toMatch(/aria-selected="true"[^>]*class="command-menu-item is-selected"/);
    for (const scope of ["All", "Actions", "Sessions", "Settings", "Messages", "Shortcuts"]) {
      expect(html).toContain(`>${scope}</button>`);
    }
  });

  it("lists actions with their shortcut and recent sessions before anything is typed", () => {
    const html = render();
    expect(html).toContain("New session");
    expect(html).toContain("<kbd");
    expect(html).toContain("⌘N");
    expect(html).toContain("Recent sessions");
    expect(html).toContain("Quarterly report");
    // Settings rows wait for a query in the combined view.
    expect(html).not.toContain("Voice Mode");
  });

  it("opens on the Shortcuts scope with each shortcut's keys", () => {
    const html = render({
      initialScope: "shortcuts",
      shortcuts: [{ id: "tab", title: "New tab", keys: "⌘T", where: "Browser" }],
    });
    expect(html).toMatch(/aria-selected="true"[^>]*>Shortcuts<\/button>/);
    expect(html).toContain("New tab");
    expect(html).toContain("Browser");
    expect(html).toContain("⌘T");
    expect(html).not.toContain("Quarterly report");
  });

  it("says so when there is nothing to show", () => {
    expect(render({ tasks: [], actions: [] })).toContain("No results");
  });
});

describe("command menu wiring", () => {
  const read = (file: string) => readFileSync(resolve(__dirname, "../../..", file), "utf8");

  it("is opened from the app shell and no longer steals Cmd+K for the sidebar search", () => {
    const app = read("App.tsx");
    expect(app).toContain("isCommandMenuShortcut(event)");
    expect(app).toContain("<CommandMenu");
    const sidebar = read("components/Sidebar.tsx");
    expect(sidebar).not.toContain("focusSessionSearch");
    expect(sidebar).not.toContain("aria-keyshortcuts");
  });

  it("passes the sidebar's session order to the keyboard navigation", () => {
    expect(read("App.tsx")).toContain("onSessionOrderChange={handleSidebarSessionOrderChange}");
    expect(read("components/Sidebar.tsx")).toContain(
      "sessionOrderFromSidebarRows(sidebarVirtualRows)",
    );
  });

  it("remounts Settings so a section picked while Settings is open takes effect", () => {
    expect(read("App.tsx")).toContain("key={settingsNavKey}");
  });
});
