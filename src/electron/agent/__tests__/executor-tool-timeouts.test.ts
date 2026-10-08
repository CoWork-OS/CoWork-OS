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
  MemoryService: {},
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

  it("lets pact_send_message outlast a business sign-in", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };
    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);
    // The device-code wait alone may take 30 minutes.
    expect(
      executor.getToolTimeoutMs("pact_send_message", { business_id: "b", message: "hi" }),
    ).toBe(45 * 60 * 1000);
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

  it("accepts timeout_seconds aliases for run_command beyond the old five-minute cap", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };

    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const timeoutMs = executor.getToolTimeoutMs("run_command", {
      command: "node scripts/build.js",
      timeout_seconds: 480,
    });

    expect(timeoutMs).toBe(480_000);
    timeoutSpy.mockRestore();
  });

  it("clamps explicit run_command timeouts to the step budget and the 30-minute shell max", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    // Standard steps last 15 minutes; the command must finish inside the step.
    executor.task = { agentConfig: { deepWorkMode: false } };
    expect(executor.getToolTimeoutMs("run_command", { command: "make", timeout: 1_800_000 })).toBe(
      895_000,
    );

    // Deep-work steps last 45 minutes, so the shell max applies.
    executor.task = { agentConfig: { deepWorkMode: true } };
    expect(
      executor.getToolTimeoutMs("run_command", { command: "make", timeout_seconds: 1_800 }),
    ).toBe(1_800_000);
    expect(executor.getToolTimeoutMs("run_command", { command: "make", timeout: 7_200_000 })).toBe(
      1_800_000,
    );
    // Inferred defaults are unchanged.
    expect(executor.getToolTimeoutMs("run_command", { command: "git status" })).toBe(120_000);
    expect(executor.getToolTimeoutMs("run_command", { command: "npm test" })).toBe(300_000);
    timeoutSpy.mockRestore();
  });

  it("keeps a configured run_command timeout within the step budget and shell max", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: true } };
    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(3_600_000);

    expect(executor.getToolTimeoutMs("run_command", { command: "git status" })).toBe(1_800_000);
    timeoutSpy.mockRestore();
  });

  it("budgets execute_code for its approval wait plus its requested run time", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { deepWorkMode: false } };
    executor.toolRegistry = { getApprovalType: () => "run_command" };
    const timeoutSpy = vi
      .spyOn(BuiltinToolsSettingsManager, "getToolTimeoutMs")
      .mockReturnValue(null);

    const long = executor.getToolTimeoutMs("execute_code", {
      language: "python",
      code: "train()",
      timeout_seconds: 300,
    });
    expect(long).toBeGreaterThanOrEqual(300_000 + APPROVAL_GATED_TOOL_TIMEOUT_MS);
    expect(long).toBeLessThan(15 * 60 * 1000);

    const short = executor.getToolTimeoutMs("execute_code", { language: "shell", code: "ls" });
    expect(short).toBeGreaterThanOrEqual(30_000 + APPROVAL_GATED_TOOL_TIMEOUT_MS);
    expect(short).toBeLessThan(long);
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
