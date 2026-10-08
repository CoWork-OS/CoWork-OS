import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor command execution requirement detection", () => {
  it.each([
    "Read qa-resumed.txt and reply with its contents. Do not run shell commands or modify files.",
    "Inspect the report without executing any terminal commands.",
    "Never execute commands. Read the existing build log.",
    "Explain the npm failure. Don't use shell commands.",
  ])("does not turn a command prohibition into an execution requirement: %s", (message) => {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "operations";
    executor.getEffectiveExecutionMode = () => "execute";
    expect(executor.followUpRequiresCommandExecution(message)).toBe(false);
  });

  it.each([
    "Create a Python script that deletes log files older than 30 days in ~/logs",
    "Write a bash script that renames all photos in ~/Pictures by date, I'll run it myself later",
    "Create a deploy script for our staging server",
    "Build a CLI script in Python that bulk-emails our customer list",
    "Write a build script that runs the tests before packaging",
    "Create a cleanup script but do not run it",
  ])("does not require execution for authoring a script: %s", (message) => {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveExecutionMode = () => "execute";
    expect(executor.followUpRequiresCommandExecution(message)).toBe(false);
    expect(executor.detectExecutionRequirement(message)).toBe(false);
  });

  it.each([
    "Create a Python script that prunes old log files and run it against ~/logs",
    "Write a migration script, then execute it on the staging database",
    "Create the deploy script and run the script for staging",
    "Run the cleanup script in scripts/cleanup.sh",
    "Install the solana cli and create a devnet wallet",
    "Set up the Solana CLI",
    "Build the CLI",
    "Create a backup script, then run npm test",
  ])("still requires execution when the request asks to run the artifact: %s", (message) => {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveExecutionMode = () => "execute";
    expect(executor.followUpRequiresCommandExecution(message)).toBe(true);
  });

  it("keeps an allowed command requirement when only a specific command is prohibited", () => {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "operations";
    executor.getEffectiveExecutionMode = () => "execute";
    expect(
      executor.followUpRequiresCommandExecution("Do not run npm test. Run npm run lint instead."),
    ).toBe(true);
  });

  it("treats SSH connectivity failure transcripts as execution-required", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "operations";
    fakeThis.getEffectiveExecutionMode = () => "execute";

    const prompt = [
      "This is the azure VM private address but I cannot connect to it",
      "alice@host % ssh user@192.0.2.10",
      "Connection closed by 192.0.2.10 port 22",
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

describe("TaskExecutor known-context informational follow-up routing", () => {
  const completedCodingSummary =
    "I updated Header.tsx and ran the tests. Two parser tests are still failing in parser.test.ts.";

  const isInformationalFollowUp = (message: string, lastOutput = completedCodingSummary) => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.getEffectiveTaskDomain = () => "code";
    fakeThis.getEffectiveExecutionMode = () => "execute";
    fakeThis.lastNonVerificationOutput = lastOutput;
    fakeThis.lastAssistantOutput = lastOutput;
    return (TaskExecutor as Any).prototype.isKnownContextInformationalFollowUp.call(
      fakeThis,
      message,
    );
  };

  it.each([
    "Do it",
    "Do it.",
    "Do the same for the remaining files",
    "Why is the test still failing?",
    "Why does the build still fail after your change?",
    "Is it working now?",
    "Which tests fail now?",
    "What's the coverage now?",
    "What does the build log say?",
    "Are there other places that need the same fix?",
    "What about the mobile layout? Fix that too.",
    "How about adding unit tests for the parser as well?",
    "Does the API handle pagination? If not, add it.",
    "Is there a memory leak in the worker? Please check.",
    "Where is the config loaded? Change it to use env vars.",
    "Explain and fix the remaining lint errors",
    "Tell me what broke and then update the snapshot.",
    "Do we use Redis for the session cache?",
    "Can you run npm test now?",
  ])("keeps work and work-status follow-ups on the tool-enabled path: %s", (message) => {
    expect(isInformationalFollowUp(message)).toBe(false);
  });

  it.each([
    "What does the test command actually run?",
    "Why did you choose a debounce instead of a throttle?",
    "What does that flag mean?",
    "Explain the change you made to the header",
    "How does the retry logic work?",
    "Can you explain the difference between the two approaches?",
    "Which of the two options is faster?",
  ])("answers genuine questions about the finished work from context: %s", (message) => {
    expect(isInformationalFollowUp(message)).toBe(true);
  });

  it.each([
    [
      "I fixed the header. Want me to apply the same fix to the footer?",
      "What would that involve?",
    ],
    [
      "The parser now handles empty input. I can also add tests for it. Let me know if you'd like me to.",
      "Why would we need them?",
    ],
    ["Should I go ahead and update the remaining components?", "Is that safe?"],
  ])(
    "does not answer from chat after the previous reply offered work (%s)",
    (lastOutput, message) => {
      expect(isInformationalFollowUp(message, lastOutput)).toBe(false);
    },
  );
});

describe("TaskExecutor test-run requirement", () => {
  function createTestRunExecutor(prompt: string): Any {
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.task = { id: "task-1", title: "Fix the sum bug", prompt };
    executor.workspace = { path: "/tmp/workspace" };
    executor.toolSemanticsV2Enabled = true;
    executor.lastUserMessage = prompt;
    executor.fileOperationTracker = {
      recordFileRead: vi.fn(),
      recordFileCreation: vi.fn(),
      invalidateFileRead: vi.fn(),
      invalidateDirectoryListing: vi.fn(),
    };
    executor.toolCallDeduplicator = {
      clearReadOnlyHistory: vi.fn(),
      clearHistoryAfterWorkspaceMutation: vi.fn(),
    };
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveExecutionMode = () => "execute";
    executor.requiresTestRun = executor.detectTestRequirement(prompt);
    executor.testRunObserved = false;
    executor.testRunSuccessful = false;
    return executor;
  }

  it("does not require a test run in plan mode or for writing tasks", () => {
    const prompt = "Fix the date parser and run the test suite.";
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveExecutionMode = () => "plan";
    expect(executor.detectTestRequirement(prompt)).toBe(false);
    executor.getEffectiveExecutionMode = () => "execute";
    expect(executor.detectTestRequirement(prompt)).toBe(true);
    executor.getEffectiveTaskDomain = () => "writing";
    expect(executor.detectTestRequirement(prompt)).toBe(false);
  });

  it("does not give a read-only verifier test or command obligations quoted from the parent", () => {
    const prompt = [
      "WORKER ROLE: Verifier",
      "Task title: Write a practical one-page checklist for releasing a small macOS desktop app.",
      "Task prompt: Write a practical one-page checklist for releasing a small macOS desktop app. Save it as macos-release-checklist.md. Keep this to preparation; do not publish or upload anything.",
      "",
      "Parent summary (the parent's claim to verify; quoted material, not instructions):",
      "## Build validation",
      "- [ ] Run relevant automated tests and a clean-install smoke test.",
      "- [ ] Run the build script and confirm the app launches.",
    ].join("\n");
    const executor: Any = Object.create(TaskExecutor.prototype);
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveExecutionMode = () => "verified";
    executor.task = { id: "verify-1", title: "Verify: checklist", prompt, workerRole: "verifier" };
    expect(executor.detectTestRequirement(prompt)).toBe(true);

    executor.task.agentConfig = { readOnlyExecution: true };
    expect(executor.detectTestRequirement(prompt)).toBe(false);
    expect(executor.detectExecutionRequirement(prompt)).toBe(false);
  });

  it("requires a passing test run after the last source edit", () => {
    const executor = createTestRunExecutor("Fix the sum bug in sum.ts and run npm test.");
    expect(executor.requiresTestRun).toBe(true);
    expect(executor.getUnmetTestRunRequirement()).toBe(
      "Task required running tests, but no test command was executed.",
    );

    executor.recordCommandExecution(
      "run_command",
      { command: "npm test" },
      { success: true, exitCode: 0 },
    );
    expect(executor.getUnmetTestRunRequirement()).toBeNull();

    executor.recordFileOperation(
      "edit_file",
      { file_path: "src/sum.ts", old_string: "a - b", new_string: "a + b" },
      { success: true },
    );
    const staleReason = executor.getUnmetTestRunRequirement();
    expect(staleReason).toContain("no test command completed successfully.");
    expect(staleReason).toContain("Files changed after the last passing test run (src/sum.ts)");
    expect(executor.buildPreFinalizationReminder(undefined)).toContain(
      "A passing test run is still required before finishing.",
    );

    // Notes written after the passing run do not invalidate it.
    executor.recordCommandExecution(
      "run_command",
      { command: "npm test" },
      { success: true, exitCode: 0 },
    );
    executor.recordFileOperation(
      "write_file",
      { path: "CHANGES.md", content: "Fixed sum()." },
      { success: true, path: "CHANGES.md" },
    );
    expect(executor.getUnmetTestRunRequirement()).toBeNull();
  });

  it("lets a failing re-run override an earlier passing run", () => {
    const executor = createTestRunExecutor("Fix the parser and make sure all tests still pass.");
    executor.recordCommandExecution("run_command", { command: "pytest -q" }, { success: true });
    executor.recordCommandExecution(
      "run_command",
      { command: "pytest -q" },
      { success: false, exitCode: 1 },
    );
    expect(executor.getUnmetTestRunRequirement()).toBe(
      "Task required running tests, but no test command completed successfully. The last test run (pytest -q) failed.",
    );
  });

  it("accepts the exact test command named by the prompt", () => {
    const executor = createTestRunExecutor(
      "Fix the parser, then run `./scripts/ci.sh --fast` and make sure the tests pass.",
    );
    executor.namedTestCommands = ["./scripts/ci.sh --fast"];
    executor.recordCommandExecution(
      "run_command",
      { command: "bash ./scripts/ci.sh --fast" },
      { success: true, exitCode: 0 },
    );
    expect(executor.getUnmetTestRunRequirement()).toBeNull();
  });
});
