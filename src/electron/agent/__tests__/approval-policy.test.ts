import { afterEach, describe, expect, it } from "vitest";
import { approvalPromptsDisabled, canAnswerInlineApproval } from "../approval-policy";

describe("approval prompt policy", () => {
  const originalMode = process.env.COWORK_APPROVAL_PROMPTS;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
    else process.env.COWORK_APPROVAL_PROMPTS = originalMode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
  });

  it("defaults to no prompts outside test mode", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    delete process.env.COWORK_APPROVAL_PROMPTS;
    expect(approvalPromptsDisabled()).toBe(true);
  });

  it("allows diagnostics to opt back into the legacy queue", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    process.env.COWORK_APPROVAL_PROMPTS = "on";
    expect(approvalPromptsDisabled()).toBe(false);
  });

  it("keeps unit tests on the explicit approval path", () => {
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    delete process.env.COWORK_APPROVAL_PROMPTS;
    expect(approvalPromptsDisabled()).toBe(false);
  });
});

describe("inline approval availability", () => {
  const desktopTask = {
    id: "task-desktop",
    source: "manual",
    agentConfig: { accessProfileId: "ask_for_approval" },
  } as Any;

  it("treats an interactive desktop task as able to answer the inline card", () => {
    expect(canAnswerInlineApproval(desktopTask, { headless: false })).toBe(true);
    // A local bot chat pauses and asks in the conversation, like other bot apps.
    expect(
      canAnswerInlineApproval(
        { ...desktopTask, agentConfig: { ...desktopTask.agentConfig, botConversation: true } },
        { headless: false },
      ),
    ).toBe(true);
    expect(canAnswerInlineApproval({ id: "task-plain" } as Any, { headless: false })).toBe(true);
  });

  it.each([
    ["an unknown task", undefined, false],
    ["a headless runtime", desktopTask, true],
    [
      "a cowork run CLI task",
      { ...desktopTask, agentConfig: { cli: { owner: "cowork-run", runId: "run-1" } } },
      false,
    ],
    ["a sub-agent", { ...desktopTask, parentTaskId: "task-parent" }, false],
    [
      "a bot conversation linked to a channel",
      { ...desktopTask, agentConfig: { botConversation: true, gatewayContext: "private" } },
      false,
    ],
    ["a channel task", { ...desktopTask, agentConfig: { gatewayContext: "private" } }, false],
    ["a scheduled task", { ...desktopTask, source: "cron" }, false],
    ["a no-human-input task", { ...desktopTask, agentConfig: { humanInputPolicy: "none" } }, false],
    [
      "a task that disallows user input",
      { ...desktopTask, agentConfig: { allowUserInput: false } },
      false,
    ],
  ])("fails closed for %s", (_label, task, headless) => {
    expect(canAnswerInlineApproval(task as Any, { headless })).toBe(false);
  });
});
