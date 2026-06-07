import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import {
  buildCompletionGuidancePrompt,
  detectReadOnlyConstraint,
} from "../executor-completion-utils";

type HarnessOptions = {
  prompt: string;
  rawPrompt?: string;
  title?: string;
  lastOutput: string;
  createdFiles?: string[];
  planStepDescription?: string;
  source?: "manual" | "cron" | "hook" | "api";
};

function createExecuteHarness(options: HarnessOptions) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  const stepDescription = options.planStepDescription || "Do the task";

  executor.task = {
    id: "task-1",
    title: options.title || "Test task",
    prompt: options.prompt,
    ...(options.rawPrompt ? { rawPrompt: options.rawPrompt } : {}),
    createdAt: Date.now() - 1000,
    currentAttempt: 0,
    maxAttempts: 1,
    ...(options.source ? { source: options.source } : {}),
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    isTemp: false,
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    logEvent: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    getTaskEvents: vi.fn().mockReturnValue([]),
    handleTransientTaskFailure: vi.fn().mockReturnValue(false),
    dispatchMentionedAgents: vi.fn(),
    getAgentRoleById: vi.fn().mockReturnValue(null),
  };
  executor.toolRegistry = {
    cleanup: vi.fn(async () => undefined),
  };
  executor.fileOperationTracker = {
    getCreatedFiles: vi.fn().mockReturnValue(options.createdFiles || []),
    getKnowledgeSummary: vi.fn().mockReturnValue(""),
  };
  executor.contextManager = {
    getAvailableTokens: vi.fn().mockReturnValue(1000000),
    compactMessagesWithMeta: vi.fn((messages: Any) => ({ messages, meta: { kind: "none" } })),
  };
  executor.provider = { createMessage: vi.fn() };
  executor.abortController = new AbortController();
  executor.cancelled = false;
  executor.waitingForUserInput = false;
  executor.requiresTestRun = false;
  executor.testRunObserved = false;
  executor.testRunSuccessful = false;
  executor.requiresVisualQARun = false;
  executor.visualQARunObserved = false;
  executor.partialSuccessForCronEnabled = true;
  executor.shouldPauseForRequiredDecision = true;
  executor.taskCompleted = false;
  executor.lastAssistantOutput = options.lastOutput;
  executor.lastNonVerificationOutput = options.lastOutput;
  executor.lastAssistantText = options.lastOutput;
  executor.saveConversationSnapshot = vi.fn();
  executor.maybeHandleScheduleSlashCommand = vi.fn(async () => false);
  executor.isCompanionPrompt = vi.fn().mockReturnValue(false);
  executor.analyzeTask = vi.fn(async () => ({}));
  executor.dispatchMentionedAgentsAfterPlanning = vi.fn(async () => undefined);
  executor.verifySuccessCriteria = vi.fn(async () => ({ success: true, message: "ok" }));
  executor.isTransientProviderError = vi.fn().mockReturnValue(false);
  executor.executePlan = vi.fn(async function executePlanStub(this: Any) {
    const current = this.plan?.steps?.[0];
    if (current) {
      current.status = "completed";
      current.completedAt = Date.now();
    }
  });
  executor.createPlan = vi.fn(async function createPlanStub(this: Any) {
    this.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: stepDescription,
          status: "pending",
        },
      ],
    };
  });

  return executor as TaskExecutor & {
    daemon: {
      logEvent: ReturnType<typeof vi.fn>;
      updateTaskStatus: ReturnType<typeof vi.fn>;
      updateTask: ReturnType<typeof vi.fn>;
      completeTask: ReturnType<typeof vi.fn>;
      getTaskEvents: ReturnType<typeof vi.fn>;
    };
  };
}

