import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TaskExecutor } from "../executor";
import { TEMP_WORKSPACE_ID } from "../../../shared/types";

describe("TaskExecutor workspace preflight acknowledgement", () => {
  const buildBase = () => ({
    shouldPauseForQuestions: true,
    workspacePreflightAcknowledged: false,
    capabilityUpgradeRequested: false,
    requiresExecutionToolRun: false,
    allowExecutionWithoutShell: false,
    isInternalAppOrToolChangeIntent: vi.fn(() => false),
    preflightShellExecutionCheck: vi.fn(() => false),
    tryAutoSwitchToPreferredWorkspaceForAmbiguousTask: vi.fn(() => false),
    task: { prompt: "Fix a bug in src/app.ts", id: "t1" },
    classifyWorkspaceNeed: vi.fn(() => "needs_existing"),
    getWorkspaceSignals: vi.fn(() => ({
      hasEntries: true,
      hasProjectMarkers: false,
      hasCodeFiles: false,
      hasAppDirs: false,
    })),
  });

  it("does not pause on workspace mismatch — proceeds without asking", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: false, id: "ws1" },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it("does not pause when the selected workspace is empty", () => {
    const pauseForUserInput = vi.fn();
    const tryAutoSwitch = vi.fn(() => false);
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: false, id: "ws-empty" },
      tryAutoSwitchToPreferredWorkspaceForAmbiguousTask: tryAutoSwitch,
      getWorkspaceSignals: vi.fn(() => ({
        hasEntries: false,
        hasProjectMarkers: false,
        hasCodeFiles: false,
        hasAppDirs: false,
      })),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
    expect(tryAutoSwitch).not.toHaveBeenCalled();
  });

  it("pauses when workspace read failed (permission denied, etc.)", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: false, id: "ws-read-failed" },
      getWorkspaceSignals: vi.fn(() => ({
        hasEntries: false,
        hasProjectMarkers: false,
        hasCodeFiles: false,
        hasAppDirs: false,
        readFailed: true,
      })),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe("workspace_read_failed");
    expect(pauseForUserInput.mock.calls[0][0]).toContain("couldn't read");
  });

  it("does not re-pause once the user acknowledged the preflight warning", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspacePreflightAcknowledged: true,
      workspace: { isTemp: false, id: "ws1" },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it("applies to temp workspace gates as well", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe("workspace_required");
  });

  it("does not pause for ambiguous coding requests in temporary workspace (stays in temp, no auto-switch)", () => {
    const pauseForUserInput = vi.fn();
    const tryAutoSwitch = vi.fn(() => false);
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      classifyWorkspaceNeed: vi.fn(() => "ambiguous"),
      tryAutoSwitchToPreferredWorkspaceForAmbiguousTask: tryAutoSwitch,
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
    expect(tryAutoSwitch).not.toHaveBeenCalled();
  });

  it("does not pause when capability upgrade intent is active", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      capabilityUpgradeRequested: true,
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it("pauses for shell enablement when task requires command execution and shell is disabled", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: false, id: "ws1", permissions: { shell: false } },
      requiresExecutionToolRun: true,
      allowExecutionWithoutShell: false,
      lastPauseReason: null,
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightShellExecutionCheck.call(fakeThis);
    expect(shouldPause).toBe(true);
    expect(pauseForUserInput).toHaveBeenCalledTimes(1);
    expect(pauseForUserInput.mock.calls[0][1]).toBe("shell_permission_required");
  });

  it("does not pause for shell when user explicitly chose to continue without shell", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: false, id: "ws1", permissions: { shell: false } },
      requiresExecutionToolRun: true,
      allowExecutionWithoutShell: true,
      lastPauseReason: null,
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightShellExecutionCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it("keeps shell-intent parsing aligned with the UI shortcut phrases", () => {
    expect(
      (TaskExecutor as Any).prototype.classifyShellPermissionDecision.call({}, "enable shell"),
    ).toBe("enable_shell");
    expect(
      (TaskExecutor as Any).prototype.classifyShellPermissionDecision.call(
        {},
        "continue without shell",
      ),
    ).toBe("continue_without_shell");
  });

  it("tells the model not to call shell disabled when another policy layer blocks it", () => {
    const instruction = (TaskExecutor as Any).prototype.buildExecutionRequiredFollowUpInstruction.call(
      {},
      {
        attemptedExecutionTool: true,
        lastExecutionError: 'Tool "run_command" blocked by policy: blocked by workspace or gateway policy',
        shellEnabled: true,
      },
    );

    expect(instruction).toContain("Shell is already enabled for this workspace");
    expect(instruction).toContain("Do not describe this as shell being off");
  });

  it("does not pause for internal app/tool change intent in temporary workspace", () => {
    const pauseForUserInput = vi.fn();
    const fakeThis: Any = {
      ...buildBase(),
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID },
      isInternalAppOrToolChangeIntent: vi.fn(() => true),
      pauseForUserInput,
    };

    const shouldPause = (TaskExecutor as Any).prototype.preflightWorkspaceCheck.call(fakeThis);
    expect(shouldPause).toBe(false);
    expect(pauseForUserInput).not.toHaveBeenCalled();
  });

  it("auto-switches to the preferred non-temp workspace for ambiguous temp tasks", () => {
    const preferredWorkspace = {
      id: "ws-preferred",
      name: "Preferred",
      path: process.cwd(),
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };
    const fakeThis: Any = {
      workspace: { isTemp: true, id: TEMP_WORKSPACE_ID, path: process.cwd() },
      task: { id: "t1", workspaceId: TEMP_WORKSPACE_ID },
      sandboxRunner: null,
      toolRegistry: { setWorkspace: vi.fn() },
      daemon: {
        getMostRecentNonTempWorkspace: vi.fn(() => preferredWorkspace),
        updateTaskWorkspace: vi.fn(),
        logEvent: vi.fn(),
      },
      getWorkspaceSignalsForPath: vi.fn(() => ({
        hasEntries: true,
        hasProjectMarkers: true,
        hasCodeFiles: false,
        hasAppDirs: false,
      })),
    };

    const switched = (
      TaskExecutor as Any
    ).prototype.tryAutoSwitchToPreferredWorkspaceForAmbiguousTask.call(
      fakeThis,
      "ambiguous_temp_workspace",
    );

    expect(switched).toBe(true);
    expect(fakeThis.workspace.id).toBe("ws-preferred");
    expect(fakeThis.task.workspaceId).toBe("ws-preferred");
    expect(fakeThis.toolRegistry.setWorkspace).toHaveBeenCalledWith(preferredWorkspace);
    expect(fakeThis.daemon.updateTaskWorkspace).toHaveBeenCalledWith("t1", "ws-preferred");
  });

  it("does not preflight-fail create/build steps that mention artifacts to be created", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s1",
      description:
        "Add a simple host entry in SystemMetricsWidgetApp.swift, run a build cycle, and create canvas/system-metrics-widget-preview.html.",
      kind: "primary",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("does not preflight-fail verification-only relative paths that are not yet materialized", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s2",
      description:
        "Verify and inspect SystemMetricsWidgetApp.swift and canvas/system-metrics-widget-preview.html.",
      kind: "verification",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("does not preflight-fail verification steps that reference remote absolute system paths", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s2-remote",
      description:
        "Check VM-side SSH service logs via Azure Run Command and inspect `/var/log/auth.log` and `/var/log/secure`.",
      kind: "verification",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("does not preflight-fail missing absolute workspace paths during verification planning", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const workspacePath = process.cwd();
    fakeThis.workspace = { path: workspacePath };
    const missingWorkspacePath = `${workspacePath}/tmp/nonexistent-verification-artifact.md`;
    const step = {
      id: "s2-workspace-abs",
      description: `Verify and inspect ${missingWorkspacePath}.`,
      kind: "verification",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("auto-recovery heuristic includes missing workspace artifact failures", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.planRevisionCount = 0;
    fakeThis.maxPlanRevisions = 5;
    fakeThis.classifyRecoveryFailure = vi.fn(() => "local_runtime");
    fakeThis.isRecoveryPlanStep = vi.fn(() => false);
    const step = { id: "s-recovery-1", description: "Check VM-side logs", kind: "primary" };

    const shouldRecover = (TaskExecutor as Any).prototype.shouldAutoPlanRecovery.call(
      fakeThis,
      step,
      "missing_required_workspace_artifact: /var/log/auth.log, /var/log/secure",
    );
    expect(shouldRecover).toBe(true);
  });

  it("auto-recovery heuristic includes cross-step tool block failures", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.planRevisionCount = 0;
    fakeThis.maxPlanRevisions = 5;
    fakeThis.classifyRecoveryFailure = vi.fn(() => "local_runtime");
    fakeThis.isRecoveryPlanStep = vi.fn(() => false);
    const step = { id: "s-recovery-2", description: "Run SSH diagnostics", kind: "primary" };

    const shouldRecover = (TaskExecutor as Any).prototype.shouldAutoPlanRecovery.call(
      fakeThis,
      step,
      "Tool run_command has failed 6 times across previous steps",
    );
    expect(shouldRecover).toBe(true);
  });

  it("does not apply cross-step failure hard block to execution tools", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const exemptRunCommand = (TaskExecutor as Any).prototype.isCrossStepFailureBlockExemptTool.call(
      fakeThis,
      "run_command",
    );
    const exemptAppleScript = (TaskExecutor as Any).prototype.isCrossStepFailureBlockExemptTool.call(
      fakeThis,
      "run_applescript",
    );
    const exemptWebSearch = (TaskExecutor as Any).prototype.isCrossStepFailureBlockExemptTool.call(
      fakeThis,
      "web_search",
    );

    expect(exemptRunCommand).toBe(true);
    expect(exemptAppleScript).toBe(true);
    expect(exemptWebSearch).toBe(false);
  });

  it("does not preflight-fail mixed verification plus write-note steps", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s3",
      description:
        "Verify: run a full functional pass by opening `index.html` and checking interactions; then provide a short usage note in `README.md`.",
      kind: "primary",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("does not preflight-fail checklist verification paths when file is missing", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s-checklist-inline",
      description:
        "Verification step: run final editorial checklist in newsletter/weekly/YYYY-WW/final-checklist.md confirming sections, sources, and style.",
      kind: "verification",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("downgrades explicit checklist write paths to inline output when target is missing", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s-checklist-downgrade",
      description:
        "Verification step: write checklist to newsletter/weekly/YYYY-WW/final-checklist.md and verify links/style.",
      kind: "verification",
      status: "pending",
    };

    const decisions = (TaskExecutor as Any).prototype.getVerificationArtifactPathDecisions.call(
      fakeThis,
      step,
    );
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "newsletter/weekly/YYYY-WW/final-checklist.md",
          role: "optional_output_inline",
          downgradedFromWrite: true,
        }),
      ]),
    );
  });

  it("requires existing-only checklist writes when target file exists", () => {
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-checklist-policy-"));
    const checklistPath = path.join(tempDir, "final-checklist.md");
    fs.writeFileSync(checklistPath, "# Existing checklist\n", "utf8");

    try {
      const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
      fakeThis.workspace = { path: process.cwd(), isTemp: false };
      fakeThis.agentPolicyConfig = null;
      const step = {
        id: "s-checklist-existing-write",
        description: `Verification step: write checklist to ${checklistPath} and verify links/style.`,
        kind: "verification",
        status: "pending",
      };

      const contract = (TaskExecutor as Any).prototype.resolveStepExecutionContract.call(fakeThis, step);
      expect(Array.from(contract.requiredTools)).toContain("write_file");
      expect(contract.mode).toBe("mutation_required");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not preflight-fail draft-and-verify artifact steps when the draft file does not exist yet", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s3b",
      description:
        "Draft `daily-ai-agent-trends-2026-03-03.md` with sections and verify every claim against source timestamps.",
      kind: "primary",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("ignores command snippets when checking verification artifact preflight", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "s4",
      description:
        "Verification: run the local server (`python3 -m http.server`) and manually validate key flows.",
      kind: "verification",
      status: "pending",
    };

    const reason = (TaskExecutor as Any).prototype.getMissingWorkspaceArtifactPreflightReason.call(
      fakeThis,
      step,
    );
    expect(reason).toBeNull();
  });

  it("requires write_file for write-intent steps that target source/project artifact files", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "Build widget UI in SystemMetricsWidgetExtension/SystemMetricsWidget.swift and wire the provider.",
    ) as Set<string>;

    expect(requiredTools.has("write_file")).toBe(true);
  });

  it("ignores non-tool via phrases such as localStorage when inferring required tools", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "Implement Notepad save/load via localStorage and keyboard shortcuts.",
    ) as Set<string>;

    expect(requiredTools.has("localstorage")).toBe(false);
  });

  it("does not require request_user_input when the step makes structured input conditional on missing git metadata", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.task = {
      agentConfig: {
        executionMode: "plan",
      },
    };
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "Use request_user_input to confirm the target GitHub repository in `owner/repo` format and the review scope if it cannot be derived from the current workspace git metadata.",
    ) as Set<string>;

    expect(requiredTools.has("request_user_input")).toBe(false);
  });

  it("still infers real tools from via phrases when the tool exists", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "Research the error via web_search and summarize likely root causes.",
    ) as Set<string>;

    expect(requiredTools.has("web_search")).toBe(true);
  });

  it("requires run_command for generic command execution steps with stdout-style success criteria", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "You want the command run in the current session context, and success means it prints `hello world`.",
    ) as Set<string>;

    expect(requiredTools.has("run_command")).toBe(true);
  });

  it("infers required tools from explicit call-tool directives in plan steps", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.toolRegistry = {
      getTools: () => [{ name: "task_events" }],
    };
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      'Call tool `task_events` with period="custom" and include_payload=true.',
    ) as Set<string>;

    expect(requiredTools.has("task_events")).toBe(true);
  });

  it("infers required tool evidence from `from <tool> output` dependencies", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.toolRegistry = {
      getTools: () => [{ name: "task_events" }],
    };
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "From `task_events` output, summarize retained events into Topics and Stats.",
    ) as Set<string>;

    expect(requiredTools.has("task_events")).toBe(true);
  });

  it("does not classify setup/naming steps as mutation-required when they only name an output file", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.agentPolicyConfig = null;
    const step = {
      id: "s5",
      description:
        "Set research window to the last 24 hours and define output file name `daily-ai-agent-trends-2026-03-03.md`; prepare a short source matrix.",
      kind: "primary",
      status: "pending",
    };

    const contract = (TaskExecutor as Any).prototype.resolveStepExecutionContract.call(fakeThis, step);
    expect(contract.mode).not.toBe("mutation_required");
  });

  it("infers mutation-required contract for lock requirements steps with concrete artifact paths", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.agentPolicyConfig = null;
    fakeThis.workspace = { path: process.cwd() };
    const step = {
      id: "lock-requirements",
      description:
        "Lock requirements in /tmp/linux/coworkos/requirements.md with Debian defaults.",
      kind: "primary",
      status: "pending",
    };

    const contract = (TaskExecutor as Any).prototype.resolveStepExecutionContract.call(fakeThis, step);
    expect(contract.mode).toBe("mutation_required");
    expect(Array.from(contract.requiredTools)).toContain("write_file");
  });

  it("auto-promotes strategy-inferred plan mode for mutation-required steps", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { permissions: { shell: true } };
    fakeThis.task = {
      id: "task-1",
      agentConfig: {
        executionMode: "plan",
        executionModeSource: "strategy",
        taskDomain: "code",
      },
    };
    fakeThis.emitEvent = vi.fn();

    const step = { id: "s-align-1", description: "Write file", kind: "primary", status: "pending" };
    const stepContract = {
      mode: "mutation_required",
      requiredTools: new Set(["write_file"]),
      contractReason: "step_requires_artifact_mutation",
    } as Any;

    const alignment = (TaskExecutor as Any).prototype.alignExecutionModeForMutationContract.call(
      fakeThis,
      step,
      stepContract,
    );

    expect(alignment.status).toBe("promoted");
    expect(fakeThis.task.agentConfig.executionMode).toBe("execute");
    expect(fakeThis.task.agentConfig.executionModeSource).toBe("auto_promote");
    expect(
      fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "execution_mode_auto_promoted"),
    ).toBe(true);
  });

  it("fails fast on mutation-required steps when user-locked read-only mode blocks required tools", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { permissions: { shell: true } };
    fakeThis.task = {
      id: "task-2",
      agentConfig: {
        executionMode: "plan",
        executionModeSource: "user",
        taskDomain: "code",
      },
    };
    fakeThis.emitEvent = vi.fn();

    const step = { id: "s-align-2", description: "Write file", kind: "primary", status: "pending" };
    const stepContract = {
      mode: "mutation_required",
      requiredTools: new Set(["write_file"]),
      contractReason: "step_requires_artifact_mutation",
    } as Any;

    const alignment = (TaskExecutor as Any).prototype.alignExecutionModeForMutationContract.call(
      fakeThis,
      step,
      stepContract,
    );

    expect(alignment.status).toBe("conflict");
    expect(fakeThis.task.agentConfig.executionMode).toBe("plan");
    expect(
      fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "plan_contract_conflict"),
    ).toBe(true);
  });

  it("treats legacy read-only execution modes as user-owned during mutation alignment", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { permissions: { shell: true } };
    fakeThis.task = {
      id: "task-legacy-mode",
      agentConfig: {
        executionMode: "plan",
        taskIntent: "execution",
        taskDomain: "code",
      },
    };
    fakeThis.emitEvent = vi.fn();

    const step = {
      id: "s-align-legacy",
      description: "Write file",
      kind: "primary",
      status: "pending",
    };
    const stepContract = {
      mode: "mutation_required",
      requiredTools: new Set(["write_file"]),
      contractReason: "step_requires_artifact_mutation",
    } as Any;

    const alignment = (TaskExecutor as Any).prototype.alignExecutionModeForMutationContract.call(
      fakeThis,
      step,
      stepContract,
    );

    expect(alignment.status).toBe("conflict");
    expect(fakeThis.task.agentConfig.executionMode).toBe("plan");
    expect(fakeThis.task.agentConfig.executionModeSource).toBeUndefined();
    expect(
      fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "execution_mode_auto_promoted"),
    ).toBe(false);
    expect(
      fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "plan_contract_conflict"),
    ).toBe(true);
  });

  it("auto-recovers workspace-boundary list_directory failures to in-workspace paths", async () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.emitEvent = vi.fn();
    fakeThis.reliabilityWorkspaceAliasRewriteV5Enabled = true;
    fakeThis.workspacePathAliasPolicy = "rewrite_and_retry";
    fakeThis.executeToolWithHeartbeat = vi.fn(async (_tool: string, input: Any) => ({
      success: true,
      files: [],
      path: input.path,
    }));

    const recovered = await (TaskExecutor as Any).prototype.tryWorkspaceBoundaryRecovery.call(
      fakeThis,
      {
        toolName: "list_directory",
        input: { path: "/" },
        errorMessage:
          'Path is outside workspace boundary. Attempted path: /. Workspace: /tmp/linux.',
        toolTimeoutMs: 1_000,
        targetPaths: ["/tmp/linux/coworkos/requirements.md"],
        stepId: "s-boundary",
      },
    );

    expect(recovered.recovered).toBe(true);
    expect(recovered.input?.path).toBe(".");
  });

  it("auto-recovers ENOENT /workspace alias failures for mutation tools", async () => {
    const workspacePath = path.join(process.cwd(), "tmp-test-workspace");
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: workspacePath };
    fakeThis.emitEvent = vi.fn();
    fakeThis.reliabilityWorkspaceAliasRewriteV5Enabled = true;
    fakeThis.reliabilityAliasRecoveryRetryV5Enabled = true;
    fakeThis.workspacePathAliasPolicy = "rewrite_and_retry";
    fakeThis.executeToolWithHeartbeat = vi.fn(async (_tool: string, input: Any) => ({
      success: true,
      path: input.path,
    }));

    const recovered = await (TaskExecutor as Any).prototype.tryWorkspaceBoundaryRecovery.call(
      fakeThis,
      {
        toolName: "write_file",
        input: { path: "/workspace/influencer-chat-app/src/data/influencers.ts", content: "x" },
        errorMessage: "Failed to write file: ENOENT: no such file or directory, mkdir '/workspace'",
        toolTimeoutMs: 1_000,
        stepId: "s-alias",
      },
    );

    expect(recovered.recovered).toBe(true);
    expect(recovered.input?.path).toBe("influencer-chat-app/src/data/influencers.ts");
    expect(
      fakeThis.emitEvent.mock.calls.some(
        (call: Any[]) => call[0] === "workspace_path_alias_recovery_attempted",
      ),
    ).toBe(true);
  });

  it("rewrites /workspace aliases during plan sanitization to workspace-relative paths", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.emitEvent = vi.fn();
    fakeThis.reliabilityWorkspaceAliasRewriteV5Enabled = true;
    fakeThis.workspacePathAliasPolicy = "rewrite_and_retry";

    const plan = {
      description: "build app",
      steps: [
        {
          id: "1",
          description:
            "Scaffold the app at `/workspace/influencer-chat-app` and write `/workspace/influencer-chat-app/src/data/influencers.ts`.",
          kind: "primary",
          status: "pending",
        },
      ],
    };

    const sanitized = (TaskExecutor as Any).prototype.sanitizePlan.call(fakeThis, plan);
    expect(String(sanitized.steps[0].description)).toContain("influencer-chat-app/src/data/influencers.ts");
    expect(String(sanitized.steps[0].description)).not.toContain("/workspace/influencer-chat-app");
    expect(
      fakeThis.emitEvent.mock.calls.some(
        (call: Any[]) => call[0] === "workspace_path_alias_normalized",
      ),
    ).toBe(true);
  });

  it("pins task root from scaffold cue and rewrites mixed relative paths during sanitize", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.emitEvent = vi.fn();
    fakeThis.reliabilityTaskRootPinningV6Enabled = true;
    fakeThis.reliabilityPathDriftRewriteV6Enabled = true;
    fakeThis.reliabilityPathDriftRetryV6Enabled = true;
    fakeThis.reliabilityWorkspaceAliasRewriteV5Enabled = false;
    fakeThis.taskPathRootPolicy = "pin_and_rewrite";
    fakeThis.taskPinnedRoot = ".";
    fakeThis.taskPinnedRootSource = "unset";
    fakeThis.stepAliasPathHints = Object.create(null);

    const plan = {
      description: "build app",
      steps: [
        {
          id: "1",
          description:
            "Create project foundation at ~/influencer-chat/ with app/, data/, and public/ folders.",
          kind: "primary",
          status: "pending",
        },
        {
          id: "2",
          description:
            "Implement UI in app/page.tsx, add data/influencers.json, and wire components/Composer.tsx.",
          kind: "primary",
          status: "pending",
        },
      ],
    };

    const sanitized = (TaskExecutor as Any).prototype.sanitizePlan.call(fakeThis, plan);
    const secondStepDescription = String(sanitized.steps[1].description);
    expect(fakeThis.taskPinnedRoot).toBe("influencer-chat");
    expect(secondStepDescription).toContain("influencer-chat/app/page.tsx");
    expect(secondStepDescription).toContain("influencer-chat/data/influencers.json");
    expect(secondStepDescription).toContain("influencer-chat/components/Composer.tsx");
    expect(fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "task_path_root_pinned")).toBe(
      true,
    );
    expect(fakeThis.emitEvent.mock.calls.some((call: Any[]) => call[0] === "task_path_rewrite_applied")).toBe(
      true,
    );
  });

  it("does not pin task root from non-scaffold timing phrases", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.emitEvent = vi.fn();
    fakeThis.reliabilityTaskRootPinningV6Enabled = true;
    fakeThis.reliabilityPathDriftRewriteV6Enabled = true;
    fakeThis.reliabilityPathDriftRetryV6Enabled = true;
    fakeThis.reliabilityWorkspaceAliasRewriteV5Enabled = false;
    fakeThis.taskPathRootPolicy = "pin_and_rewrite";
    fakeThis.taskPinnedRoot = ".";
    fakeThis.taskPinnedRootSource = "unset";
    fakeThis.stepAliasPathHints = Object.create(null);

    const plan = {
      description: "Research recent AI agent updates",
      steps: [
        {
          id: "1",
          description:
            "Verify that all referenced sources are within the last 24 hours and summarize the findings.",
          kind: "verification",
          status: "pending",
        },
      ],
    };

    (TaskExecutor as Any).prototype.sanitizePlan.call(fakeThis, plan);
    expect(fakeThis.taskPinnedRoot).toBe(".");
    expect(
      fakeThis.emitEvent.mock.calls.some(
        (call: Any[]) =>
          call[0] === "task_path_root_pinned" &&
          call[1] &&
          typeof call[1] === "object" &&
          call[1].root === "the",
      ),
    ).toBe(false);
  });

  it("auto-recovers relative path drift to pinned root with retry budget", async () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.task = { id: "task-v6" };
    fakeThis.emitEvent = vi.fn();
    fakeThis.executeToolWithHeartbeat = vi.fn(async (_tool: string, input: Any) => ({
      success: true,
      path: input.path,
    }));
    fakeThis.reliabilityTaskRootPinningV6Enabled = true;
    fakeThis.reliabilityPathDriftRewriteV6Enabled = true;
    fakeThis.reliabilityPathDriftRetryV6Enabled = true;
    fakeThis.taskPathRootPolicy = "pin_and_rewrite";
    fakeThis.taskPinnedRoot = "influencer-chat";
    fakeThis.taskPinnedRootSource = "plan";
    fakeThis.pathDriftRetryBudget = 3;
    fakeThis.pathDriftRecoveryAttemptsByStep = Object.create(null);
    fakeThis.pathDriftRecoverySignatureAttempts = Object.create(null);
    fakeThis.reliabilityAliasRecoveryRetryV5Enabled = false;

    const recovered = await (TaskExecutor as Any).prototype.tryWorkspaceBoundaryRecovery.call(
      fakeThis,
      {
        toolName: "read_file",
        input: { path: "data/influencers.json" },
        errorMessage: "Failed to read file: ENOENT: no such file or directory",
        toolTimeoutMs: 1_000,
        stepId: "s-v6-recover",
      },
    );

    expect(recovered.recovered).toBe(true);
    expect(recovered.input?.path).toBe("influencer-chat/data/influencers.json");
    expect(
      fakeThis.emitEvent.mock.calls.some(
        (call: Any[]) => call[0] === "task_path_recovery_attempted",
      ),
    ).toBe(true);
  });

  it("returns a discovery hint when relative path drift recovery budget is exhausted", async () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.task = { id: "task-v6-budget" };
    fakeThis.emitEvent = vi.fn();
    fakeThis.executeToolWithHeartbeat = vi.fn();
    fakeThis.reliabilityTaskRootPinningV6Enabled = true;
    fakeThis.reliabilityPathDriftRewriteV6Enabled = true;
    fakeThis.reliabilityPathDriftRetryV6Enabled = true;
    fakeThis.taskPathRootPolicy = "pin_and_rewrite";
    fakeThis.taskPinnedRoot = "influencer-chat";
    fakeThis.taskPinnedRootSource = "plan";
    fakeThis.pathDriftRetryBudget = 1;
    fakeThis.pathDriftRecoveryAttemptsByStep = { "s-v6-budget": 1 };
    fakeThis.pathDriftRecoverySignatureAttempts = Object.create(null);
    fakeThis.reliabilityAliasRecoveryRetryV5Enabled = false;

    const recovered = await (TaskExecutor as Any).prototype.tryWorkspaceBoundaryRecovery.call(
      fakeThis,
      {
        toolName: "read_file",
        input: { path: "data/influencers.json" },
        errorMessage: "Failed to read file: ENOENT: no such file or directory",
        toolTimeoutMs: 1_000,
        stepId: "s-v6-budget",
      },
    );

    expect(recovered.recovered).toBe(false);
    expect(String(recovered.failureHint || "")).toContain("Do not retry the same missing path");
    expect(String(recovered.failureHint || "")).toContain("glob, list_directory, or search_files");
    expect(
      fakeThis.emitEvent.mock.calls.some(
        (call: Any[]) =>
          call[0] === "task_path_recovery_failed" &&
          call[1]?.reason === "retry_budget_exhausted",
      ),
    ).toBe(true);
  });

  it("detects strict pinned-root path mismatch", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.workspace = { path: process.cwd() };
    fakeThis.reliabilityTaskRootPinningV6Enabled = true;
    fakeThis.taskPathRootPolicy = "strict_fail";
    fakeThis.taskPinnedRoot = "influencer-chat";
    fakeThis.taskPinnedRootSource = "plan";

    const violation = (TaskExecutor as Any).prototype.detectStrictTaskRootPathViolationInInput.call(
      fakeThis,
      "write_file",
      { path: "app/page.tsx", content: "x" },
    );

    expect(violation).not.toBeNull();
    expect(violation.expected).toBe("influencer-chat/app/page.tsx");
  });

  it("auto-recovery heuristic includes workspace-boundary failures", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    fakeThis.planRevisionCount = 0;
    fakeThis.maxPlanRevisions = 5;
    fakeThis.classifyRecoveryFailure = vi.fn(() => "local_runtime");
    fakeThis.isRecoveryPlanStep = vi.fn(() => false);
    const step = { id: "s-recovery-boundary", description: "List files", kind: "primary" };

    const shouldRecover = (TaskExecutor as Any).prototype.shouldAutoPlanRecovery.call(
      fakeThis,
      step,
      'Path is outside workspace boundary. Enable "Unrestricted File Access" or add allowed paths.',
    );
    expect(shouldRecover).toBe(true);
  });

  it("still infers write_file for explicit draft-to-file steps", () => {
    const fakeThis: Any = Object.create((TaskExecutor as Any).prototype);
    const requiredTools = (TaskExecutor as Any).prototype.extractRequiredToolsFromStepDescription.call(
      fakeThis,
      "Draft daily-ai-agent-trends-2026-03-03.md with sections and citations.",
    ) as Set<string>;

    expect(requiredTools.has("write_file")).toBe(true);
  });
});
