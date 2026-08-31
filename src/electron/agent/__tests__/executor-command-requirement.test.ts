import { describe, expect, it } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor command execution requirement detection", () => {
  it("treats SSH connectivity failure transcripts as execution-required", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "This is the azure VM private address but I cannot connect to it",
      "alice@host % ssh user@10.213.136.68",
      "Connection closed by 10.213.136.68 port 22",
      "Zscaler is open on my mac",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(true);
  });

  it("does not force command execution for non-troubleshooting shell mentions", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const requires = (TaskExecutor as Any).prototype.followUpRequiresCommandExecution.call(
      fakeThis,
      "Can you explain what SSH does and when to use it?",
    );
    expect(requires).toBe(false);
  });

  it("treats questions about an existing command as informational", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";
    fakeThis.lastNonVerificationOutput =
      "The prior task reported npm test and its package metadata.";
    fakeThis.lastAssistantOutput = fakeThis.lastNonVerificationOutput;

    const message = "What does the test command actually run?";
    expect(
      (TaskExecutor as Any).prototype.followUpRequiresCommandExecution.call(fakeThis, message),
    ).toBe(false);
    expect(
      (TaskExecutor as Any).prototype.isKnownContextInformationalFollowUp.call(fakeThis, message),
    ).toBe(true);
  });

  it("keeps explicit command requests on the tool-enabled path", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";
    fakeThis.lastNonVerificationOutput = "The prior task reported npm test.";
    fakeThis.lastAssistantOutput = fakeThis.lastNonVerificationOutput;

    expect(
      (TaskExecutor as Any).prototype.isKnownContextInformationalFollowUp.call(
        fakeThis,
        "Can you run npm test now?",
      ),
    ).toBe(false);
  });

  it("treats approval denial as a terminal follow-up blocker", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);

    expect(
      (TaskExecutor as Any).prototype.getApprovalBlockMessage.call(
        fakeThis,
        "run_command",
        "User denied approval",
      ),
    ).toBe(
      "Approval for the shell command was denied, so it was not executed. Approve it and retry if you want the action to run.",
    );
    expect(
      (TaskExecutor as Any).prototype.getApprovalBlockMessage.call(
        fakeThis,
        "run_command",
        "approval request timed out",
      ),
    ).toBe("Approval for the shell command timed out before it could run. No action was taken.");
    expect(
      (TaskExecutor as Any).prototype.getApprovalBlockMessage.call(
        fakeThis,
        "read_file",
        "ENOENT: no such file or directory",
      ),
    ).toBeNull();
  });

  it("keeps analyze mode read-only even for troubleshooting prompts", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "analyze";

    const requires = (TaskExecutor as Any).prototype.followUpRequiresCommandExecution.call(
      fakeThis,
      "ssh user@10.0.0.5 fails with connection refused. Please troubleshoot.",
    );
    expect(requires).toBe(false);
  });

  it("does not force shell execution for read-only documentation drift reports", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "auto";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Check for documentation drift in CoWork OS.",
      "Do not edit files.",
      "Review current repo evidence and report docs that need updates, exact source of truth in code/config, suggested documentation change, and priority.",
      "Look for stale commands, missing settings, and outdated behavior descriptions.",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(false);
  });

  it("still requires shell execution when the prompt explicitly asks to run commands", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "auto";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Check CoWork OS build health.",
      "Run npm run lint and npm run build, then report exact command results.",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(true);
  });

  it("does not exempt generic operational audits that explicitly need shell execution", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Troubleshoot backup health. Do not edit files.",
      "Run the backup status command and report findings with priority.",
      "The backup command fails intermittently with timeout errors.",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(true);
  });

  it("does not force execution for any task with read-only constraints (daily briefing)", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "auto";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Create my daily CoWork OS development brief.",
      "Do not edit files, commit, push, publish, post externally, or change settings.",
      "This routine is for situational awareness and prioritization only.",
      "Inspect the local repo and summarize:",
      "1. Current repo state - current branch, dirty files, untracked files",
      "2. Health signals - whether there are obvious build/type/test blockers",
      "3. Product/development priorities - read .cowork/PRIORITIES.md if present",
      "4. Suggested work for today - top 3 tasks ordered by leverage",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(false);
  });

  it("does not force execution for tasks with 'do not create files' constraint", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "auto";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Analyze the codebase architecture. Don't edit any files.",
      "Report back with a summary of how the modules are connected.",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(false);
  });

  it("still requires execution when read-only but explicitly asks to run commands", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "auto";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "Do not edit files.",
      "Run npm test and npm run build, then report the results.",
    ].join("\n");

    const requires = (TaskExecutor as Any).prototype.detectExecutionRequirement.call(
      fakeThis,
      prompt,
    );
    expect(requires).toBe(true);
  });
});
