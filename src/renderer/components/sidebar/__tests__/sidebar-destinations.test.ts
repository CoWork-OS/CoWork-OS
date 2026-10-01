import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PINNED_SIDEBAR_DESTINATIONS,
  SIDEBAR_RAIL_STORAGE_KEY,
  getActiveSidebarDestination,
  getSidebarDestination,
  getSidebarRailLayout,
  isSidebarDestinationAvailable,
  readPinnedSidebarDestinations,
  togglePinnedSidebarDestination,
  writePinnedSidebarDestinations,
} from "../sidebar-destinations";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

describe("getActiveSidebarDestination", () => {
  it("maps app views to rail destinations", () => {
    expect(getActiveSidebarDestination("main", "sessions")).toBe("home");
    expect(getActiveSidebarDestination("home", "sessions")).toBe("home");
    expect(getActiveSidebarDestination("inboxAgent", "sessions")).toBe("inbox");
    expect(getActiveSidebarDestination("agents", "sessions")).toBe("agents");
    expect(getActiveSidebarDestination("missionControl", "sessions")).toBe("missionControl");
    expect(getActiveSidebarDestination("git", "sessions")).toBe("gitChanges");
    expect(getActiveSidebarDestination("settings", "sessions")).toBeNull();
  });

  it("keeps Agents highlighted while the panel shows the bot roster", () => {
    expect(getActiveSidebarDestination("main", "bots")).toBe("agents");
    expect(getActiveSidebarDestination("agents", "bots")).toBe("agents");
    expect(getActiveSidebarDestination("automations", "bots")).toBe("automations");
  });
});

describe("getSidebarRailLayout", () => {
  it("shows calm-only destinations only in the Calm theme", () => {
    const desktop = getSidebarRailLayout({ isCalm: false, isBrowserHost: false }, []);
    expect(ids(desktop.rail)).toEqual(["home", "inbox", "agents", "automations"]);
    expect(ids(desktop.more)).toEqual([
      "devices",
      "everyday",
      "missionControl",
      "ideas",
      "addTools",
    ]);

    const calm = getSidebarRailLayout({ isCalm: true, isBrowserHost: false }, []);
    expect(ids(calm.rail)).toContain("library");
    expect(ids(calm.more)).toContain("build");
  });

  it("orders pinned items by pin order and drops ones that are not visible", () => {
    const layout = getSidebarRailLayout({ isCalm: false, isBrowserHost: false }, [
      "ideas",
      "build",
      "devices",
    ]);
    expect(ids(layout.pinned)).toEqual(["ideas", "devices"]);
  });

  it("hides Git Changes on the desktop app", () => {
    const layout = getSidebarRailLayout({ isCalm: false, isBrowserHost: false }, []);
    expect(ids(layout.rail)).not.toContain("gitChanges");
  });
});

describe("rail pin persistence", () => {
  it("starts with the default pins", () => {
    expect(readPinnedSidebarDestinations(memoryStorage())).toEqual([
      ...DEFAULT_PINNED_SIDEBAR_DESTINATIONS,
    ]);
  });

  it("keeps an explicit empty pin list", () => {
    const storage = memoryStorage();
    writePinnedSidebarDestinations([], storage);
    expect(readPinnedSidebarDestinations(storage)).toEqual([]);
  });

  it("round-trips pins and ignores unknown, fixed, and duplicate ids", () => {
    const storage = memoryStorage({
      [SIDEBAR_RAIL_STORAGE_KEY]: JSON.stringify({
        pinned: ["ideas", "home", "nope", "ideas", 7, "missionControl"],
      }),
    });
    expect(readPinnedSidebarDestinations(storage)).toEqual(["ideas", "missionControl"]);
  });

  it("falls back to the defaults when storage holds invalid data", () => {
    const storage = memoryStorage({ [SIDEBAR_RAIL_STORAGE_KEY]: "{not json" });
    expect(readPinnedSidebarDestinations(storage)).toEqual([
      ...DEFAULT_PINNED_SIDEBAR_DESTINATIONS,
    ]);
  });

  it("toggles a pin on and off", () => {
    expect(togglePinnedSidebarDestination(["devices"], "ideas")).toEqual(["devices", "ideas"]);
    expect(togglePinnedSidebarDestination(["devices", "ideas"], "devices")).toEqual(["ideas"]);
  });
});

describe("isSidebarDestinationAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows every destination on the desktop app", () => {
    expect(isSidebarDestinationAvailable(getSidebarDestination("automations"))).toBe(true);
  });

  it("requires the host methods in a browser session", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: { desktopMethods: { listRoutines: true } },
    });
    expect(isSidebarDestinationAvailable(getSidebarDestination("automations"))).toBe(true);
    expect(isSidebarDestinationAvailable(getSidebarDestination("inbox"))).toBe(false);
    expect(isSidebarDestinationAvailable(getSidebarDestination("ideas"))).toBe(true);
  });
});
