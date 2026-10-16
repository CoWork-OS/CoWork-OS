import { describe, expect, it } from "vitest";
import {
  computerToolKind,
  isComputerToolBlocked,
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
  });

  it("knows which computer a tool acts on", () => {
    expect(computerToolKind("click")).toBe("host");
    expect(computerToolKind("native_app")).toBe("host");
    expect(computerToolKind("run_applescript")).toBe("host");
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
