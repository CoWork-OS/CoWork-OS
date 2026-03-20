import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";

const runMock = vi.fn();
const getCurrentRunMock = vi.fn();
const runCurrentPageCheckMock = vi.fn();
const hasBlockingIssuesMock = vi.fn();
const cleanupMock = vi.fn();

vi.mock("../../qa/playwright-qa-service", () => ({
  PlaywrightQAService: class {
    run = runMock;
    getCurrentRun = getCurrentRunMock;
    runCurrentPageCheck = runCurrentPageCheckMock;
    hasBlockingIssues = hasBlockingIssuesMock;
    cleanup = cleanupMock;

    constructor(_workspace: Workspace) {}
  },
}));

describe("QATools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentRunMock.mockReturnValue(null);
    hasBlockingIssuesMock.mockReturnValue(false);
  });

  it("treats blocking QA issues as a failed run", async () => {
    runMock.mockResolvedValue({
      status: "completed",
      durationMs: 1200,
      summary: "Found major issues",
      checks: [],
      issues: [{ severity: "major" }],
      interactionLog: [],
      finalScreenshotPath: undefined,
    });
    hasBlockingIssuesMock.mockReturnValue(true);

    const { QATools } = await import("../qa-tools");
    const tools = new QATools({ path: "/tmp/workspace" } as Workspace, {} as never, "task-1");

    const result = JSON.parse(await tools.execute("qa_run", {}));

    expect(result.success).toBe(false);
    expect(result.report).toContain("QA Run Complete");
  });

  it("checks the current page without restarting the QA session", async () => {
    getCurrentRunMock.mockReturnValue({
      config: { targetUrl: "http://localhost:3000" },
    });
    runCurrentPageCheckMock.mockResolvedValue({
      type: "console_errors",
      label: "Console Errors",
      description: "Check for browser console issues",
      passed: true,
      issues: [],
      durationMs: 18,
    });

    const { QATools } = await import("../qa-tools");
    const tools = new QATools({ path: "/tmp/workspace" } as Workspace, {} as never, "task-1");

    const result = JSON.parse(await tools.execute("qa_check", { check_type: "console_errors" }));

    expect(runMock).not.toHaveBeenCalled();
    expect(runCurrentPageCheckMock).toHaveBeenCalledWith("console_errors");
    expect(result.success).toBe(true);
    expect(result.check.type).toBe("console_errors");
  });
});
