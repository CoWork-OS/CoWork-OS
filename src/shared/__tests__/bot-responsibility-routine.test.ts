import { describe, expect, it } from "vitest";
import { buildPausedResponsibilityRoutine } from "../bot-responsibility-routine";

const scope = { workspaceId: "workspace", agentRoleId: "my-bot" };
describe("inline paused responsibility setup", () => {
  it.each(["manual", "hourly", "daily", "weekdays"] as const)(
    "keeps %s inert and scoped to the chosen bot",
    (timing) => {
      const payload = buildPausedResponsibilityRoutine({
        scope,
        name: "My routine",
        timing,
        timezone: "Europe/Lisbon",
      });
      expect(payload.enabled).toBe(false);
      expect(payload.workspaceId).toBe(scope.workspaceId);
      expect(payload.contextBindings.metadata?.assignedAgentRoleId).toBe(scope.agentRoleId);
      expect(payload.outputs).toEqual([{ kind: "task_only" }]);
      expect(payload.approvalPolicy.mode).toBe("strict_confirm");
      expect(payload.triggers?.[0].type).toBe(timing === "manual" ? "manual" : "schedule");
      if (timing === "daily" || timing === "weekdays")
        expect(payload.triggers?.[0]).toMatchObject({ schedule: { tz: "Europe/Lisbon" } });
    },
  );
  it("rejects invalid scope, names, timings and timezone before creating anything", () => {
    for (const patch of [
      { name: " " },
      { name: "x".repeat(121) },
      { timing: "unknown" },
      { timezone: "Bad/Zone" },
      { scope: { ...scope, workspaceId: "" } },
    ]) {
      expect(() =>
        buildPausedResponsibilityRoutine({
          scope,
          name: "Mine",
          timing: "daily",
          ...patch,
        } as Parameters<typeof buildPausedResponsibilityRoutine>[0]),
      ).toThrow();
    }
  });
});
