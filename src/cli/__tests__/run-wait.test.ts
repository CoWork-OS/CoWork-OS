import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import { describeUserActionStop, validateRunTimeoutMs } from "../run-wait";

type WaitTask = Parameters<typeof describeUserActionStop>[0];

function task(overrides: Partial<WaitTask>): WaitTask {
  return { id: "task-1", status: "executing" as Task["status"], ...overrides };
}

const profilePause = task({
  status: "paused",
  terminalStatus: "needs_user_action",
  awaitingUserInputReasonCode: "access_profile_unavailable",
  error:
    "The selected access profile is unavailable. Choose a valid profile before running this task.",
});

describe("describeUserActionStop", () => {
  it("stops at an unavailable access profile even without --exit-on-input", () => {
    expect(describeUserActionStop(profilePause, { exitOnInput: false })).toEqual({
      payload: {
        type: "needs_user_action",
        reason: "access_profile_unavailable",
        taskId: "task-1",
        message:
          "The selected access profile is unavailable. Choose a valid profile before running this task.",
      },
      text: "Needs your action: The selected access profile is unavailable. Choose a valid profile before running this task.",
    });
  });

  it("stops at other pauses that need a person only with --exit-on-input", () => {
    const question = task({
      status: "paused",
      terminalStatus: "needs_user_action",
      awaitingUserInputReasonCode: "skill_parameters",
    });

    expect(describeUserActionStop(question, { exitOnInput: false })).toBeNull();
    expect(describeUserActionStop(question, { exitOnInput: true })?.payload).toEqual({
      type: "needs_user_action",
      reason: "skill_parameters",
      taskId: "task-1",
      message: "The task is waiting for a person to act.",
    });
  });

  it.each([
    ["running", task({ status: "executing" })],
    ["paused while an operation finishes", task({ status: "paused" })],
    [
      "blocked on independent verification",
      task({ status: "blocked", terminalStatus: "awaiting_verification" }),
    ],
    ["blocked on an approval", task({ status: "blocked", terminalStatus: "awaiting_approval" })],
  ])("keeps waiting when the task is %s", (_label, current) => {
    expect(describeUserActionStop(current, { exitOnInput: true })).toBeNull();
  });
});

describe("validateRunTimeoutMs", () => {
  it("accepts no limit or a positive whole number", () => {
    expect(validateRunTimeoutMs(undefined)).toBeUndefined();
    expect(validateRunTimeoutMs(120000)).toBe(120000);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (value) => {
    expect(() => validateRunTimeoutMs(value)).toThrow(
      "--timeout-ms must be a whole number of milliseconds greater than 0.",
    );
  });
});
