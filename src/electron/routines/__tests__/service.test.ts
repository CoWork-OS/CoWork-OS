import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HooksConfig } from "../../hooks/types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("RoutineService", () => {
  let db: import("better-sqlite3").Database;
  let RoutineServiceCtor: typeof import("../service").RoutineService;
  let EventTriggerServiceCtor: typeof import("../../triggers/EventTriggerService").EventTriggerService;
  let routineService: import("../service").RoutineService;
  let eventTriggerService: import("../../triggers/EventTriggerService").EventTriggerService;
  let hooksSettings: HooksConfig;
  let cronService: {
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");

    ({ RoutineService: RoutineServiceCtor } = await import("../service"));
    ({ EventTriggerService: EventTriggerServiceCtor } = await import(
      "../../triggers/EventTriggerService"
    ));

    hooksSettings = {
      enabled: true,
      token: "global-token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    cronService = {
      add: vi.fn().mockImplementation(async (job) => ({
        ok: true,
        job: { id: "cron-1", ...job, state: {} },
      })),
      update: vi.fn().mockImplementation(async (_id, patch) => ({
        ok: true,
        job: { id: "cron-1", ...patch, state: {} },
      })),
      remove: vi.fn().mockResolvedValue({ ok: true, removed: true }),
    };

    eventTriggerService = new EventTriggerServiceCtor({
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getDefaultWorkspaceId: () => "ws-default",
      log: vi.fn(),
    });
    eventTriggerService.start();

    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
    });
  });

  it("creates managed schedule, api, and connector-event triggers", async () => {
    const routine = await routineService.create({
      name: "PR Triage",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Review the incoming signal and draft the next action.",
      connectors: ["github", "linear"],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
          changeType: "resource_updated",
        },
      ],
    });

    expect(cronService.add).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(1);
    expect(hooksSettings.mappings[0]?.match?.path).toContain(`routines/${routine.id}/api-1`);
    expect(hooksSettings.mappings[0]?.token).toBeTruthy();
    expect(eventTriggerService.listTriggers()).toHaveLength(1);
    expect(
      routine.triggers.find((trigger) => trigger.type === "schedule" && trigger.managedCronJobId),
    ).toBeTruthy();
    expect(
      routine.triggers.find((trigger) => trigger.type === "api" && trigger.token),
    ).toBeTruthy();
    expect(
      routine.triggers.find(
        (trigger) => trigger.type === "connector_event" && trigger.managedEventTriggerId,
      ),
    ).toBeTruthy();
  });

  it("removes managed resources when a routine is deleted", async () => {
    const routine = await routineService.create({
      name: "Deploy Alerts",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Triage deployment alerts.",
      connectors: [],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "*/15 * * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
        },
      ],
    });

    const removed = await routineService.remove(routine.id);

    expect(removed).toBe(true);
    expect(cronService.remove).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(0);
    expect(eventTriggerService.listTriggers()).toHaveLength(0);
  });
});
