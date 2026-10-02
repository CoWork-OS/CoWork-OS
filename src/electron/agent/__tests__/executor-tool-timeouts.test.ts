import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { APPROVAL_GATED_TOOL_TIMEOUT_MS } from "../approval-timeouts";
import {
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_FAILURE_CAPTURE_TIMEOUT_MS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_WAIT_TIMEOUT_MS,
} from "../browser/browser-timeouts";
import { BuiltinToolsSettingsManager } from "../tools/builtin-settings";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("../../memory/MemoryService", () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(""),
  },
}));

describe("TaskExecutor getToolTimeoutMs", () => {
  it("gives orchestrate_agents enough time to wait for child agents", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("orchestrate_agents", {
      timeout_seconds: 300,
    });

    expect(timeoutMs).toBe(302_000);
    timeoutSpy.mockRestore();
  });

  it("uses a long timeout window for request_user_input by default", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("request_user_input", {
      questions: [
        {
          id: "delivery_mode",
          question: "Choose delivery mode",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
        },
      ],
    });

    expect(timeoutMs).toBe(86_400_000);
    timeoutSpy.mockRestore();
  });

  it("uses a longer default timeout for run_command", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("run_command", {
      command: "git status",
    });

    expect(timeoutMs).toBe(120_000);
    timeoutSpy.mockRestore();
  });

  it("uses the heavy run_command timeout for build and test commands", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("run_command", {
      command: "npm test",
    });

    expect(timeoutMs).toBe(300_000);
    timeoutSpy.mockRestore();
  });

  it("accepts timeout_seconds aliases for run_command and clamps to shell max", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("run_command", {
      command: "node scripts/build.js",
      timeout_seconds: 480,
    });

    expect(timeoutMs).toBe(300_000);
    timeoutSpy.mockRestore();
  });

  it("gives image generation enough time to avoid retrying slow provider calls", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("generate_image", {
      prompt: "snow leopard avatar",
    });

    expect(timeoutMs).toBe(600_000);
    timeoutSpy.mockRestore();
  });

  it("outlasts browser action and navigation budgets so their own errors reach the model", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    expect(executor.getToolTimeoutMs("browser_click", { selector: "#submit" })).toBeGreaterThan(
      BROWSER_ACTION_TIMEOUT_MS + BROWSER_FAILURE_CAPTURE_TIMEOUT_MS,
    );
    expect(executor.getToolTimeoutMs("browser_wait", { selector: "#results" })).toBeGreaterThan(
      BROWSER_WAIT_TIMEOUT_MS + BROWSER_FAILURE_CAPTURE_TIMEOUT_MS,
    );
    expect(
      executor.getToolTimeoutMs("browser_navigate", { url: "https://a.test" }),
    ).toBeGreaterThan(BROWSER_NAVIGATION_TIMEOUT_MS);
    expect(
      executor.getToolTimeoutMs("browser_click", { selector: "#slow", timeout_ms: 90_000 }),
    ).toBeGreaterThan(90_000 + BROWSER_FAILURE_CAPTURE_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  describe("outer deadline", () => {
    const createExecutor = (executeTool: () => Promise<unknown>) => {
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.task = { id: "task-1", agentConfig: { deepWorkMode: false } };
      executor.abortController = new AbortController();
      executor.streamingToolExecutor = null;
      executor.currentStepId = null;
      executor.getSchedulerSpecForTool = vi.fn(() => ({
        concurrencyClass: "exclusive",
        idempotent: false,
      }));
      executor.getToolPolicyContext = vi.fn(() => ({}));
      executor.toolExecutionCoordinator = { executeTool: vi.fn(executeTool) };
      return executor;
    };
    // 100s waiting for the user to approve, then a 110s build.
    const approvedLateBuild = () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ result: { success: true }, durationMs: 210_000, resultJson: "{}" }),
          210_000,
        ),
      );

    it("does not let a run_command approval wait cut off the approved command", async () => {
      vi.useFakeTimers();
      try {
        const executor = createExecutor(approvedLateBuild);
        const outcome = executor
          .executeToolWithHeartbeat("run_command", { command: "npm run build" }, 120_000)
          .then(
            (value: Any) => ({ value }),
            (error: Error) => ({ error }),
          );

        await vi.advanceTimersByTimeAsync(210_000);

        await expect(outcome).resolves.toEqual({
          value: expect.objectContaining({ result: { success: true } }),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps other tools on their own budget", async () => {
      vi.useFakeTimers();
      try {
        const executor = createExecutor(approvedLateBuild);
        const outcome = executor
          .executeToolWithHeartbeat("web_fetch", { url: "https://example.com" }, 120_000)
          .then(
            (value: Any) => ({ value }),
            (error: Error) => ({ error }),
          );

        await vi.advanceTimersByTimeAsync(210_000);

        const settled = (await outcome) as { error?: Error };
        expect(settled.error?.message).toMatch(/timed out after 120s/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not let approval review consume the ordinary tool timeout", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };
    executor.toolRegistry = {
      getApprovalType: vi.fn().mockReturnValue("workspace_write"),
    };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("create_directory", {
      path: "inbox/finance",
    });

    expect(timeoutMs).toBe(APPROVAL_GATED_TOOL_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });
});
