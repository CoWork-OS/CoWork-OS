import { describe, expect, it } from "vitest";
import {
  getMessageAppShortcut,
  isValidSlashCommandName,
  parseLeadingMessageAppShortcut,
} from "../message-shortcuts";

describe("message shortcuts", () => {
  it("recognizes deterministic app shortcut commands", () => {
    const result = parseLeadingMessageAppShortcut("/plan migrate the docs");
    expect(result.matched).toBe(true);
    expect(result.shortcut?.name).toBe("plan");
    expect(result.args).toBe("migrate the docs");
  });

  it("does not match unknown slash commands", () => {
    expect(parseLeadingMessageAppShortcut("/geo-quick https://example.com").matched).toBe(false);
  });

  it("validates visible slash command tokens", () => {
    expect(isValidSlashCommandName("geo-quick")).toBe(true);
    expect(isValidSlashCommandName("GEO Quick")).toBe(false);
    expect(isValidSlashCommandName("-geo")).toBe(false);
  });

  it("looks up commands with or without a slash prefix", () => {
    expect(getMessageAppShortcut("/clear")?.action).toBe("clear");
    expect(getMessageAppShortcut("schedule")?.action).toBe("insert");
  });
});
