import { describe, expect, it } from "vitest";
import {
  CronJobCreateSchema,
  CronJobIdSchema,
  CronJobPatchSchema,
  CronListOptionsSchema,
  CronRunModeSchema,
  validateInput,
} from "../../utils/validation";

const WS = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const JOB_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/** Mirrors the payload built by the scheduled-task editor in ScheduledTasksSettings.tsx. */
function editorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Morning digest",
    description: undefined,
    workspaceId: WS,
    taskPrompt: "Summarize overnight email and calendar changes.",
    taskTitle: undefined,
    enabled: true,
    accessProfileId: "ask_for_approval",
    allowUserInput: false,
    deleteAfterRun: false,
    schedule: { kind: "every", everyMs: 60 * 60 * 1000, anchorMs: Date.now() },
    delivery: { enabled: false },
    ...overrides,
  };
}

const enabledDelivery = {
  enabled: true,
  channelType: "slack",
  channelDbId: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  channelId: "C0123456789",
  deliverOnSuccess: true,
  deliverOnError: true,
  summaryOnly: false,
  deliverOnlyIfResult: false,
};

describe("cron IPC schemas", () => {
  it("accepts the editor's create payloads for every schedule kind", () => {
    const schedules = [
      { kind: "every", everyMs: 5 * 60 * 1000, anchorMs: Date.now() },
      { kind: "cron", expr: "0 9 * * *" },
      { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Istanbul" },
      { kind: "at", atMs: Date.now() + 60_000 },
    ];
    for (const schedule of schedules) {
      expect(() =>
        validateInput(CronJobCreateSchema, editorPayload({ schedule, delivery: enabledDelivery })),
      ).not.toThrow();
    }
  });

  it("accepts the legacy shell-access variant the editor sends", () => {
    const { accessProfileId: _accessProfileId, ...legacy } = editorPayload();
    expect(() =>
      validateInput(CronJobCreateSchema, { ...legacy, shellAccess: false }),
    ).not.toThrow();
    expect(() => validateInput(CronJobPatchSchema, { ...legacy, shellAccess: true })).not.toThrow();
  });

  it("accepts the enable toggle patch used by the list and automation studio", () => {
    expect(validateInput(CronJobPatchSchema, { enabled: false })).toEqual({ enabled: false });
  });

  it("accepts the full edit patch from the editor", () => {
    expect(() =>
      validateInput(CronJobPatchSchema, editorPayload({ delivery: enabledDelivery })),
    ).not.toThrow();
  });

  it("requires the core fields on create", () => {
    for (const key of ["name", "enabled", "schedule", "workspaceId", "taskPrompt"]) {
      const payload = editorPayload();
      delete payload[key];
      expect(() => validateInput(CronJobCreateSchema, payload)).toThrow();
    }
  });

  it("rejects oversized strings", () => {
    expect(() =>
      validateInput(CronJobCreateSchema, editorPayload({ name: "n".repeat(501) })),
    ).toThrow(/name/);
    expect(() =>
      validateInput(CronJobCreateSchema, editorPayload({ taskPrompt: "p".repeat(500_001) })),
    ).toThrow(/taskPrompt/);
    expect(() => validateInput(CronJobPatchSchema, { description: "d".repeat(10_001) })).toThrow(
      /description/,
    );
    expect(() =>
      validateInput(CronJobPatchSchema, {
        delivery: { ...enabledDelivery, channelId: "c".repeat(513) },
      }),
    ).toThrow(/channelId/);
    expect(() =>
      validateInput(CronJobPatchSchema, { schedule: { kind: "cron", expr: "*".repeat(121) } }),
    ).toThrow(/expr/);
    expect(() => validateInput(CronJobIdSchema, "x".repeat(201))).toThrow();
  });

  it("rejects wrong types and out-of-range numbers", () => {
    expect(() => validateInput(CronJobPatchSchema, { enabled: "true" })).toThrow();
    expect(() => validateInput(CronJobPatchSchema, { taskPrompt: 42 })).toThrow();
    expect(() => validateInput(CronJobPatchSchema, { workspaceId: "../etc" })).toThrow();
    expect(() =>
      validateInput(CronJobPatchSchema, { schedule: { kind: "every", everyMs: 10 } }),
    ).toThrow();
    expect(() =>
      validateInput(CronJobPatchSchema, { schedule: { kind: "at", atMs: 1.5 } }),
    ).toThrow();
    expect(() =>
      validateInput(CronJobPatchSchema, { schedule: { kind: "weekly", everyMs: 1000 } }),
    ).toThrow();
    expect(() => validateInput(CronJobPatchSchema, { timeoutMs: -1 })).toThrow();
    expect(() => validateInput(CronJobPatchSchema, { maxHistoryEntries: 10_000 })).toThrow();
    expect(() => validateInput(CronJobPatchSchema, { runMode: "shell" })).toThrow();
    expect(() => validateInput(CronJobIdSchema, 123)).toThrow();
    expect(() => validateInput(CronJobIdSchema, "")).toThrow();
  });

  it("rejects delivery to an unknown channel type", () => {
    expect(() =>
      validateInput(CronJobPatchSchema, {
        delivery: { ...enabledDelivery, channelType: "carrier_pigeon" },
      }),
    ).toThrow(/channelType/);
  });

  it("rejects main-process-owned and unknown fields", () => {
    expect(() =>
      validateInput(CronJobPatchSchema, { state: { runHistory: [], totalRuns: 99 } }),
    ).toThrow(/state/);
    expect(() =>
      validateInput(
        CronJobCreateSchema,
        editorPayload({ taskAgentConfig: { autonomousMode: true } }),
      ),
    ).toThrow(/taskAgentConfig/);
    expect(() =>
      validateInput(CronJobPatchSchema, { chatContext: { channelType: "slack", channelId: "C1" } }),
    ).toThrow(/chatContext/);
    expect(() =>
      validateInput(CronJobPatchSchema, { delivery: { enabled: true, webhookUrl: "http://x" } }),
    ).toThrow(/webhookUrl/);
  });

  it("rejects prototype-pollution keys at every level", () => {
    const topLevel = JSON.parse(
      JSON.stringify(editorPayload()).replace(/^\{/, '{"__proto__":{"polluted":true},'),
    );
    expect(Object.hasOwn(topLevel, "__proto__")).toBe(true);
    expect(() => validateInput(CronJobCreateSchema, topLevel)).toThrow(/__proto__/);

    const nested = JSON.parse('{"delivery":{"enabled":true,"__proto__":{"polluted":true}}}');
    expect(() => validateInput(CronJobPatchSchema, nested)).toThrow(/delivery: .*__proto__/);

    const constructorKey = JSON.parse('{"enabled":true,"constructor":{"prototype":{}}}');
    expect(() => validateInput(CronJobPatchSchema, constructorKey)).toThrow(/constructor/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates list options and run mode", () => {
    expect(validateInput(CronListOptionsSchema, undefined)).toBeUndefined();
    expect(validateInput(CronListOptionsSchema, { includeDisabled: true })).toEqual({
      includeDisabled: true,
    });
    expect(() => validateInput(CronListOptionsSchema, { includeDisabled: "yes" })).toThrow();
    expect(validateInput(CronRunModeSchema, "force")).toBe("force");
    expect(validateInput(CronRunModeSchema, undefined)).toBeUndefined();
    expect(() => validateInput(CronRunModeSchema, "now")).toThrow();
    expect(validateInput(CronJobIdSchema, JOB_ID)).toBe(JOB_ID);
  });
});
