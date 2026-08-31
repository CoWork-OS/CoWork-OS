/**
 * QA IPC Handlers
 *
 * IPC handlers for Playwright-based automated visual QA.
 * Bridges the renderer process with the PlaywrightQAService.
 */

import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { PlaywrightQAService } from "../agent/qa/playwright-qa-service";
import { QARun, QAEvent, QACheckType } from "../agent/qa/types";
import { AgentDaemon } from "../agent/daemon";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";
import { QAStartRunSchema, StringIdSchema } from "../utils/validation";

type Any = any;

function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    throw new Error("Rate limit exceeded. Please wait before starting another QA run.");
  }
}

// Active QA services keyed by taskId
const activeQAServices = new Map<string, PlaywrightQAService>();
// Completed runs for history
const completedRuns: QARun[] = [];
const MAX_COMPLETED_RUNS = 50;

/**
 * Setup QA IPC handlers
 */
export function setupQAHandlers(mainWindow: BrowserWindow, agentDaemon: AgentDaemon): void {
  rateLimiter.configure(IPC_CHANNELS.QA_START_RUN, RATE_LIMIT_CONFIGS.limited);
  // Get all QA runs (recent history)
  ipcMain.handle(IPC_CHANNELS.QA_GET_RUNS, async (): Promise<QARun[]> => {
    const activeRuns: QARun[] = [];
    for (const service of activeQAServices.values()) {
      const run = service.getCurrentRun();
      if (run) activeRuns.push(run);
    }
    return [...activeRuns, ...completedRuns].slice(0, MAX_COMPLETED_RUNS);
  });

  // Get a specific QA run by ID
  ipcMain.handle(IPC_CHANNELS.QA_GET_RUN, async (_, runId: string): Promise<QARun | null> => {
    // Check active services
    for (const service of activeQAServices.values()) {
      const run = service.getCurrentRun();
      if (run?.id === runId) return run;
    }
    // Check completed runs
    return completedRuns.find((r) => r.id === runId) || null;
  });

  // Start a new QA run
  ipcMain.handle(IPC_CHANNELS.QA_START_RUN, async (_, data: unknown): Promise<QARun> => {
    checkRateLimit(IPC_CHANNELS.QA_START_RUN);
    const validated = validateInput(QAStartRunSchema, data, "QA start run");
    const workspace = (agentDaemon as Any).getWorkspaceById?.(validated.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${validated.workspaceId} not found`);
    }

    // Clean up existing service for this task if any
    const existing = activeQAServices.get(validated.taskId);
    if (existing) {
      await existing.cleanup();
    }

    const service = new PlaywrightQAService(workspace);

    // Forward events to renderer
    service.onEvent((event: QAEvent) => {
      try {
        mainWindow.webContents.send(IPC_CHANNELS.QA_EVENT, event);
      } catch {
        // Window may be closed
      }
    });

    activeQAServices.set(validated.taskId, service);

    try {
      const runConfig = validated.config
        ? {
            ...validated.config,
            enabledChecks: validated.config.enabledChecks as QACheckType[] | undefined,
          }
        : {};
      const run = await service.run(validated.taskId, runConfig);
      // Move to completed
      completedRuns.unshift(run);
      if (completedRuns.length > MAX_COMPLETED_RUNS) {
        completedRuns.pop();
      }
      return run;
    } finally {
      await service.cleanup();
      activeQAServices.delete(validated.taskId);
    }
  });

  // Stop a QA run
  ipcMain.handle(
    IPC_CHANNELS.QA_STOP_RUN,
    async (_, taskId: unknown): Promise<{ success: boolean }> => {
      const validated = validateInput(StringIdSchema, taskId, "QA stop run task ID");
      const service = activeQAServices.get(validated);
      if (service) {
        await service.cleanup();
        activeQAServices.delete(validated);
        return { success: true };
      }
      return { success: false };
    },
  );
}
