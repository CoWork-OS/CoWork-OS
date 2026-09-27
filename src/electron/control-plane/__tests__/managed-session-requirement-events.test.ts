import { describe, expect, it } from "vitest";
import {
  sanitizeManagedSessionCreateParams,
  sanitizeManagedSessionSendEventParams,
} from "../handlers";

describe("managed-session requirement event validation", () => {
  const correction = {
    type: "requirement.corrected",
    requirementId: "successCriteria:file_exists:0",
    statement: "The approved report must exist at the revised path",
    criterion: { type: "file_exists", targetPath: "approved/report.txt" },
    idempotencyKey: "correction:approved-report:v2",
  };

  it("accepts an exact typed user correction through the managed-session event request", () => {
    expect(
      sanitizeManagedSessionSendEventParams({ sessionId: "session-1", event: correction }),
    ).toEqual({ sessionId: "session-1", event: correction });
  });

  it("rejects malformed requirement IDs, unsupported criteria, client status, and owner claims", () => {
    for (const event of [
      { ...correction, requirementId: " " },
      { ...correction, criterion: { type: "file_exists", targetPath: " " } },
      { ...correction, criterion: { type: "shell_command", command: "echo pass" } },
      { ...correction, status: "satisfied" },
      { ...correction, owner: "user" },
    ]) {
      expect(() =>
        sanitizeManagedSessionSendEventParams({ sessionId: "session-1", event }),
      ).toThrow();
    }
  });

  it("accepts only explicit, bounded success criteria when a managed session is created", () => {
    expect(
      sanitizeManagedSessionCreateParams({
        agentId: "agent-1",
        environmentId: "environment-1",
        title: "Create report",
        successCriteria: { type: "file_exists", filePaths: ["reports/final.txt"] },
      }).successCriteria,
    ).toEqual({ type: "file_exists", filePaths: ["reports/final.txt"] });
    expect(() =>
      sanitizeManagedSessionCreateParams({
        agentId: "agent-1",
        environmentId: "environment-1",
        title: "Create report",
        successCriteria: {
          type: "file_exists",
          filePaths: ["reports/final.txt"],
          status: "satisfied",
        },
      }),
    ).toThrow();
  });
});
