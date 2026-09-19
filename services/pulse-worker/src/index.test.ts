import { describe, expect, it } from "vitest";
import { validateDaily, validateEnrollment } from "./index";

const daily = {
  schemaVersion: 1,
  packageId: "a".repeat(64),
  installationId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  period: { start: "2026-09-03T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z" },
  client: { version: "0.5.52", platform: "macos", architecture: "arm64", runtime: "desktop" },
  activity: {
    sessionsStarted: 2,
    tasksStarted: 3,
    tasksCompleted: 2,
    usefulTasks: 1,
    activeMinutesBucket: "16-60",
  },
  tools: { shell: 1, filesystem: 2, browser: 0, connector: 0, code: 1, other: 0 },
  reliability: {
    failedTasks: 0,
    cancelledTasks: 0,
    approvalRequests: 1,
    approvalDenials: 0,
    toolErrors: 0,
    llmErrors: 0,
  },
};

describe("Pulse collector schemas", () => {
  it("accepts the closed v1 enrollment schema", () => {
    expect(
      validateEnrollment({
        schemaVersion: 1,
        installationId: daily.installationId,
        deletionToken: "x".repeat(43),
        consentVersion: "2026-09-04",
      }),
    ).toBeNull();
  });

  it("accepts a valid content-free daily package", () => {
    expect(validateDaily(daily)).toBeNull();
  });

  it("rejects unknown fields and unbounded values", () => {
    expect(validateDaily({ ...daily, prompt: "secret" })).toBe("unknown_or_missing_field");
    expect(validateDaily({ ...daily, activity: { ...daily.activity, usefulTasks: 100_001 } })).toBe(
      "invalid_usefulTasks",
    );
  });
});
