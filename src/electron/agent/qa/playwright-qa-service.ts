/**
 * PlaywrightQAService — automated visual QA using Playwright.
 *
 * After code is built the agent can spin up the dev server, launch a
 * headless Chromium instance, navigate the app like a real user, take
 * screenshots, check for console/network errors, test interactions,
 * and report (or auto-fix) any issues it finds.
 */

import { v4 as uuid } from "uuid";
import { ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import * as net from "net";
import { BrowserService } from "../browser/browser-service";
import { Workspace } from "../../../shared/types";
import {
  resolveWorkspaceFilesystemAccessWithApproval,
  type WorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";
import { createSandbox, type ISandbox } from "../sandbox/sandbox-factory";
import {
  QARun,
  QARunConfig,
  QARunStatus,
  QACheck,
  QACheckType,
  QAIssue,
  QAInteractionStep,
  QAEvent,
  QASeverity,
  DEFAULT_QA_CONFIG,
} from "./types";

type Any = any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = now();
  while (now() - start < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, "127.0.0.1");
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function detectPortFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
  } catch {
    // ignore
  }
  return undefined;
}

function parseServerCommand(commandLine: string): { command: string; args: string[] } {
  const source = String(commandLine || "").trim();
  if (!source) throw new Error("QA server command cannot be empty");
  if (/[\u0000\r\n;&|`$<>()[\]{}]/.test(source)) {
    throw new Error("QA server command contains unsupported shell syntax");
  }

  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (const character of source) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) push();
    else token += character;
  }

  if (escaped || quote) throw new Error("QA server command has an incomplete quote or escape");
  push();
  if (!tokens[0]) throw new Error("QA server command cannot be empty");
  return { command: tokens[0], args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PlaywrightQAService {
  private browserService: BrowserService | null = null;
  private serverProcess: ChildProcess | null = null;
  private serverSandbox: ISandbox | null = null;
  private currentRun: QARun | null = null;
  private eventListeners: Array<(event: QAEvent) => void> = [];

  constructor(
    private workspace: Workspace,
    private screenshotDir?: string,
    private requestServerCommandApproval?: (command: string, cwd: string) => Promise<boolean>,
    private filesystemApprovalHandlers: WorkspaceFilesystemApprovalHandlers = {},
  ) {}

  // -----------------------------------------------------------------------
  // Event system
  // -----------------------------------------------------------------------

  onEvent(listener: (event: QAEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private emit(type: QAEvent["type"], data: QAEvent["data"]): void {
    if (!this.currentRun) return;
    const event: QAEvent = {
      type,
      runId: this.currentRun.id,
      taskId: this.currentRun.taskId,
      data,
      timestamp: now(),
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // best-effort
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  getCurrentRun(): QARun | null {
    return this.currentRun;
  }

  /**
   * Run a specific QA check against the current browser/page state without
   * restarting the session. This preserves navigation and interactive state.
   */
  async runCurrentPageCheck(checkType: QACheckType): Promise<QACheck | null> {
    if (!this.currentRun || !this.browserService) {
      return null;
    }

    const run = this.currentRun;
    const screenshotBase = await this.resolvePathWithApproval(
      this.screenshotDir || path.join(this.workspace.path, ".cowork", "qa-screenshots"),
      "write",
      "QA screenshot directory",
    );

    switch (checkType) {
      case "console_errors":
        await this.runConsoleErrorCheck(run, screenshotBase);
        break;
      case "network_errors":
        await this.runNetworkErrorCheck(run, screenshotBase);
        break;
      case "visual_snapshot":
        await this.runVisualSnapshotCheck(run, screenshotBase);
        break;
      case "interaction_test":
        await this.runInteractionCheck(run, run.config, screenshotBase);
        break;
      case "responsive_check":
        await this.runResponsiveCheck(run, run.config, screenshotBase);
        break;
      case "accessibility_check":
        await this.runAccessibilityCheck(run, screenshotBase);
        break;
      case "performance_check":
        await this.runPerformanceCheck(run, screenshotBase);
        break;
      default:
        return null;
    }

    return run.checks.at(-1) || null;
  }

  /**
   * Start a full QA run.
   *
   * 1. Start dev server (optional)
   * 2. Launch Playwright browser
   * 3. Navigate to the target URL
   * 4. Run enabled checks (visual, console, network, interaction, responsive)
   * 5. Collect issues
   * 6. Return the QARun result
   */
  async run(taskId: string, config: Partial<QARunConfig>): Promise<QARun> {
    const mergedConfig: QARunConfig = {
      ...DEFAULT_QA_CONFIG,
      ...config,
      targetUrl: config.targetUrl || "http://localhost:3000",
      viewports: config.viewports ?? DEFAULT_QA_CONFIG.viewports ?? [],
      enabledChecks: config.enabledChecks ?? DEFAULT_QA_CONFIG.enabledChecks ?? [],
    };

    const run: QARun = {
      id: uuid(),
      taskId,
      status: "idle",
      config: mergedConfig,
      checks: [],
      interactionLog: [],
      issues: [],
      fixAttempts: 0,
      durationMs: 0,
      startedAt: now(),
    };

    this.currentRun = run;
    const screenshotBase = await this.resolvePathWithApproval(
      this.screenshotDir || path.join(this.workspace.path, ".cowork", "qa-screenshots"),
      "write",
      "QA screenshot directory",
    );
    await fs.mkdir(screenshotBase, { recursive: true });

    try {
      // Step 1: Start dev server if configured
      if (mergedConfig.serverCommand) {
        await this.updateStatus("starting_server");
        await this.startServer(mergedConfig);
      }

      // Step 2: Launch browser
      await this.updateStatus("launching_browser");
      this.browserService = new BrowserService(this.workspace, {
        headless: mergedConfig.headless ?? true,
        timeout: mergedConfig.timeout ?? 120_000,
        viewport: mergedConfig.viewports?.[0]
          ? { width: mergedConfig.viewports[0].width, height: mergedConfig.viewports[0].height }
          : { width: 1280, height: 720 },
      });

      // Step 3: Navigate
      // Use "load" instead of "networkidle" — dev servers (Vite/CRA) keep a
      // persistent WebSocket open for HMR, so networkidle never resolves.
      await this.updateStatus("navigating");
      const navResult = await this.browserService.navigate(mergedConfig.targetUrl, "load");

      const navStep: QAInteractionStep = {
        action: "navigate",
        url: mergedConfig.targetUrl,
        description: `Navigated to ${mergedConfig.targetUrl}`,
        success: !navResult.isError,
        error: navResult.isError ? `HTTP ${navResult.status}` : undefined,
        durationMs: 0,
      };
      run.interactionLog.push(navStep);
      this.emit("qa:step", { step: navStep });

      if (navResult.isError) {
        run.issues.push(
          this.createIssue({
            type: "network_errors",
            severity: "critical",
            title: `Navigation failed with HTTP ${navResult.status}`,
            description: `The target URL ${mergedConfig.targetUrl} returned status ${navResult.status}`,
            url: mergedConfig.targetUrl,
          }),
        );
      }

      // Take initial screenshot
      const initialScreenshot = await this.takeScreenshot(screenshotBase, "initial");
      navStep.screenshotPath = initialScreenshot;
      this.emit("qa:screenshot", { screenshotPath: initialScreenshot });

      // Step 4: Run checks
      await this.updateStatus("testing");
      const enabledChecks = mergedConfig.enabledChecks || [];

      if (enabledChecks.includes("console_errors")) {
        await this.runConsoleErrorCheck(run, screenshotBase);
      }

      if (enabledChecks.includes("network_errors")) {
        await this.runNetworkErrorCheck(run, screenshotBase);
      }

      if (enabledChecks.includes("visual_snapshot")) {
        await this.runVisualSnapshotCheck(run, screenshotBase);
      }

      if (enabledChecks.includes("interaction_test")) {
        await this.runInteractionCheck(run, mergedConfig, screenshotBase);
      }

      if (enabledChecks.includes("responsive_check")) {
        await this.runResponsiveCheck(run, mergedConfig, screenshotBase);
      }

      if (enabledChecks.includes("accessibility_check")) {
        await this.runAccessibilityCheck(run, screenshotBase);
      }

      if (enabledChecks.includes("performance_check")) {
        await this.runPerformanceCheck(run, screenshotBase);
      }

      // Take final screenshot
      const finalScreenshot = await this.takeScreenshot(screenshotBase, "final");
      run.finalScreenshotPath = finalScreenshot;

      // Step 5: Analyze results
      await this.updateStatus("analyzing");
      run.summary = this.generateSummary(run);

      // Done
      await this.updateStatus("completed");
      run.completedAt = now();
      run.durationMs = run.completedAt - run.startedAt;

      this.emit("qa:complete", { ...run });
      return run;
    } catch (error) {
      await this.updateStatus("failed");
      run.completedAt = now();
      run.durationMs = run.completedAt - run.startedAt;
      run.summary = `QA run failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.cleanup();
      return run;
    }
  }

  /**
   * Run a single interaction step (for the agent to call step-by-step).
   */
  async executeStep(step: QAInteractionStep): Promise<QAInteractionStep> {
    if (!this.browserService) {
      step.success = false;
      step.error = "Browser not initialized. Call run() first.";
      return step;
    }

    const start = now();
    try {
      switch (step.action) {
        case "navigate":
          if (step.url) {
            await this.browserService.navigate(step.url, "load");
          }
          step.success = true;
          break;

        case "click":
          if (step.selector) {
            const result = await this.browserService.click(step.selector);
            step.success = result.success;
            step.error = result.error;
          }
          break;

        case "fill":
          if (step.selector && step.value !== undefined) {
            const result = await this.browserService.fill(step.selector, step.value);
            step.success = result.success;
            step.error = result.error;
          }
          break;

        case "hover":
          if (step.selector) {
            await this.browserService.evaluate(`
              const el = document.querySelector(${JSON.stringify(step.selector)});
              if (el) {
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              }
            `);
            step.success = true;
          }
          break;

        case "scroll":
          await this.browserService.evaluate(`window.scrollBy(0, ${step.value || "500"})`);
          step.success = true;
          break;

        case "wait":
          await new Promise((r) => setTimeout(r, Number(step.value) || 1000));
          step.success = true;
          break;

        case "screenshot": {
          const dir =
            this.screenshotDir || path.join(this.workspace.path, ".cowork", "qa-screenshots");
          const screenshotPath = await this.takeScreenshot(dir, step.value || "step");
          step.screenshotPath = screenshotPath;
          step.success = true;
          break;
        }

        case "assert":
          if (step.selector) {
            const result = await this.browserService.evaluate(
              `!!document.querySelector(${JSON.stringify(step.selector)})`,
            );
            step.success = result.success && result.result === true;
            if (!step.success) {
              step.error = `Assertion failed: element "${step.selector}" not found`;
            }
          }
          break;
      }
    } catch (error) {
      step.success = false;
      step.error = error instanceof Error ? error.message : String(error);
    }

    step.durationMs = now() - start;

    if (this.currentRun) {
      this.currentRun.interactionLog.push(step);
      this.emit("qa:step", { step });
    }

    return step;
  }

  /**
   * Get console errors from the current page.
   */
  async getConsoleErrors(): Promise<string[]> {
    if (!this.browserService) return [];
    try {
      const result = await this.browserService.evaluate(`
        (() => {
          if (!window.__qaConsoleErrors) return [];
          return window.__qaConsoleErrors.slice(-50);
        })()
      `);
      return Array.isArray(result.result) ? result.result : [];
    } catch {
      return [];
    }
  }

  /**
   * Get a structured report of the current page state.
   */
  async getPageReport(): Promise<{
    url: string;
    title: string;
    bodyText: string;
    consoleErrors: string[];
    elementCount: number;
    brokenImages: string[];
    emptyLinks: string[];
  }> {
    if (!this.browserService) {
      throw new Error("Browser not initialized");
    }

    const content = await this.browserService.getContent();
    const diagnostics = await this.browserService.evaluate(`
      (() => {
        const errors = window.__qaConsoleErrors || [];
        const images = Array.from(document.querySelectorAll('img'));
        const brokenImages = images
          .filter(img => !img.complete || img.naturalWidth === 0)
          .map(img => img.src || img.getAttribute('data-src') || '[no src]')
          .slice(0, 20);
        const links = Array.from(document.querySelectorAll('a'));
        const emptyLinks = links
          .filter(a => !a.href || a.href === '#' || a.href === 'javascript:void(0)')
          .map(a => a.textContent?.trim() || '[no text]')
          .slice(0, 20);
        return {
          consoleErrors: errors.slice(-20),
          elementCount: document.querySelectorAll('*').length,
          brokenImages,
          emptyLinks,
        };
      })()
    `);

    const diag = diagnostics.success ? diagnostics.result : {};

    return {
      url: content.url,
      title: content.title,
      bodyText: content.text.slice(0, 5000),
      consoleErrors: (diag as Any)?.consoleErrors || [],
      elementCount: (diag as Any)?.elementCount || 0,
      brokenImages: (diag as Any)?.brokenImages || [],
      emptyLinks: (diag as Any)?.emptyLinks || [],
    };
  }

  /**
   * Clean up resources.
   */
  async cleanup(): Promise<void> {
    try {
      if (this.browserService) {
        await this.browserService.close();
        this.browserService = null;
      }
      if (this.serverProcess && !this.serverProcess.killed) {
        this.serverProcess.kill("SIGTERM");
      }
      this.serverProcess = null;
      this.serverSandbox?.cleanup();
      this.serverSandbox = null;
    } finally {
      this.currentRun = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private: Server management
  // -----------------------------------------------------------------------

  private async startServer(config: QARunConfig): Promise<void> {
    if (!config.serverCommand) return;

    const cwd = await this.resolvePathWithApproval(
      config.serverCwd || this.workspace.path,
      "read",
      "QA server working directory",
    );
    const cwdStats = await fs.stat(cwd).catch(() => null);
    if (!cwdStats?.isDirectory()) {
      throw new Error(`QA server working directory is not a directory: ${cwd}`);
    }
    const port = config.serverPort || detectPortFromUrl(config.targetUrl) || 3000;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid QA server port: ${port}`);
    }
    const timeout = Math.min(Math.max(config.serverStartupTimeout || 30_000, 1_000), 5 * 60_000);

    if (this.workspace.permissions.shell !== true) {
      throw new Error("QA server commands require the workspace shell capability");
    }
    if (!this.requestServerCommandApproval) {
      throw new Error("QA server commands require an approval context");
    }
    const approved = await this.requestServerCommandApproval(config.serverCommand, cwd);
    if (!approved) throw new Error("QA server command approval denied");

    // Check if port is already in use (server may already be running)
    const alreadyUp = await waitForPort(port, 1000);
    if (alreadyUp) {
      this.emit("qa:status", { status: "starting_server" as QARunStatus });
      return;
    }

    // Spawn server process
    const { command, args } = parseServerCommand(config.serverCommand);
    const requestedSandboxType = this.workspace.permissions.sandboxType || "auto";
    this.serverSandbox = await createSandbox(this.workspace, requestedSandboxType);
    const restrictedProfile = this.workspace.permissions.accessSandboxMode !== "danger-full-access";
    if (restrictedProfile && this.serverSandbox.type === "none") {
      this.serverSandbox.cleanup();
      this.serverSandbox = null;
      throw new Error(
        "QA server commands require an OS-level sandbox for the active access profile",
      );
    }

    const sandboxProcess = this.serverSandbox.spawnProcess?.(command, args, {
      cwd,
      // The process sandbox only has a binary network switch; it cannot
      // enforce the profile's domain allow/deny language. Fail closed for a
      // scoped domain profile so a dev server cannot use the QA helper as an
      // unrestricted network tunnel. Browser navigation still applies the
      // domain policy at the page/request layer.
      allowNetwork:
        this.workspace.permissions.network === true &&
        this.workspace.permissions.accessNetworkMode !== "disabled" &&
        this.workspace.permissions.accessNetworkMode !== "on-request" &&
        (this.workspace.permissions.accessDomainRules?.length || 0) === 0,
      envPassthrough: ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"],
    });
    if (!sandboxProcess) {
      this.serverSandbox.cleanup();
      this.serverSandbox = null;
      throw new Error("The selected QA sandbox cannot start a long-running server process");
    }
    this.serverProcess = sandboxProcess.process;
    this.serverProcess.once("close", () => {
      sandboxProcess.cleanup();
    });
    this.serverProcess.once("error", () => {
      sandboxProcess.cleanup();
    });

    // Wait for port to be ready
    const ready = await waitForPort(port, timeout);
    if (!ready) {
      throw new Error(
        `Dev server did not start on port ${port} within ${timeout}ms. ` +
          `Command: ${config.serverCommand}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: Check implementations
  // -----------------------------------------------------------------------

  private async runConsoleErrorCheck(run: QARun, screenshotDir: string): Promise<void> {
    const start = now();

    // Inject console error collector and evaluate
    await this.browserService!.evaluate(`
      (() => {
        if (window.__qaConsoleErrors) return;
        window.__qaConsoleErrors = [];
        const origError = console.error;
        const origWarn = console.warn;
        console.error = function(...args) {
          window.__qaConsoleErrors.push('[ERROR] ' + args.map(a => String(a)).join(' '));
          origError.apply(console, args);
        };
        console.warn = function(...args) {
          window.__qaConsoleErrors.push('[WARN] ' + args.map(a => String(a)).join(' '));
          origWarn.apply(console, args);
        };
        window.addEventListener('error', (e) => {
          window.__qaConsoleErrors.push('[UNCAUGHT] ' + (e.message || String(e)));
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__qaConsoleErrors.push('[UNHANDLED_REJECTION] ' + String(e.reason));
        });
      })()
    `);

    // Wait a moment for any async errors to fire
    await new Promise((r) => setTimeout(r, 2000));

    const errorsResult = await this.browserService!.evaluate(`
      (() => window.__qaConsoleErrors || [])()
    `);
    const errors: string[] = Array.isArray(errorsResult.result) ? errorsResult.result : [];

    const issues: QAIssue[] = [];
    for (const msg of errors) {
      const severity: QASeverity =
        msg.startsWith("[ERROR]") || msg.startsWith("[UNCAUGHT]") ? "major" : "minor";
      issues.push(
        this.createIssue({
          type: "console_errors",
          severity,
          title: msg.slice(0, 120),
          description: msg,
          url: this.browserService!.getUrl?.() || run.config.targetUrl,
          consoleMessage: msg,
        }),
      );
    }

    const check: QACheck = {
      type: "console_errors",
      label: "Console Errors",
      description: "Check for JavaScript errors and warnings in the browser console",
      passed: issues.filter((i) => i.severity !== "minor").length === 0,
      issues,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runNetworkErrorCheck(run: QARun, screenshotDir: string): Promise<void> {
    const start = now();

    const networkResult = await this.browserService!.evaluate(`
      (() => {
        if (!window.performance) return [];
        const entries = performance.getEntriesByType('resource');
        return entries
          .filter(e => e.responseStatus && e.responseStatus >= 400)
          .map(e => ({
            url: e.name,
            status: e.responseStatus,
            type: e.initiatorType,
            duration: Math.round(e.duration),
          }))
          .slice(0, 50);
      })()
    `);

    const failedRequests = Array.isArray(networkResult.result) ? networkResult.result : [];
    const issues: QAIssue[] = [];

    for (const req of failedRequests) {
      issues.push(
        this.createIssue({
          type: "network_errors",
          severity: (req as Any).status >= 500 ? "major" : "minor",
          title: `HTTP ${(req as Any).status} — ${(req as Any).url?.split("/").pop() || (req as Any).url}`,
          description: `Failed request: ${(req as Any).url} (${(req as Any).status})`,
          url: run.config.targetUrl,
          networkDetails: {
            url: (req as Any).url,
            status: (req as Any).status,
            method: "GET",
          },
        }),
      );
    }

    const check: QACheck = {
      type: "network_errors",
      label: "Network Errors",
      description: "Check for failed HTTP requests (4xx/5xx)",
      passed: issues.length === 0,
      issues,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runVisualSnapshotCheck(run: QARun, screenshotDir: string): Promise<void> {
    const start = now();

    // Take a full-page screenshot
    const screenshotPath = await this.takeScreenshot(screenshotDir, "visual-snapshot", true);

    // Check for common visual issues
    const visualResult = await this.browserService!.evaluate(`
      (() => {
        const issues = [];

        // Check for overflow
        const docWidth = document.documentElement.scrollWidth;
        const viewWidth = window.innerWidth;
        if (docWidth > viewWidth + 20) {
          issues.push({ type: 'horizontal_overflow', detail: 'Page has horizontal overflow (' + docWidth + 'px > ' + viewWidth + 'px)' });
        }

        // Check for elements with zero dimensions that should be visible
        const visible = document.querySelectorAll('[data-testid], button, a, img, input, select, textarea');
        for (const el of visible) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width === 0 && rect.height === 0) {
            const id = el.id || el.className?.toString().slice(0, 40) || el.tagName;
            issues.push({ type: 'zero_size', detail: 'Element has zero dimensions: ' + id });
          }
        }

        // Check for broken images
        const images = document.querySelectorAll('img');
        for (const img of images) {
          if (!img.complete || img.naturalWidth === 0) {
            issues.push({ type: 'broken_image', detail: 'Broken image: ' + (img.src || img.getAttribute('data-src') || '[no src]') });
          }
        }

        // Check for text truncation (ellipsis)
        const all = document.querySelectorAll('*');
        let truncated = 0;
        for (const el of all) {
          const style = window.getComputedStyle(el);
          if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) {
            truncated++;
          }
        }
        if (truncated > 5) {
          issues.push({ type: 'excessive_truncation', detail: truncated + ' elements have truncated text' });
        }

        // Check for empty containers that might indicate loading failures
        const containers = document.querySelectorAll('main, [role="main"], .container, .content, #app, #root');
        for (const c of containers) {
          if (c.children.length === 0 && !c.textContent?.trim()) {
            issues.push({ type: 'empty_container', detail: 'Empty main container: ' + (c.id || c.className?.toString().slice(0, 40) || c.tagName) });
          }
        }

        return issues.slice(0, 30);
      })()
    `);

    const visualIssues = Array.isArray(visualResult.result) ? visualResult.result : [];
    const issues: QAIssue[] = [];

    for (const vi of visualIssues) {
      const severityMap: Record<string, QASeverity> = {
        horizontal_overflow: "major",
        zero_size: "minor",
        broken_image: "major",
        excessive_truncation: "minor",
        empty_container: "critical",
      };
      issues.push(
        this.createIssue({
          type: "visual_snapshot",
          severity: severityMap[(vi as Any).type] || "minor",
          title: (vi as Any).detail?.slice(0, 120) || "Visual issue",
          description: (vi as Any).detail || "",
          url: run.config.targetUrl,
          screenshotPath,
        }),
      );
    }

    const check: QACheck = {
      type: "visual_snapshot",
      label: "Visual Snapshot",
      description: "Full-page screenshot and visual issue detection",
      passed:
        issues.filter((i) => i.severity === "critical" || i.severity === "major").length === 0,
      issues,
      screenshotPath,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runInteractionCheck(
    run: QARun,
    config: QARunConfig,
    screenshotDir: string,
  ): Promise<void> {
    const start = now();
    const issues: QAIssue[] = [];

    // Auto-discover interactive elements
    const interactiveResult = await this.browserService!.evaluate(`
      (() => {
        const elements = [];

        // Buttons
        document.querySelectorAll('button:not([disabled])').forEach((el, i) => {
          if (i < 5) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                type: 'button',
                selector: el.id ? '#' + el.id : 'button:nth-of-type(' + (i + 1) + ')',
                text: el.textContent?.trim().slice(0, 50) || '[no text]',
              });
            }
          }
        });

        // Links
        document.querySelectorAll('a[href]:not([href="#"]):not([href="javascript:void(0)"])').forEach((el, i) => {
          if (i < 5) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                type: 'link',
                selector: el.id ? '#' + el.id : 'a:nth-of-type(' + (i + 1) + ')',
                text: el.textContent?.trim().slice(0, 50) || '[no text]',
                href: el.getAttribute('href'),
              });
            }
          }
        });

        // Input fields
        document.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])').forEach((el, i) => {
          if (i < 5) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                type: 'input',
                selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')'),
                inputType: el.getAttribute('type') || el.tagName.toLowerCase(),
                placeholder: el.getAttribute('placeholder') || '',
              });
            }
          }
        });

        return elements.slice(0, 15);
      })()
    `);

    const interactiveElements = Array.isArray(interactiveResult.result)
      ? interactiveResult.result
      : [];

    // Test clicking buttons
    for (const el of interactiveElements) {
      if ((el as Any).type === "button") {
        try {
          const clickResult = await this.browserService!.click((el as Any).selector, 5000);
          const step: QAInteractionStep = {
            action: "click",
            selector: (el as Any).selector,
            description: `Clicked button "${(el as Any).text}"`,
            success: clickResult.success,
            error: clickResult.error,
            durationMs: 0,
          };
          run.interactionLog.push(step);
          this.emit("qa:step", { step });

          if (!clickResult.success) {
            issues.push(
              this.createIssue({
                type: "interaction_test",
                severity: "minor",
                title: `Button not clickable: "${(el as Any).text}"`,
                description: `Failed to click button with selector "${(el as Any).selector}": ${clickResult.error}`,
                url: run.config.targetUrl,
                element: (el as Any).selector,
              }),
            );
          }

          // Brief pause between interactions
          await new Promise((r) => setTimeout(r, 500));
        } catch {
          // Interaction checks are best-effort
        }
      }
    }

    // Run custom interaction steps if provided
    if (config.interactionSteps) {
      for (const step of config.interactionSteps) {
        const result = await this.executeStep({ ...step });
        if (!result.success) {
          issues.push(
            this.createIssue({
              type: "interaction_test",
              severity: "major",
              title: `Interaction failed: ${step.description}`,
              description: `Step "${step.action}" on "${step.selector || step.url}" failed: ${result.error}`,
              url: run.config.targetUrl,
              element: step.selector,
            }),
          );
        }
      }
    }

    // Check for errors that appeared during interactions
    const postInteractionErrors = await this.getConsoleErrors();
    const newErrors = postInteractionErrors.filter(
      (e) => !run.issues.some((i) => i.consoleMessage === e),
    );
    for (const err of newErrors) {
      if (err.startsWith("[ERROR]") || err.startsWith("[UNCAUGHT]")) {
        issues.push(
          this.createIssue({
            type: "interaction_test",
            severity: "major",
            title: `Error during interaction: ${err.slice(0, 100)}`,
            description: err,
            url: run.config.targetUrl,
            consoleMessage: err,
          }),
        );
      }
    }

    const screenshotPath = await this.takeScreenshot(screenshotDir, "post-interaction");

    const check: QACheck = {
      type: "interaction_test",
      label: "Interaction Tests",
      description: "Test interactive elements (buttons, links, inputs)",
      passed:
        issues.filter((i) => i.severity === "critical" || i.severity === "major").length === 0,
      issues,
      screenshotPath,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runResponsiveCheck(
    run: QARun,
    config: QARunConfig,
    screenshotDir: string,
  ): Promise<void> {
    const start = now();
    const issues: QAIssue[] = [];
    const viewports = config.viewports || [];

    for (const vp of viewports) {
      try {
        // Resize viewport
        await this.browserService!.evaluate(`
          (() => {
            window.__qaViewport = { width: ${vp.width}, height: ${vp.height} };
          })()
        `);

        // We need to create a new page context or resize - use evaluate to check overflow
        const overflowResult = await this.browserService!.evaluate(`
          (() => {
            const docWidth = document.documentElement.scrollWidth;
            const overflow = docWidth > ${vp.width} + 20;
            return { overflow, docWidth, viewportWidth: ${vp.width} };
          })()
        `);

        const screenshotPath = await this.takeScreenshot(
          screenshotDir,
          `responsive-${vp.label.toLowerCase()}`,
        );

        if (overflowResult.success && (overflowResult.result as Any)?.overflow) {
          issues.push(
            this.createIssue({
              type: "responsive_check",
              severity: "major",
              title: `Horizontal overflow at ${vp.label} (${vp.width}x${vp.height})`,
              description: `Content width ${(overflowResult.result as Any).docWidth}px exceeds viewport ${vp.width}px`,
              url: run.config.targetUrl,
              screenshotPath,
            }),
          );
        }
      } catch {
        // Best-effort responsive checks
      }
    }

    const check: QACheck = {
      type: "responsive_check",
      label: "Responsive Design",
      description: "Test layout at different viewport sizes",
      passed: issues.length === 0,
      issues,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runAccessibilityCheck(run: QARun, screenshotDir: string): Promise<void> {
    const start = now();

    const a11yResult = await this.browserService!.evaluate(`
      (() => {
        const issues = [];

        // Images without alt text
        document.querySelectorAll('img:not([alt])').forEach((img, i) => {
          if (i < 10) {
            issues.push({ type: 'missing_alt', detail: 'Image missing alt text: ' + (img.src || '[no src]').slice(0, 100) });
          }
        });

        // Form inputs without labels
        document.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach((input) => {
          const id = input.id;
          const hasLabel = id && document.querySelector('label[for="' + id + '"]');
          const hasAriaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
          const parentLabel = input.closest('label');
          if (!hasLabel && !hasAriaLabel && !parentLabel) {
            issues.push({ type: 'missing_label', detail: 'Input missing label: ' + (input.name || input.type || input.tagName) });
          }
        });

        // Buttons without accessible text
        document.querySelectorAll('button').forEach((btn) => {
          const text = btn.textContent?.trim();
          const ariaLabel = btn.getAttribute('aria-label');
          const title = btn.getAttribute('title');
          if (!text && !ariaLabel && !title) {
            issues.push({ type: 'empty_button', detail: 'Button without accessible text' });
          }
        });

        // Low contrast check (basic)
        const body = document.body;
        const bodyStyle = window.getComputedStyle(body);
        const bgColor = bodyStyle.backgroundColor;
        const textColor = bodyStyle.color;
        if (bgColor === textColor) {
          issues.push({ type: 'no_contrast', detail: 'Body text color matches background color' });
        }

        // Missing lang attribute
        if (!document.documentElement.getAttribute('lang')) {
          issues.push({ type: 'missing_lang', detail: 'HTML element missing lang attribute' });
        }

        // Missing page title
        if (!document.title || !document.title.trim()) {
          issues.push({ type: 'missing_title', detail: 'Page has no title' });
        }

        return issues.slice(0, 30);
      })()
    `);

    const a11yIssues = Array.isArray(a11yResult.result) ? a11yResult.result : [];
    const issues: QAIssue[] = a11yIssues.map((ai) =>
      this.createIssue({
        type: "accessibility_check",
        severity: "minor",
        title: (ai as Any).detail?.slice(0, 120) || "Accessibility issue",
        description: (ai as Any).detail || "",
        url: run.config.targetUrl,
      }),
    );

    const check: QACheck = {
      type: "accessibility_check",
      label: "Accessibility",
      description: "Basic accessibility checks (alt text, labels, contrast)",
      passed: issues.length === 0,
      issues,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  private async runPerformanceCheck(run: QARun, screenshotDir: string): Promise<void> {
    const start = now();

    const perfResult = await this.browserService!.evaluate(`
      (() => {
        const issues = [];
        const nav = performance.getEntriesByType('navigation')[0];

        if (nav) {
          const loadTime = nav.loadEventEnd - nav.startTime;
          if (loadTime > 5000) {
            issues.push({ type: 'slow_load', detail: 'Page load time: ' + Math.round(loadTime) + 'ms (>5s)', value: loadTime });
          }

          const ttfb = nav.responseStart - nav.requestStart;
          if (ttfb > 2000) {
            issues.push({ type: 'slow_ttfb', detail: 'Time to first byte: ' + Math.round(ttfb) + 'ms (>2s)', value: ttfb });
          }
        }

        // Check for large DOM
        const elementCount = document.querySelectorAll('*').length;
        if (elementCount > 3000) {
          issues.push({ type: 'large_dom', detail: 'DOM has ' + elementCount + ' elements (>3000)', value: elementCount });
        }

        // Check for large resources
        const resources = performance.getEntriesByType('resource');
        const largeResources = resources.filter(r => r.transferSize > 1024 * 1024);
        for (const r of largeResources.slice(0, 5)) {
          issues.push({ type: 'large_resource', detail: 'Large resource: ' + r.name.split('/').pop() + ' (' + Math.round(r.transferSize / 1024) + 'KB)', value: r.transferSize });
        }

        return issues;
      })()
    `);

    const perfIssues = Array.isArray(perfResult.result) ? perfResult.result : [];
    const issues: QAIssue[] = perfIssues.map((pi) =>
      this.createIssue({
        type: "performance_check",
        severity: (pi as Any).type === "slow_load" ? "major" : "minor",
        title: (pi as Any).detail?.slice(0, 120) || "Performance issue",
        description: (pi as Any).detail || "",
        url: run.config.targetUrl,
      }),
    );

    const check: QACheck = {
      type: "performance_check",
      label: "Performance",
      description: "Check page load time, DOM size, resource sizes",
      passed:
        issues.filter((i) => i.severity === "major" || i.severity === "critical").length === 0,
      issues,
      durationMs: now() - start,
    };

    run.checks.push(check);
    run.issues.push(...issues);
    this.emit("qa:check", { check });
  }

  // -----------------------------------------------------------------------
  // Private: Utilities
  // -----------------------------------------------------------------------

  private async updateStatus(status: QARunStatus): Promise<void> {
    if (this.currentRun) {
      this.currentRun.status = status;
      this.emit("qa:status", { status });
    }
  }

  private async resolvePathWithApproval(
    rawPath: string,
    operation: "read" | "write" | "delete",
    label: string,
  ): Promise<string> {
    const access = await resolveWorkspaceFilesystemAccessWithApproval(
      this.workspace,
      rawPath,
      operation,
      label,
      this.filesystemApprovalHandlers,
    );
    if (access.decision !== "allow") {
      throw new Error(`Access denied for ${label} "${rawPath}": ${access.reason}`);
    }
    return access.path;
  }

  private async takeScreenshot(dir: string, label: string, fullPage = false): Promise<string> {
    if (!this.browserService) return "";
    try {
      const safeDir = await this.resolvePathWithApproval(dir, "write", "QA screenshot directory");
      await fs.mkdir(safeDir, { recursive: true });
      const safeLabel =
        String(label || "step")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "step";
      const filename = `qa-${safeLabel}-${Date.now()}.png`;
      const result = await this.browserService.screenshot(path.join(safeDir, filename), fullPage);
      return result.path;
    } catch {
      return "";
    }
  }

  private createIssue(params: {
    type: QACheckType;
    severity: QASeverity;
    title: string;
    description: string;
    url: string;
    screenshotPath?: string;
    element?: string;
    consoleMessage?: string;
    networkDetails?: { url: string; status: number; method: string };
  }): QAIssue {
    return {
      id: uuid(),
      ...params,
      fixed: false,
      timestamp: now(),
    };
  }

  private generateSummary(run: QARun): string {
    const total = run.issues.length;
    const critical = run.issues.filter((i) => i.severity === "critical").length;
    const major = run.issues.filter((i) => i.severity === "major").length;
    const minor = run.issues.filter((i) => i.severity === "minor").length;
    const passed = run.checks.filter((c) => c.passed).length;
    const failed = run.checks.filter((c) => !c.passed).length;

    if (total === 0) {
      return `All ${run.checks.length} QA checks passed. No issues found.`;
    }

    const parts = [];
    if (critical > 0) parts.push(`${critical} critical`);
    if (major > 0) parts.push(`${major} major`);
    if (minor > 0) parts.push(`${minor} minor`);

    return (
      `${passed}/${run.checks.length} checks passed. ` +
      `Found ${total} issue${total === 1 ? "" : "s"}: ${parts.join(", ")}. ` +
      `Duration: ${Math.round(run.durationMs / 1000)}s.`
    );
  }

  hasBlockingIssues(run: QARun): boolean {
    return run.issues.some((issue) => issue.severity === "critical" || issue.severity === "major");
  }
}