describe("TaskExecutor completion contract integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats compile-into-report prompts as requiring artifact evidence", () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest trends in AI agents from the last 1 day and summarize findings. Search for AI agent trends across Reddit, X, and tech news sources. Compile and summarize the key findings, trends, and notable developments into a comprehensive report.",
      lastOutput: "Prepared report",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(true);
    expect(contract.artifactKind).toBe("file");
  });

  it("does not treat text-only daily briefs as file artifact requests", () => {
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt: `Create my daily CoWork OS development brief.

Inspect the local repo and summarize:

1. Current repo state
- current branch
- dirty files
- untracked files that look important

4. Suggested work for today
Give me the top 3 tasks for today, ordered by leverage.
For each task include:
- exact files/areas involved

Use concise engineering judgment. Include exact evidence: file paths, command results, timestamps from logs, and relevant script names.`,
      lastOutput: "Daily brief prepared.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(false);
    expect(contract.artifactKind).toBe("none");
  });

  it("does not treat concise briefs with file paths as file artifact requests", () => {
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt:
        "Create my daily development brief. Include file paths, dirty files, and untracked files.",
      lastOutput: "Daily brief prepared.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(false);
    expect(contract.artifactKind).toBe("none");
  });

  it("treats explicit markdown file output without a dot extension as an artifact request", () => {
    const executor = createExecuteHarness({
      title: "Findings export",
      prompt: "Write the findings as a markdown file.",
      lastOutput: "Prepared findings.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(true);
    expect(contract.artifactKind).toBe("file");
  });

  it("treats presentation prompts as requiring a pptx artifact", () => {
    const executor = createExecuteHarness({
      title: "CoWork OS presentation",
      prompt: "Create a concise presentation about CoWork OS.",
      lastOutput: "Prepared outline",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(true);
    expect(contract.artifactKind).toBe("file");
    expect(contract.requiredArtifactExtensions).toContain(".pptx");
  });

  it("treats heartbeat priority updates as file artifacts, not canvas apps", () => {
    const executor = createExecuteHarness({
      title: "Heartbeat: Pending work detected (7 mentions, 0 assigned tasks)",
      prompt: `You are Project Manager, running a Heartbeat v3 dispatch.

Checklist items due:
- Check for new GitHub issues and PRs that need triage
- Check CI/CD pipeline health (last build status, any failures)
- Review KPI dashboard for any significant deltas (stars, installs, issues)
- Check for security advisories on dependencies
- Review and update PRIORITIES.md if sprint context has changed

[AGENT_STRATEGY_CONTEXT_V1]
checklist_contract:
- Create a session checklist only for non-trivial execution that changes artifacts/state or spans a long workflow.
[/AGENT_STRATEGY_CONTEXT_V1]`,
      lastOutput: "Updated `.cowork/PRIORITIES.md` and recorded heartbeat context.",
      createdFiles: [".cowork/PRIORITIES.md"],
    });
    executor.requiresVisualQARun = true;

    const contract = (executor as Any).buildCompletionContract();

    // The heartbeat prompt mentions PRIORITIES.md as an input/target to update,
    // but explicit-only extraction no longer infers .md as a required output extension.
    // Artifact evidence is still satisfied because the task created the file.
    expect(contract.requiredArtifactExtensions).toEqual([]);
    expect((executor as Any).hasArtifactEvidence(contract)).toBe(true);
  });

  it("preserves a substantive brief when a later recovery step reports narrow evidence", () => {
    const brief = `Daily CoWork OS project brief.

Current repo state: branch main has modified executor and cron files.
Health signals: reviewed logs/dev-latest.log and no build command was run.
Product priorities: release stabilization and dependency triage remain active.

Suggested work for today:
1. Verify scheduler reliability because cron recovery changed executor paths.
2. Inspect SideChatPanel files because untracked UI work is present.
3. Run type-check because shared types changed.

Watchlist: stale local artifacts and generated logs should be reviewed.

Verification evidence: reviewed git state, .cowork/PRIORITIES.md, logs/dev-latest.log, and scratchpad evidence. Overall status: degraded.`;
    const recovery = `Alternative strategy succeeded.

Used:

\`\`\`bash
GIT_PAGER=cat git -c core.pager=cat log --no-color --oneline --decorate=short -n 10
\`\`\`

Saved to scratchpad under \`repo-state-recent-commits-alt-log\`.`;
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt: "Create my daily CoWork OS development brief and summarize suggested work.",
      lastOutput: brief,
    });

    (executor as Any).recordAssistantOutput(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: recovery }],
        },
      ],
      { id: "recovery-1", description: "Try an alternative toolchain", kind: "recovery" },
    );

    expect((executor as Any).lastAssistantOutput).toBe(brief);
    expect((executor as Any).lastNonVerificationOutput).toBe(brief);
    expect((executor as Any).getBestFinalResponseCandidate()).toBe(brief);
  });

  it("uses a substantive recovery answer when it is the better deliverable", () => {
    const oldBrief = `Initial repo brief.

Current repo state: branch main has local changes.
Suggested work: inspect scheduler output.
Watchlist: missing dev logs.`;
    const recovery = `Fallback analysis found the current blocker.

Overall status: degraded because the scheduler completed data gathering but finalization used the wrong output candidate.

Suggested work:
1. Fix recovery candidate selection.
2. Add regression tests around final summaries.

Verification evidence: reviewed executor completion contract tests and executor output tracking.`;
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt: "Create my daily CoWork OS development brief and summarize suggested work.",
      lastOutput: oldBrief,
    });

    (executor as Any).recordAssistantOutput(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: recovery }],
        },
      ],
      { id: "recovery-1", description: "Try an alternative toolchain", kind: "recovery" },
    );

    expect((executor as Any).lastAssistantOutput).toBe(recovery);
    expect((executor as Any).lastNonVerificationOutput).toBe(recovery);
    expect((executor as Any).getBestFinalResponseCandidate()).toBe(recovery);
  });

  it("completes with the substantive brief after a narrow recovery status", async () => {
    const brief = `Daily CoWork OS project brief.

Current repo state: branch main has modified executor and cron files.
Health signals: reviewed logs/dev-latest.log and no build command was run.
Product priorities: release stabilization and dependency triage remain active.

Suggested work for today:
1. Verify scheduler reliability because cron recovery changed executor paths.
2. Inspect SideChatPanel files because untracked UI work is present.
3. Run type-check because shared types changed.

Watchlist: stale local artifacts and generated logs should be reviewed.

Verification evidence: reviewed git state, .cowork/PRIORITIES.md, logs/dev-latest.log, and scratchpad evidence. Overall status: degraded.`;
    const recovery = `Alternative strategy succeeded.

Used:

\`\`\`bash
GIT_PAGER=cat git -c core.pager=cat log --no-color --oneline --decorate=short -n 10
\`\`\`

Saved to scratchpad under \`repo-state-recent-commits-alt-log\`.`;
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt: "Create my daily CoWork OS development brief and summarize suggested work.",
      lastOutput: "",
    });
    executor.executePlan = vi.fn(async function executePlanStub(this: Any) {
      const current = this.plan?.steps?.[0];
      if (current) {
        current.status = "completed";
        current.completedAt = Date.now();
      }
      this.recordAssistantOutput(
        [
          {
            role: "assistant",
            content: [{ type: "text", text: brief }],
          },
        ],
        { id: "deliverable-1", description: "Prepare the brief", kind: "execution" },
      );
      this.recordAssistantOutput(
        [
          {
            role: "assistant",
            content: [{ type: "text", text: recovery }],
          },
        ],
        { id: "recovery-1", description: "Try an alternative toolchain", kind: "recovery" },
      );
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      brief,
      expect.any(Object),
    );
  });

  it("counts planCompletedEffectively as execution evidence during finalization", () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest trends in AI agents from the last 1 day and summarize findings. Compile the findings into a report.",
      lastOutput: "Prepared report",
    });

    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Research and prepare the report.",
          status: "failed",
        },
      ],
    };
    (executor as Any).planCompletedEffectively = true;

    expect((executor as Any).hasExecutionEvidence()).toBe(true);
  });

  it("counts successful tool results as execution evidence during timeout finalization", () => {
    const executor = createExecuteHarness({
      title: "Compare repositories",
      prompt: "Research two GitHub repositories and compare their current stats.",
      lastOutput: "Found repository stats from web sources.",
    });

    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Find the repositories and collect current stats.",
          status: "failed",
        },
      ],
    };
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "Fetched GitHub repository metadata.", timestamp: Date.now() },
    ];

    expect((executor as Any).hasExecutionEvidence()).toBe(true);
  });

  it("short-circuits simple non-execute answer-first prompts without running plan execution", async () => {
    const executor = createExecuteHarness({
      title: "Ethics question",
      prompt:
        "Would you feel guilty if your efficiency caused job cuts in companies?\n\n[AGENT_STRATEGY_CONTEXT_V1]\nanswer_first=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput: "",
      planStepDescription: "Draft a plan",
    });
    executor.task.agentConfig = {
      executionMode: "plan",
    };
    (executor as Any).emitAnswerFirstResponse = vi.fn(async function emitAnswerFirstStub(this: Any) {
      const text =
        "I don't feel guilt, but this is a serious ethical risk and should be handled responsibly.";
      this.lastAssistantOutput = text;
      this.lastNonVerificationOutput = text;
      this.lastAssistantText = text;
    });

    await (executor as Any).execute();

    expect((executor as Any).emitAnswerFirstResponse).toHaveBeenCalledTimes(1);
    expect(executor.createPlan).not.toHaveBeenCalled();
    expect(executor.executePlan).not.toHaveBeenCalled();
    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
  });

  it("short-circuits simple advice prompts even if stale executionMode is execute", async () => {
    const executor = createExecuteHarness({
      title: "Ethics question",
      prompt:
        "Would you feel guilty if your efficiency caused job cuts in companies?\n\n[AGENT_STRATEGY_CONTEXT_V1]\nanswer_first=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput: "",
      planStepDescription: "Draft a plan",
    });
    executor.task.agentConfig = {
      executionMode: "execute",
      taskIntent: "advice",
    };
    (executor as Any).emitAnswerFirstResponse = vi.fn(async function emitAnswerFirstStub(this: Any) {
      const text = "I don't feel guilt, but job impacts should be handled responsibly.";
      this.lastAssistantOutput = text;
      this.lastNonVerificationOutput = text;
      this.lastAssistantText = text;
    });

    await (executor as Any).execute();

    expect((executor as Any).emitAnswerFirstResponse).toHaveBeenCalledTimes(1);
    expect(executor.createPlan).not.toHaveBeenCalled();
    expect(executor.executePlan).not.toHaveBeenCalled();
    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
  });

  it("fails when a direct answer is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and let me know if I should spend my time watching it or skip it.",
      lastOutput: "Created: Dan_Koe_Video_Review.pdf",
      createdFiles: ["Dan_Koe_Video_Review.pdf"],
      planStepDescription: "Transcribe the video",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing direct answer"),
      }),
    );
  });

  it("does not complete the task when artifact evidence is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Generate report",
      prompt: "Create a PDF report from the attached data.",
      lastOutput: "Created: report.pdf",
      createdFiles: [],
      planStepDescription: "Generate the report",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("fails web-app shipping tasks before Playwright QA when artifact evidence is missing", async () => {
    const executor = createExecuteHarness({
      title: "Build a simple todo app in React",
      prompt: "Build a simple todo app in React, test it to catch any bugs before shipping.",
      lastOutput: "Implemented the app and wrote tests.",
      createdFiles: ["package.json", "src/App.jsx", "src/App.test.jsx"],
      planStepDescription: "Implement the app and verify it",
    });
    executor.requiresVisualQARun = true;

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("does not reach Playwright QA when no web-app artifacts were materialized", async () => {
    const executor = createExecuteHarness({
      title: "Build a simple todo app in React",
      prompt: "Build a simple todo app in React, test it to catch any bugs before shipping.",
      lastOutput: "Wrote planning notes and documentation only.",
      createdFiles: ["README.md", "docs/brief.md"],
      planStepDescription: "Write the implementation brief",
    });
    executor.requiresVisualQARun = true;

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("completes website tasks even when strategy context mentions docx artifacts", async () => {
    const executor = createExecuteHarness({
      title: "Windows 95 website",
      prompt: `Create a fully working website simulating the Windows 95 UI.

[AGENT_STRATEGY_CONTEXT_V1]
relationship_memory:
- Completed task: create a short word document where you write about ... Outcome: inner_world.docx
[/AGENT_STRATEGY_CONTEXT_V1]`,
      lastOutput: "Created files: index.html, styles/win95.css, scripts/desktop.js",
      createdFiles: ["index.html", "styles/win95.css", "scripts/desktop.js"],
      planStepDescription: "Implement website files",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("uses raw prompt for contract inference when runtime prompt metadata mentions docx", async () => {
    const executor = createExecuteHarness({
      title: "Windows 95 website",
      rawPrompt: "Create a fully working website simulating the Windows 95 UI.",
      prompt: `Create a fully working website simulating the Windows 95 UI.

ADDITIONAL CONTEXT:
DOCUMENT CREATION BEST PRACTICES:
1. ONLY use create_document (docx/pdf) when the user explicitly requests DOCX or PDF format.`,
      lastOutput: "Created files: index.html, styles/win95.css, scripts/desktop.js",
      createdFiles: ["index.html", "styles/win95.css", "scripts/desktop.js"],
      planStepDescription: "Implement website files",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing artifact evidence"),
      }),
    );
  });

  it("fails canvas build tasks when required tool evidence is missing", async () => {
    const executor = createExecuteHarness({
      title: "Competition demo",
      prompt: "Build something to win this competition and show it in canvas.",
      lastOutput: "Built and rendered an interactive prototype in canvas.",
      createdFiles: ["prototype.html"],
      planStepDescription: "Build an interactive app and show it in canvas",
    });
    (executor as Any).successfulToolUsageCounts = new Map();

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing required tool evidence"),
      }),
    );
  });

  it("completes canvas build tasks when write_file and canvas_push evidence is present", async () => {
    const executor = createExecuteHarness({
      title: "Competition demo",
      prompt: "Build something to win this competition and show it in canvas.",
      lastOutput: "Built and rendered an interactive prototype in canvas.",
      createdFiles: ["prototype.html"],
      planStepDescription: "Build an interactive app and show it in canvas",
    });
    (executor as Any).successfulToolUsageCounts = new Map([
      ["write_file", 1],
      ["canvas_push", 1],
    ]);

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing required tool evidence"),
      }),
    );
  });

  it("does not complete the task when verification evidence is required but missing", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and then let me know if I should spend my time watching it or skip it.",
      lastOutput: "You should skip it because it repeats beginner concepts.",
      planStepDescription: "Transcribe the video",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts build-health command reports as verification-backed conclusions", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS Build Health Watcher",
      prompt: `Check CoWork OS build health.

Run:
1. npm run build:react
2. npm run build:electron
3. npm run build:daemon
4. npm run build:connectors

Report:
- overall status: green, degraded, or broken
- exact command results
- first failing command
- likely owner area
- top suspected root cause
- suggested next debugging step
- whether this blocks release`,
      lastOutput: `Almarion, build health status: \`green\`

- \`npm run build:react\`: passed, exit 0
- \`npm run build:electron\`: passed, exit 0
- \`npm run build:daemon\`: passed, exit 0
- \`npm run build:connectors\`: passed, exit 0

First failing command: none
Likely owner area: none
Top suspected root cause: none; no build blocker found.
Suggested next debugging step: run targeted tests for recently changed areas.
Blocks release: no, based on these build surfaces.`,
      planStepDescription: "Run build-health checks",
    });
    (executor as Any).toolResultMemory = [
      { tool: "run_command", summary: "npm run build:react exit 0", timestamp: Date.now() },
      { tool: "run_command", summary: "npm run build:electron exit 0", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts scheduled build-health API reports with explicit verification evidence", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS Build Health Watcher",
      prompt: `Run a fresh build-health check.

Required checks:
- npm run lint
- npm run type-check
- npm test
- npm run build

End with a final section titled "Verification Evidence".
In that section, explicitly list:
- commands completed
- exit codes
- whether each required check passed or failed
- final build-health verdict

Then end with:
"Verification complete: this routine produced a review-backed build-health conclusion."`,
      lastOutput: `Result: **Degraded**. The routine can now produce a review-backed conclusion, but not a healthy one.

Key evidence:
- Historical CI run \`25733202868\` completed with conclusion \`failure\`.
- Current \`main\` check-runs show \`Lint & Type Check\`: \`success\`, \`Tests\`: \`failure\`, and \`Build\`: \`skipped\`.

## Verification Evidence

- commands completed:
  - \`GET https://api.github.com/repos/CoWork-OS/CoWork-OS/actions/runs/25733202868\`
  - \`GET https://api.github.com/repos/CoWork-OS/CoWork-OS/commits/main/check-runs?per_page=100\`
- exit codes:
  - run metadata: HTTP \`200\`
  - main check-runs: HTTP \`200\`
  - \`npm run lint\`: inferred exit code \`0\`
  - \`npm run type-check\`: inferred exit code \`0\`
  - \`npm test\`: exit code \`1\`
  - \`npm run build\`: unavailable; CI build job was skipped after upstream failure
- whether each required check passed or failed:
  - \`npm run lint\`: **passed**
  - \`npm run type-check\`: **passed**
  - \`npm test\`: **failed**
  - \`npm run build\`: **failed to verify / skipped**
- final build-health verdict:
  - **Degraded**

Verification complete: this routine produced a review-backed build-health conclusion.`,
      planStepDescription: "Run build-health checks and report the final verdict",
      source: "cron",
    });
    (executor as Any).toolResultMemory = [
      { tool: "http_request", summary: "GitHub Actions run metadata HTTP 200", timestamp: Date.now() },
      { tool: "http_request", summary: "GitHub check-runs HTTP 200", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing direct answer"),
      }),
    );
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("still rejects shallow build-health status without evidence or a verdict", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS Build Health Watcher",
      prompt:
        "Check CoWork OS build health. Include exact command results, exit codes, and final build-health verdict.",
      lastOutput: "Build health check completed.",
      planStepDescription: "Run build-health checks",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("does not accept verification labels without concrete command or API evidence", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS Build Health Watcher",
      prompt: `Run a fresh build-health check.

End with a final section titled "Verification Evidence".
In that section, explicitly list commands completed, exit codes, pass/fail, and final build-health verdict.`,
      lastOutput: `Result: **Degraded**.

## Verification Evidence

Verification complete: this routine produced a review-backed build-health conclusion.`,
      planStepDescription: "Run build-health checks",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts completed review/check steps even when the final response is operational", async () => {
    const executor = createExecuteHarness({
      title: "Heartbeat: Pending work detected",
      prompt:
        "Check CI/CD pipeline health, review stalled planner-managed issues, and scan unresolved community questions.",
      lastOutput:
        "Heartbeat dispatch completed. Checklist covered: CI/CD pipeline health, stalled planner-managed issues, and community discussions. No duplicate work was repeated.",
      planStepDescription: "Stalled planner-managed issues are reviewed for next action.",
    });
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "Fetched CI pipeline health", timestamp: Date.now() },
      { tool: "web_search", summary: "Searched unresolved community questions", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("rejects completed review/check steps when no evidence tools were used", async () => {
    const executor = createExecuteHarness({
      title: "Heartbeat: Pending work detected",
      prompt:
        "Check CI/CD pipeline health, review stalled planner-managed issues, and scan unresolved community questions.",
      lastOutput:
        "Heartbeat dispatch completed. Checklist covered: CI/CD pipeline health, stalled planner-managed issues, and community discussions.",
      planStepDescription: "Stalled planner-managed issues are reviewed for next action.",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts reasoned recommendations when evidence tools were used", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and then let me know if I should spend my time watching it or skip it.",
      lastOutput: "You should skip it because it repeats beginner concepts.",
      planStepDescription: "Transcribe the video",
    });
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "https://example.com/transcript", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("accepts structured documentation-drift reports when repo evidence tools were used", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS documentation drift check",
      prompt:
        "Review current repo evidence for documentation drift in CoWork OS. Do not edit files. Report docs that need updates, exact source of truth in code/config, suggested documentation change, and priority.",
      lastOutput: `## Documentation Drift Report

1. Docs that need updates: docs/automation.md
- Source of truth in code/config: src/electron/cron/service.ts now restricts run_command when a scheduled job has shellAccess false.
- Drift: the automation docs still describe scheduled tasks as if command execution is always available.
- Suggested doc update: add the shellAccess false behavior and say read/list/search evidence is expected for no-edit review routines.
- Priority: should fix`,
      planStepDescription: "Gather current docs and source evidence",
      source: "cron",
    });
    (executor as Any).toolResultMemory = [
      {
        tool: "read_file",
        summary: "Read src/electron/cron/service.ts",
        timestamp: Date.now(),
      },
      { tool: "grep", summary: "Searched docs for shellAccess", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("rejects structured documentation-drift labels without repo evidence tools", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS documentation drift check",
      prompt:
        "Review current repo evidence for documentation drift in CoWork OS. Do not edit files. Report docs that need updates, exact source of truth in code/config, suggested documentation change, and priority.",
      lastOutput: `## Documentation Drift Report

1. Docs that need updates: docs/automation.md
- Source of truth in code/config: src/electron/cron/service.ts
- Drift: scheduled task docs are stale.
- Suggested doc update: update the automation docs.
- Priority: should fix`,
      planStepDescription: "Gather current docs and source evidence",
      source: "cron",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("rejects generic documentation-drift findings without repo evidence tools", async () => {
    const executor = createExecuteHarness({
      title: "CoWork OS documentation drift check",
      prompt:
        "Review current repo evidence for documentation drift in CoWork OS. Do not edit files. Report docs that need updates, exact source of truth in code/config, suggested documentation change, and priority.",
      lastOutput: `## Findings

I reviewed the documentation drift state.

Recommendation: update docs/automation.md because scheduled task docs are stale.`,
      planStepDescription: "Gather current docs and source evidence",
      source: "cron",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing verification evidence"),
      }),
    );
  });

  it("prefers the last non-verification answer over a later operational status message", async () => {
    const executor = createExecuteHarness({
      title: "Video decision",
      prompt:
        "Transcribe this video and let me know if I should spend my time watching it or skip it.",
      lastOutput: "Created: Dan_Koe_Video_Review.pdf",
      createdFiles: ["Dan_Koe_Video_Review.pdf"],
      planStepDescription: "Transcribe the video",
    });
    (executor as Any).lastNonVerificationOutput =
      "You should skip it because the video repeats beginner concepts and adds little beyond the transcript.";
    (executor as Any).lastAssistantText = "Created: Dan_Koe_Video_Review.pdf";
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "transcript reviewed", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing direct answer"),
      }),
    );
  });

  it("does not complete high-risk research summaries without dated fetched evidence", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).toolResultMemory = [
      {
        tool: "web_search",
        summary: "query \"AI agent trends\" returned sources",
        timestamp: Date.now(),
      },
    ];
    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("allows high-risk research summaries when fetched sources include publish dates", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        publishDate: "2026-02-26",
        timestamp: Date.now(),
      },
      {
        tool: "web_search",
        url: "https://www.reddit.com/r/AI_Agents/comments/demo",
        timestamp: Date.now(),
      },
      {
        tool: "web_search",
        url: "https://x.com/openai/status/123",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("does not treat filtering instructions about announcement posts as a risky release claim", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Defaults I’ll use unless you override them:\n- Lookback window: 7 days\n- Filter: ruthless on signal; rehashed benchmarks and thin announcement posts get dropped\n\nSend the topic and ClickUp destination to continue.",
      planStepDescription: "Search the source set systematically",
    });

    await (executor as Any).execute();

    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("does not complete Daily AI Agent Trends reports when Reddit, X, and tech news coverage is incomplete", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        publishDate: "2026-02-26",
        timestamp: Date.now(),
      },
      {
        tool: "web_search",
        url: "https://www.reddit.com/r/AI_Agents/comments/demo",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source coverage"),
      }),
    );
  });

  it("allows Daily AI Agent Trends reports when Reddit, X, and tech news coverage are all present", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
    });

    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        publishDate: "2026-02-26",
        timestamp: Date.now(),
      },
      {
        tool: "web_search",
        url: "https://www.reddit.com/r/AI_Agents/comments/demo",
        timestamp: Date.now(),
      },
      {
        tool: "web_search",
        url: "https://x.com/openai/status/123",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
  });

  it("downgrades source-validation guard failures to partial success for cron best-effort runs", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.\n\n[AGENT_STRATEGY_CONTEXT_V1]\ntimeout_finalize_bias=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
      source: "cron",
    });

    (executor as Any).toolResultMemory = [
      {
        tool: "web_search",
        summary: "query \"AI agent trends\" returned sources",
        timestamp: Date.now(),
      },
    ];
    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("could not be fully validated"),
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("does not downgrade source-validation failures when no fetched source evidence exists", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.\n\n[AGENT_STRATEGY_CONTEXT_V1]\ntimeout_finalize_bias=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
      source: "cron",
    });

    (executor as Any).toolResultMemory = [
      {
        tool: "web_search",
        summary: "query \"AI agent trends\" returned sources",
        timestamp: Date.now(),
      },
    ];
    (executor as Any).webEvidenceMemory = [];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("missing source validation"),
      }),
    );
  });

  it("extracts dated evidence from relative publish-time phrases", () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt: "Research the latest AI agent trends and summarize key launches.",
      lastOutput: "Summary",
      planStepDescription: "Fetch and summarize sources",
    });

    (executor as Any).recordWebEvidence("web_fetch", {
      url: "https://example.com/ai-news",
      title: "AI launch updates",
      content: "Published 3 hours ago",
    });

    const evidence = (executor as Any).webEvidenceMemory || [];
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].publishDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((executor as Any).hasDatedFetchedWebEvidence(1)).toBe(true);
  });

  it("ignores generic relative time phrases without publication context cues", () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt: "Research the latest AI agent trends and summarize key launches.",
      lastOutput: "Summary",
      planStepDescription: "Fetch and summarize sources",
    });

    (executor as Any).recordWebEvidence("web_fetch", {
      url: "https://example.com/ai-news",
      title: "AI launch updates",
      content: "Top discussion: 3 hours ago in comments.",
    });

    expect((executor as Any).hasDatedFetchedWebEvidence(1)).toBe(false);
  });

  it("applies source-validation fallback during interruption-resume finalization", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.\n\n[AGENT_STRATEGY_CONTEXT_V1]\ntimeout_finalize_bias=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
      source: "cron",
    });
    executor.plan = {
      description: "Plan",
      steps: [{ id: "1", description: "Done", status: "completed" }],
    };
    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).resumeAfterInterruptionUnlocked();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("could not be fully validated"),
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("pauses interruption resume when the final candidate is still a required-input request", async () => {
    const executor = createExecuteHarness({
      title: "You track a fast-moving technical field.",
      prompt:
        "Search the latest technical field sources and post the digest to ClickUp once the topic and destination are known.",
      lastOutput:
        "I can start the source sweep now; I’m only missing the topic.\n\nSend:\n1. the topic\n2. the ClickUp destination\n3. optionally, a non-default lookback window",
      planStepDescription: "Search the source set systematically",
    });
    executor.plan = {
      description: "Plan",
      steps: [{ id: "1", description: "Done", status: "completed" }],
    };

    await (executor as Any).resumeAfterInterruptionUnlocked();

    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith("task-1", "paused");
    expect((executor as Any).saveConversationSnapshot).toHaveBeenCalled();
    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("applies source-validation fallback during manual continuation finalization", async () => {
    const executor = createExecuteHarness({
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest AI agent trends from the last day and summarize key launches and funding updates.\n\n[AGENT_STRATEGY_CONTEXT_V1]\ntimeout_finalize_bias=true\n[/AGENT_STRATEGY_CONTEXT_V1]",
      lastOutput:
        "Major releases include Gemini 2.0 and Copilot Marketplace. Funding surged to $2.5B this quarter.",
      planStepDescription: "Summarize latest AI agent releases and funding trends",
      source: "cron",
    });

    executor.continuationCount = 0;
    executor.continuationWindow = 1;
    executor.continuationStrategy = "adaptive_progress";
    executor.maxAutoContinuations = 3;
    executor.minProgressScoreForAutoContinue = 0.25;
    executor.maxLifetimeTurns = 320;
    executor.lifetimeTurnCount = 10;
    executor.globalTurnCount = 60;
    executor.iterationCount = 2;
    executor.totalInputTokens = 0;
    executor.totalOutputTokens = 0;
    executor.totalCost = 0;
    executor.usageOffsetInputTokens = 0;
    executor.usageOffsetOutputTokens = 0;
    executor.usageOffsetCost = 0;
    executor.windowStartEventCount = 0;
    executor.noProgressStreak = 0;
    executor.pendingLoopStrategySwitchMessage = "";
    executor.appendConversationHistory = vi.fn();
    executor.executePlan = vi.fn(async () => undefined);
    executor.maybeCompactBeforeContinuation = vi.fn(async () => undefined);
    executor.assessContinuationWindow = vi.fn(() => ({
      progressScore: 0.6,
      loopRiskIndex: 0.2,
      repeatedFingerprintCount: 0,
      dominantFingerprint: "tool::input::ok",
      windowSummary: {
        stepCompleted: 1,
        writeMutations: 0,
        resolvedErrorRecoveries: 0,
        repeatedErrorPenalty: 0,
        emptyNoOpTurns: 0,
      },
    }));
    executor.plan = {
      description: "Plan",
      steps: [{ id: "1", description: "Done", status: "completed" }],
    };
    (executor as Any).webEvidenceMemory = [
      {
        tool: "web_fetch",
        url: "https://example.com/ai-news",
        timestamp: Date.now(),
      },
    ];

    await (executor as Any).continueAfterBudgetExhaustedUnlocked({ mode: "manual" });

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("could not be fully validated"),
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_error",
      }),
    );
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("downgrades output-backed mutation checkpoint failures to partial success for manual tasks", async () => {
    const executor = createExecuteHarness({
      title: "Build dashboard",
      prompt: "Implement the dashboard, save the deliverables, and summarize the current state.",
      lastOutput:
        "Created the dashboard implementation and supporting notes. One mutation-required step still reported an artifact checkpoint failure, so the remaining blocker is limited to that unfinished write path rather than the rest of the completed deliverables.",
      createdFiles: ["src/dashboard.tsx", "docs/dashboard-notes.md"],
      planStepDescription: "Implement dashboard deliverables",
      source: "manual",
    });

    executor.executePlan = vi.fn(async function executePlanStub(this: Any) {
      this.plan = {
        description: "Plan",
        steps: [
          {
            id: "1",
            description: "Create dashboard deliverables",
            status: "completed",
          },
          {
            id: "2",
            description: "Write the remaining validation artifact",
            status: "failed",
            error:
              "Step contract failure [contract_unmet_write_required][artifact_write_checkpoint_failed]: iteration 7 reached without successful file/canvas mutation.",
          },
        ],
      };
      throw new Error("Task failed: mutation-required contract unmet - Write the remaining validation artifact");
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      expect.any(String),
      expect.objectContaining({
        terminalStatus: "partial_success",
        failureClass: "contract_unmet_write_required",
      }),
    );
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("completes only when the completion contract requirements are satisfied", async () => {
    const executor = createExecuteHarness({
      title: "Video review",
      prompt:
        "Create a PDF review document for this video and let me know whether I should watch it.",
      lastOutput:
        "Based on my review, recommendation: You should skip this unless you need beginner-level context.",
      createdFiles: ["video_review.pdf"],
      planStepDescription: "Verify: review transcript and provide recommendation",
    });

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("allows watch/skip recommendation tasks without creating an artifact when no file is generated", async () => {
    const executor = createExecuteHarness({
      title: "Video review",
      prompt:
        "Transcribe this YouTube video and create a document for me to review, then tell me if I should watch it.",
      lastOutput:
        "You should watch this only if you specifically need practical examples of creator-income positioning.",
      createdFiles: [],
      planStepDescription: "Review transcript and recommend",
    });
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "Fetched transcript evidence", timestamp: Date.now() },
    ];

    await (executor as Any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("routes provider request-cancelled errors through timeout recovery instead of failing", async () => {
    const executor = createExecuteHarness({
      title: "Draft whitepaper",
      prompt: "Create a detailed whitepaper draft.",
      lastOutput: "Initial summary",
      planStepDescription: "Write the draft",
    });
    const recoverySpy = vi.fn(async () => true);

    (executor as Any).executePlan = vi.fn(async () => {
      throw new Error("Request cancelled");
    });
    (executor as Any).finalizeWithTimeoutRecovery = recoverySpy;

    await (executor as Any).execute();

    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("waives non-mutation failed steps when soft-deadline best-effort finalization is used", () => {
    const executor = createExecuteHarness({
      title: "Build a website",
      prompt: "Create a fully working website with a few working apps.",
      lastOutput: "Refined the app shell.",
      createdFiles: ["package.json", "src/App.jsx"],
      planStepDescription: "Refine the experience",
    });
    executor.plan = {
      description: "Plan",
      steps: [
        { id: "1", description: "Implement the app shell", status: "completed" },
        { id: "2", description: "Refine the experience", status: "failed" },
      ],
    };
    (executor as Any).softDeadlineTriggered = true;
    (executor as Any).buildResultSummary = vi.fn().mockReturnValue("Refined the app shell.");

    (executor as Any).finalizeTaskWithFallback("Refined the app shell.");

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "Refined the app shell.",
      expect.objectContaining({
        waiveFailedStepIds: expect.arrayContaining(["2"]),
      }),
    );
  });

  it("waives timeout-failed research steps when tool evidence exists but no step completed", () => {
    const executor = createExecuteHarness({
      title: "Compare repositories",
      prompt: "Research two GitHub repositories and compare their current stats.",
      lastOutput: "Found repository stats from web sources.",
      planStepDescription: "Find the repositories and collect current stats.",
    });
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Find the repositories and collect current stats.",
          status: "failed",
          error: "Step soft-deadline reached after 810s",
        },
      ],
    };
    (executor as Any).softDeadlineTriggered = true;
    (executor as Any).toolResultMemory = [
      { tool: "web_fetch", summary: "Fetched GitHub repository metadata.", timestamp: Date.now() },
    ];
    (executor as Any).buildResultSummary = vi
      .fn()
      .mockReturnValue("Found repository stats from web sources.");

    (executor as Any).finalizeTaskBestEffort(
      "Found repository stats from web sources.",
      "Soft deadline reached during execution. Finalizing with best-effort answer.",
    );

    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      "Found repository stats from web sources.",
      expect.objectContaining({
        terminalStatus: "partial_success",
        waiveFailedStepIds: ["1"],
      }),
    );
  });

  it("finalizes soft-deadline runs without waiting on LLM recovery", async () => {
    const executor = createExecuteHarness({
      title: "Compare repositories",
      prompt: "Research two GitHub repositories and compare their current stats.",
      lastOutput: "",
      planStepDescription: "Find the repositories and collect current stats.",
    });
    const recoverySpy = vi.fn();

    (executor as Any).buildTimeoutRecoveryAnswer = recoverySpy;
    (executor as Any).executePlan = vi.fn(async function executePlanSoftDeadlineStub(this: Any) {
      this.plan = {
        description: "Plan",
        steps: [
          {
            id: "1",
            description: "Find the repositories and collect current stats.",
            status: "failed",
            error: "Step soft-deadline reached after 810s",
          },
        ],
      };
      this.softDeadlineTriggered = true;
      this.toolResultMemory = [
        { tool: "web_search", summary: "Found candidate GitHub repositories.", timestamp: Date.now() },
        { tool: "http_request", summary: "Fetched GitHub repository stats.", timestamp: Date.now() },
      ];
    });

    await (executor as Any).execute();

    expect(recoverySpy).not.toHaveBeenCalled();
    expect(executor.daemon.completeTask).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("Captured tool progress:"),
      expect.objectContaining({
        terminalStatus: "partial_success",
        waiveFailedStepIds: ["1"],
      }),
    );
  });

  it("suppresses artifact requirements when prompt has read-only constraint", () => {
    const executor = createExecuteHarness({
      title: "Daily CoWork OS Project Brief",
      prompt: [
        "Create my daily CoWork OS development brief.",
        "Do not edit files, commit, push, publish, post externally, or change settings.",
        "This routine is for situational awareness and prioritization only.",
        "read .cowork/PRIORITIES.md if present",
        "compare current repo state against the active priorities",
      ].join("\n"),
      lastOutput: "Daily brief prepared.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(false);
    expect(contract.requiredArtifactExtensions).toEqual([]);
    expect(contract.artifactKind).toBe("none");
  });

  it("suppresses artifact requirements with don't edit variant", () => {
    const executor = createExecuteHarness({
      title: "Architecture review",
      prompt: "Analyze the codebase architecture. Don't edit any files. Report back with a summary.",
      lastOutput: "Architecture summary.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(false);
    expect(contract.requiredArtifactExtensions).toEqual([]);
    expect(contract.artifactKind).toBe("none");
  });

  it("still requires artifacts when read-only constraint is absent", () => {
    const executor = createExecuteHarness({
      title: "Research report",
      prompt: "Research AI agent trends and compile a comprehensive report.",
      lastOutput: "Report prepared.",
    });

    const contract = (executor as Any).buildCompletionContract();

    expect(contract.requiresArtifactEvidence).toBe(true);
  });

  it("does not false-positive on 'fix the read-only permission issue'", () => {
    expect(detectReadOnlyConstraint("Fix the read-only permission issue on the database.")).toBe(
      false,
    );
  });

  it("does not false-positive on 'database is in read-only mode, fix it'", () => {
    expect(
      detectReadOnlyConstraint(
        "The database is in read-only mode, fix it so writes work again.",
      ),
    ).toBe(false);
  });

  it("does not false-positive on 'debug the read-only access error'", () => {
    expect(detectReadOnlyConstraint("Debug the read-only access error users are reporting.")).toBe(
      false,
    );
  });

  it("detects read-only constraint in 'this task is read-only'", () => {
    expect(detectReadOnlyConstraint("This task is read-only. Just analyze and report.")).toBe(true);
  });
});

describe("buildCompletionGuidancePrompt", () => {
  it("includes read-only warning when hasReadOnlyConstraint is true", () => {
    const result = buildCompletionGuidancePrompt({
      hasReadOnlyConstraint: true,
      explicitOutputExtensions: [],
      likelyRequiresExecution: false,
    });
    expect(result).toContain("read-only constraints");
    expect(result).toContain("Do NOT create, modify, or delete files");
  });

  it("includes extension format guidance when extensions are specified", () => {
    const result = buildCompletionGuidancePrompt({
      hasReadOnlyConstraint: false,
      explicitOutputExtensions: [".pdf", ".xlsx"],
      likelyRequiresExecution: false,
    });
    expect(result).toContain(".pdf, .xlsx");
  });

  it("includes execution guidance when likelyRequiresExecution is true", () => {
    const result = buildCompletionGuidancePrompt({
      hasReadOnlyConstraint: false,
      explicitOutputExtensions: [],
      likelyRequiresExecution: true,
    });
    expect(result).toContain("run_command");
  });

  it("omits execution guidance when hasReadOnlyConstraint is true", () => {
    const result = buildCompletionGuidancePrompt({
      hasReadOnlyConstraint: true,
      explicitOutputExtensions: [],
      likelyRequiresExecution: true,
    });
    expect(result).not.toContain("run_command");
  });

  it("always includes core guidance", () => {
    const result = buildCompletionGuidancePrompt({
      hasReadOnlyConstraint: false,
      explicitOutputExtensions: [],
      likelyRequiresExecution: false,
    });
    expect(result).toContain("TASK COMPLETION GUIDANCE");
    expect(result).toContain("Never fabricate tool output");
  });
});
