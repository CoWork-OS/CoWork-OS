import { afterEach, describe, expect, it } from "vitest";
import { approvalPromptsDisabled } from "../approval-policy";

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
