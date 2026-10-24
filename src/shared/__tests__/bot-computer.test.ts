import { describe, expect, it } from "vitest";
import {
  computerToolKind,
  isComputerToolBlocked,
  isValidDesktopHost,
  narrowestBotWorksOn,
  normalizeBotWorksOn,
} from "../bot-computer";

describe("bot computer settings", () => {
  it("treats a missing or unknown setting as Auto", () => {
    expect(normalizeBotWorksOn(undefined)).toBe("auto");
    expect(normalizeBotWorksOn("cloud")).toBe("auto");
    expect(normalizeBotWorksOn("browser")).toBe("browser");
  });

  it("keeps the narrower of two settings", () => {
    expect(narrowestBotWorksOn("auto", "browser")).toBe("browser");
    expect(narrowestBotWorksOn("this_computer", "off")).toBe("off");
    expect(narrowestBotWorksOn(undefined, "browser")).toBe("browser");
    expect(narrowestBotWorksOn("auto", undefined)).toBe("auto");
    expect(narrowestBotWorksOn(undefined, null)).toBeUndefined();
    expect(narrowestBotWorksOn("browser", "own_desktop")).toBe("off");
    expect(narrowestBotWorksOn("own_desktop", "browser")).toBe("off");
  });

  it("knows which computer a tool acts on", () => {
    expect(computerToolKind("click")).toBe("host");
    expect(computerToolKind("native_app")).toBe("host");
    expect(computerToolKind("run_applescript")).toBe("host");
    // The user's own terminal tabs are on this computer, like its clipboard.
    expect(computerToolKind("read_terminal")).toBe("host");
    expect(computerToolKind("list_terminal_tabs")).toBe("host");
    expect(computerToolKind("browser_navigate")).toBe("browser");
    expect(computerToolKind("mcp_js", { hostDesktopMcp: true })).toBe("host");
    expect(computerToolKind("read_file")).toBeNull();
    expect(computerToolKind("web_fetch")).toBeNull();
  });

  it("takes away only what a setting excludes", () => {
    expect(isComputerToolBlocked("browser", "host")).toBe(true);
    expect(isComputerToolBlocked("browser", "browser")).toBe(false);
    expect(isComputerToolBlocked("off", "browser")).toBe(true);
    expect(isComputerToolBlocked("off", "host")).toBe(true);
    expect(isComputerToolBlocked("off", null)).toBe(false);
    expect(isComputerToolBlocked("this_computer", "host")).toBe(false);
    expect(isComputerToolBlocked("auto", "host")).toBe(false);
    expect(isComputerToolBlocked(undefined, "host")).toBe(false);
  });
});

describe("the bot's own desktop", () => {
  it("offers desktop tools only to a bot set to work there", () => {
    expect(computerToolKind("desktop_click")).toBe("desktop");
    expect(isComputerToolBlocked("own_desktop", "desktop")).toBe(false);
    for (const setting of ["auto", "this_computer", "browser", "off", undefined] as const) {
      expect(isComputerToolBlocked(setting, "desktop")).toBe(true);
    }
  });

  it("keeps a bot on its own desktop off this computer and the in-app browser", () => {
    expect(isComputerToolBlocked("own_desktop", "host")).toBe(true);
    expect(isComputerToolBlocked("own_desktop", "browser")).toBe(true);
    expect(isComputerToolBlocked("own_desktop", "handoff")).toBe(false);
  });
});

describe("desktop servers", () => {
  it("accepts SSH host aliases and user@host only", () => {
    expect(isValidDesktopHost("my-server")).toBe(true);
    expect(isValidDesktopHost("me@example.com")).toBe(true);
    expect(isValidDesktopHost("-oProxyCommand=evil")).toBe(false);
    expect(isValidDesktopHost("host name")).toBe(false);
    expect(isValidDesktopHost(undefined)).toBe(false);
  });
});
