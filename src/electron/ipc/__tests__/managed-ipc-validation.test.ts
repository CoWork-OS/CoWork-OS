import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { StringIdSchema, validateInput } from "../../utils/validation";

/**
 * Managed Agents / environments / sessions IPC handlers take an ID from the
 * renderer. They must validate it in the main process before it reaches
 * ManagedSessionService (see issue #606).
 */
const MANAGED_ID_HANDLERS: Record<string, string> = {
  MANAGED_AGENT_GET_IPC: "agent ID",
  MANAGED_AGENT_RUNTIME_TOOL_CATALOG_IPC: "agent ID",
  MANAGED_AGENT_ARCHIVE_IPC: "agent ID",
  MANAGED_AGENT_PUBLISH_IPC: "agent ID",
  MANAGED_AGENT_SUSPEND_IPC: "agent ID",
  MANAGED_AGENT_ROUTINE_LIST_IPC: "agent ID",
  MANAGED_AGENT_INSIGHTS_GET_IPC: "agent ID",
  MANAGED_AGENT_SLACK_HEALTH_GET_IPC: "agent ID",
  MANAGED_ENVIRONMENT_GET_IPC: "environment ID",
  MANAGED_ENVIRONMENT_ARCHIVE_IPC: "environment ID",
  MANAGED_SESSION_GET_IPC: "session ID",
  MANAGED_SESSION_RESUME_IPC: "session ID",
  MANAGED_SESSION_CANCEL_IPC: "session ID",
  MANAGED_SESSION_WORKPAPER_GET_IPC: "session ID",
};

describe("managed IPC ID validation", () => {
  it("accepts valid IDs unchanged", () => {
    expect(validateInput(StringIdSchema, "agent_123", "agent ID")).toBe("agent_123");
    expect(validateInput(StringIdSchema, "a".repeat(100), "session ID")).toBe("a".repeat(100));
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { id: "x" }],
    ["an empty string", ""],
    ["an over-long string", "a".repeat(101)],
  ])("rejects %s", (_label, value) => {
    expect(() => validateInput(StringIdSchema, value, "agent ID")).toThrow(/agent ID/);
  });

  describe("handlers", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "handlers.ts"), "utf8");

    it.each(Object.entries(MANAGED_ID_HANDLERS))(
      "%s validates its ID before calling the service",
      (channel, context) => {
        const start = source.search(
          new RegExp(`ipcMain\\.handle\\(\\s*IPC_CHANNELS\\.${channel},`),
        );
        expect(start, channel).toBeGreaterThanOrEqual(0);
        const next = source.indexOf("ipcMain.handle(", start + 1);
        const body = source.slice(start, next === -1 ? undefined : next);
        const validation = body.search(
          new RegExp(`validateInput\\(StringIdSchema, \\w+, "${context}"\\)`),
        );
        const serviceCall = body.indexOf("managedSessionService.");
        expect(validation, channel).toBeGreaterThan(0);
        expect(serviceCall, channel).toBeGreaterThan(validation);
      },
    );
  });
});
