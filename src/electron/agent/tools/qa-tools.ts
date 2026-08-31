/**
 * QA Tools — automated Playwright-based visual QA for the agent.
 *
 * These tools let the agent automatically test web apps after building them:
 *   qa_run          — full automated QA pipeline (start server, test, report)
 *   qa_navigate     — navigate and capture page state
 *   qa_interact     — click, fill, hover, scroll on elements
 *   qa_screenshot   — take a QA screenshot with diagnostics
 *   qa_check        — run a specific check (console, network, visual, a11y, perf)
 *   qa_report       — get the current QA run report
 *   qa_cleanup      — tear down the QA browser and server
 */

import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { PlaywrightQAService } from "../qa/playwright-qa-service";
import { QARunConfig, QACheckType, QAInteractionStep, DEFAULT_QA_CONFIG } from "../qa/types";
import { LLMTool } from "../llm/types";
import { createWorkspaceFilesystemApprovalHandlers } from "../../security/access-profile-paths";

type Any = any;

export class QATools {
  private qaService: PlaywrightQAService;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {
    this.qaService = this.createQAService(workspace);
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.qaService = this.createQAService(workspace);
  }

  private createQAService(workspace: Workspace): PlaywrightQAService {
    return new PlaywrightQAService(
      workspace,
      undefined,
      async (command, cwd) =>
        await this.daemon.requestApproval(
          this.taskId,
          "run_command",
          `Approve the QA server command: ${command}`,
          {
            tool: "qa_run",
            command,
            cwd,
            path: cwd,
            approvalMode: "qa_server",
          },
          { allowAutoApprove: false },
        ),
      createWorkspaceFilesystemApprovalHandlers(this.daemon, this.taskId, "qa"),
    );
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "qa_run",
        description:
          "Run a full automated QA pipeline on a web app using Playwright. " +
          "Starts the dev server (if needed), launches a headless browser, navigates to the app, " +
          "runs visual checks, checks for console/network errors, tests interactive elements, " +
          "and returns a detailed report with screenshots. " +
          "Use this after building or modifying a web app to catch bugs before shipping. " +
          "The report includes issues categorized by severity (critical, major, minor).",
        input_schema: {
          type: "object" as const,
          properties: {
            target_url: {
              type: "string",
              description:
                "URL to test (e.g., http://localhost:3000). Defaults to http://localhost:3000.",
            },
            server_command: {
              type: "string",
              description:
                "Command to start the dev server (e.g., 'npm run dev', 'python -m http.server 3000'). " +
                "Omit if the server is already running.",
            },
            server_cwd: {
              type: "string",
              description: "Working directory for the server command. Defaults to workspace root.",
            },
            server_port: {
              type: "number",
              description:
                "Port to wait for before starting tests. Auto-detected from URL if omitted.",
            },
            checks: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "visual_snapshot",
                  "console_errors",
                  "network_errors",
                  "interaction_test",
                  "responsive_check",
                  "accessibility_check",
                  "performance_check",
                ],
              },
              description:
                "Which checks to run. Defaults to: visual_snapshot, console_errors, network_errors, interaction_test.",
            },
            headless: {
              type: "boolean",
              description:
                "Run browser in headless mode (default: true). Set false to see the browser.",
            },
            auto_fix: {
              type: "boolean",
              description: "Whether to report issues for auto-fixing (default: true).",
            },
          },
          required: [],
        },
      },
      {
        name: "qa_navigate",
        description:
          "Navigate the QA browser to a URL and get a page state report. " +
          "Returns URL, title, text content, console errors, broken images, and element count. " +
          "Use this for step-by-step manual QA testing.",
        input_schema: {
          type: "object" as const,
          properties: {
            url: {
              type: "string",
              description: "URL to navigate to",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "qa_interact",
        description:
          "Perform an interaction on the current QA page (click, fill, hover, scroll, wait). " +
          "Use for testing specific user flows. Returns success status and optional screenshot.",
        input_schema: {
          type: "object" as const,
          properties: {
            action: {
              type: "string",
              enum: ["click", "fill", "hover", "scroll", "wait", "assert"],
              description: "The interaction to perform",
            },
            selector: {
              type: "string",
              description: "CSS selector for the target element",
            },
            value: {
              type: "string",
              description: "Value to fill (for 'fill' action) or scroll amount (for 'scroll')",
            },
            description: {
              type: "string",
              description: "Human-readable description of this interaction step",
            },
            take_screenshot: {
              type: "boolean",
              description: "Take a screenshot after this interaction (default: true)",
            },
          },
          required: ["action", "description"],
        },
      },
      {
        name: "qa_screenshot",
        description:
          "Take a QA screenshot of the current page with diagnostics. " +
          "Returns the screenshot path along with page state (console errors, broken images, etc.).",
        input_schema: {
          type: "object" as const,
          properties: {
            label: {
              type: "string",
              description:
                "Label for the screenshot (e.g., 'homepage', 'after-login', 'dark-mode')",
            },
            full_page: {
              type: "boolean",
              description: "Capture the full scrollable page (default: false)",
            },
          },
          required: [],
        },
      },
      {
        name: "qa_check",
        description:
          "Run a specific QA check on the current page. " +
          "Available checks: console_errors, network_errors, visual_snapshot, " +
          "interaction_test, responsive_check, accessibility_check, performance_check.",
        input_schema: {
          type: "object" as const,
          properties: {
            check_type: {
              type: "string",
              enum: [
                "console_errors",
                "network_errors",
                "visual_snapshot",
                "interaction_test",
                "responsive_check",
                "accessibility_check",
                "performance_check",
              ],
              description: "The check to run",
            },
          },
          required: ["check_type"],
        },
      },
      {
        name: "qa_report",
        description:
          "Get the full QA run report including all checks, issues, screenshots, and interaction log. " +
          "Use this to see the overall QA status after running checks.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "qa_cleanup",
        description:
          "Tear down the QA browser and dev server. " + "Call this when QA testing is complete.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    ];
  }

  async execute(toolName: string, input: Record<string, Any>): Promise<string> {
    try {
      switch (toolName) {
        case "qa_run":
          return await this.handleQARun(input);
        case "qa_navigate":
          return await this.handleQANavigate(input);
        case "qa_interact":
          return await this.handleQAInteract(input);
        case "qa_screenshot":
          return await this.handleQAScreenshot(input);
        case "qa_check":
          return await this.handleQACheck(input);
        case "qa_report":
          return await this.handleQAReport();
        case "qa_cleanup":
          return await this.handleQACleanup();
        default:
          return JSON.stringify({ error: `Unknown QA tool: ${toolName}` });
      }
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        tool: toolName,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  private async handleQARun(input: Record<string, Any>): Promise<string> {
    const config: Partial<QARunConfig> = {
      targetUrl: input.target_url || "http://localhost:3000",
      serverCommand: input.server_command,
      serverCwd: input.server_cwd,
      serverPort: input.server_port,
      enabledChecks: input.checks as QACheckType[] | undefined,
      headless: input.headless,
      autoFix: input.auto_fix,
    };

    const run = await this.qaService.run(this.taskId, config);

    // Build a human-readable report
    const lines: string[] = [
      `## QA Run Complete`,
      ``,
      `**Status:** ${run.status}`,
      `**Duration:** ${Math.round(run.durationMs / 1000)}s`,
      `**Summary:** ${run.summary}`,
      ``,
    ];

    if (run.checks.length > 0) {
      lines.push(`### Checks`);
      for (const check of run.checks) {
        const icon = check.passed ? "PASS" : "FAIL";
        lines.push(`- [${icon}] **${check.label}** — ${check.issues.length} issue(s)`);
        if (check.screenshotPath) {
          lines.push(`  Screenshot: ${check.screenshotPath}`);
        }
      }
      lines.push(``);
    }

    if (run.issues.length > 0) {
      lines.push(`### Issues Found (${run.issues.length})`);
      for (const issue of run.issues) {
        lines.push(`- [${issue.severity.toUpperCase()}] ${issue.title}`);
        if (issue.description !== issue.title) {
          lines.push(`  ${issue.description}`);
        }
        if (issue.screenshotPath) {
          lines.push(`  Screenshot: ${issue.screenshotPath}`);
        }
      }
      lines.push(``);
    }

    if (run.interactionLog.length > 0) {
      lines.push(`### Interaction Log (${run.interactionLog.length} steps)`);
      for (const step of run.interactionLog) {
        const icon = step.success ? "OK" : "FAIL";
        lines.push(`- [${icon}] ${step.description}`);
        if (step.error) lines.push(`  Error: ${step.error}`);
      }
      lines.push(``);
    }

    if (run.finalScreenshotPath) {
      lines.push(`### Final Screenshot`);
      lines.push(run.finalScreenshotPath);
    }

    const report = lines.join("\n");
    const success = run.status === "completed" && !this.qaService.hasBlockingIssues(run);
    return JSON.stringify({ success, report });
  }

  private async handleQANavigate(input: Record<string, Any>): Promise<string> {
    // Ensure a QA run is active — start one if not
    if (!this.qaService.getCurrentRun()) {
      await this.qaService.run(this.taskId, {
        targetUrl: input.url,
        enabledChecks: [], // No auto checks, just navigate
      });
    }

    const step: QAInteractionStep = {
      action: "navigate",
      url: input.url,
      description: `Navigate to ${input.url}`,
      success: false,
      durationMs: 0,
    };

    const result = await this.qaService.executeStep(step);

    // Get page report
    const report = await this.qaService.getPageReport();

    return JSON.stringify(
      {
        navigation: {
          success: result.success,
          error: result.error,
        },
        page: report,
      },
      null,
      2,
    );
  }

  private async handleQAInteract(input: Record<string, Any>): Promise<string> {
    const step: QAInteractionStep = {
      action: input.action,
      selector: input.selector,
      value: input.value,
      description: input.description || `${input.action} on ${input.selector || "page"}`,
      success: false,
      durationMs: 0,
    };

    const result = await this.qaService.executeStep(step);

    // Optionally take screenshot
    if (input.take_screenshot !== false) {
      const screenshotStep: QAInteractionStep = {
        action: "screenshot",
        value: `after-${input.action}`,
        description: "Post-interaction screenshot",
        success: false,
        durationMs: 0,
      };
      const ssResult = await this.qaService.executeStep(screenshotStep);
      result.screenshotPath = ssResult.screenshotPath;
    }

    return JSON.stringify(
      {
        action: result.action,
        success: result.success,
        error: result.error,
        screenshotPath: result.screenshotPath,
        durationMs: result.durationMs,
      },
      null,
      2,
    );
  }

  private async handleQAScreenshot(input: Record<string, Any>): Promise<string> {
    const step: QAInteractionStep = {
      action: "screenshot",
      value: input.label || "manual",
      description: `Screenshot: ${input.label || "manual"}`,
      success: false,
      durationMs: 0,
    };

    const result = await this.qaService.executeStep(step);

    // Also get page report
    let report = null;
    try {
      report = await this.qaService.getPageReport();
    } catch {
      // best effort
    }

    return JSON.stringify(
      {
        screenshotPath: result.screenshotPath,
        success: result.success,
        page: report,
      },
      null,
      2,
    );
  }

  private async handleQACheck(input: Record<string, Any>): Promise<string> {
    const checkType = input.check_type as QACheckType;

    // Run a full QA with just this check
    if (!this.qaService.getCurrentRun()) {
      return JSON.stringify({
        error: "No QA run active. Use qa_run or qa_navigate first to start a session.",
      });
    }

    const check = await this.qaService.runCurrentPageCheck(checkType);
    if (!check) {
      return JSON.stringify({ error: `Check ${checkType} did not produce results` });
    }

    return JSON.stringify(
      {
        success: check.passed,
        check: {
          type: check.type,
          label: check.label,
          passed: check.passed,
          issueCount: check.issues.length,
          issues: check.issues.map((i) => ({
            severity: i.severity,
            title: i.title,
            description: i.description,
          })),
          screenshotPath: check.screenshotPath,
          durationMs: check.durationMs,
        },
      },
      null,
      2,
    );
  }

  private async handleQAReport(): Promise<string> {
    const run = this.qaService.getCurrentRun();
    if (!run) {
      return JSON.stringify({ error: "No QA run active. Use qa_run first." });
    }

    return JSON.stringify(
      {
        id: run.id,
        status: run.status,
        summary: run.summary,
        checksRun: run.checks.length,
        checksPassed: run.checks.filter((c) => c.passed).length,
        totalIssues: run.issues.length,
        criticalIssues: run.issues.filter((i) => i.severity === "critical").length,
        majorIssues: run.issues.filter((i) => i.severity === "major").length,
        minorIssues: run.issues.filter((i) => i.severity === "minor").length,
        issues: run.issues.map((i) => ({
          severity: i.severity,
          type: i.type,
          title: i.title,
          description: i.description,
          fixed: i.fixed,
          screenshotPath: i.screenshotPath,
        })),
        interactionSteps: run.interactionLog.length,
        durationMs: run.durationMs,
        finalScreenshot: run.finalScreenshotPath,
      },
      null,
      2,
    );
  }

  private async handleQACleanup(): Promise<string> {
    await this.qaService.cleanup();
    return JSON.stringify({ success: true, message: "QA browser and server cleaned up." });
  }
}
