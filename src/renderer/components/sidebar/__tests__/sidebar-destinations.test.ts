import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PINNED_SIDEBAR_DESTINATIONS,
  SIDEBAR_RAIL_STORAGE_KEY,
  getActiveSidebarDestination,
  getSidebarDestination,
  getSidebarRailLayout,
  getSidebarRailShortcutTargets,
  isCustomSidebarRailOrder,
  isSidebarDestinationAvailable,
  moveSidebarDestination,
  readPinnedSidebarDestinations,
  readSidebarRailOrder,
  shiftSidebarDestination,
  togglePinnedSidebarDestination,
  writePinnedSidebarDestinations,
  writeSidebarRailOrder,
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

  it("applies a saved order and keeps unnamed items in default order after it", () => {
    const layout = getSidebarRailLayout(
      { isCalm: false, isBrowserHost: false },
      [],
      ["automations", "inbox"],
    );
    expect(ids(layout.rail)).toEqual(["automations", "inbox", "home", "agents"]);
  });
});

describe("rail shortcuts and reordering", () => {
  it("numbers at most nine destinations, rail first then pinned", () => {
    const layout = getSidebarRailLayout({ isCalm: true, isBrowserHost: false }, [
      "devices",
      "everyday",
      "missionControl",
      "ideas",
      "build",
      "addTools",
    ]);
    const targets = getSidebarRailShortcutTargets(layout);
    expect(targets).toHaveLength(9);
    expect(ids(targets).slice(0, 6)).toEqual([
      "home",
      "inbox",
      "agents",
      "automations",
      "library",
      "devices",
    ]);
  });

  it("moves an item before or after another", () => {
    const list = ["home", "inbox", "agents", "automations"] as const;
    expect(moveSidebarDestination([...list], "automations", "inbox", "before")).toEqual([
      "home",
      "automations",
      "inbox",
      "agents",
    ]);
    expect(moveSidebarDestination([...list], "home", "agents", "after")).toEqual([
      "inbox",
      "agents",
      "home",
      "automations",
    ]);
    expect(moveSidebarDestination([...list], "home", "ideas", "after")).toEqual([...list]);
  });

  it("treats an order matching the default as not custom", () => {
    const context = { isCalm: false, isBrowserHost: false };
    expect(isCustomSidebarRailOrder(context, [])).toBe(false);
    expect(isCustomSidebarRailOrder(context, ["home", "inbox", "agents"])).toBe(false);
    expect(isCustomSidebarRailOrder(context, ["inbox", "home"])).toBe(true);
    // Calm's Library sits last by default, so naming it last isn't custom either.
    expect(
      isCustomSidebarRailOrder({ isCalm: true, isBrowserHost: false }, [
        "home",
        "inbox",
        "agents",
        "automations",
        "library",
      ]),
    ).toBe(false);
  });

  it("shifts an item one place and stops at the ends", () => {
    const list = ["home", "inbox", "agents"] as const;
    expect(shiftSidebarDestination([...list], "inbox", -1)).toEqual(["inbox", "home", "agents"]);
    expect(shiftSidebarDestination([...list], "inbox", 1)).toEqual(["home", "agents", "inbox"]);
    expect(shiftSidebarDestination([...list], "home", -1)).toEqual([...list]);
    expect(shiftSidebarDestination([...list], "agents", 1)).toEqual([...list]);
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

  it("stores the rail order beside the pins without either resetting the other", () => {
    const storage = memoryStorage();
    writeSidebarRailOrder(["agents", "home", "ideas"], storage);
    writePinnedSidebarDestinations(["ideas"], storage);
    // Only fixed rail items belong in the order.
    expect(readSidebarRailOrder(storage)).toEqual(["agents", "home"]);
    expect(readPinnedSidebarDestinations(storage)).toEqual(["ideas"]);

    writeSidebarRailOrder([], storage);
    expect(readSidebarRailOrder(storage)).toEqual([]);
    expect(readPinnedSidebarDestinations(storage)).toEqual(["ideas"]);
  });

  it("reads pins saved before the order existed", () => {
    const storage = memoryStorage({
      [SIDEBAR_RAIL_STORAGE_KEY]: JSON.stringify({ pinned: ["ideas"] }),
    });
    expect(readPinnedSidebarDestinations(storage)).toEqual(["ideas"]);
    expect(readSidebarRailOrder(storage)).toEqual([]);
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
