/**
 * TrayManager - macOS Menu Bar App Integration
 *
 * Provides a native menu bar icon with:
 * - Status indicator (connected/disconnected channels)
 * - Quick actions menu (new task, workspaces, settings)
 * - Show/hide main window on click
 * - Gateway status monitoring
 *
 * Settings are stored encrypted in the database using SecureSettingsRepository.
 */

import { TaskRepository, WorkspaceRepository } from "../database/repository-facades";
import { toPlainAnswerText } from "../../shared/answer-surfaces/blocks";
import {
  app,
  Tray,
  Menu,
  BrowserWindow,
  shell as _shell,
  NativeImage,
  globalShortcut,
} from "electron";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { ChannelGateway } from "../gateway";
import { DatabaseManager } from "../database/schema";
import { type Channel } from "../database/repositories";
import { AgentDaemon } from "../agent/daemon";
import { QuickInputWindow } from "./QuickInputWindow";
import { getUpdatePrompt } from "../updater";
import {
  TEMP_WORKSPACE_NAME,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  IPC_CHANNELS,
  Workspace,
  isTempWorkspaceId,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";
import {
  createUniqueScopedTempWorkspaceDirectorySync,
  ensureTempWorkspaceDirectoryPathSync,
  pruneTempWorkspaces,
} from "../utils/temp-workspace";
import { isTempWorkspaceInScope } from "../utils/temp-workspace-scope";
import {
  getActiveTempWorkspaceLeases,
  touchTempWorkspaceLease,
} from "../utils/temp-workspace-lease";
import {
  ChronicleCaptureService,
  ChronicleMemoryService,
  ChronicleSettingsManager,
} from "../chronicle";
import { showDesktopNotification } from "../notifications/desktop-delivery";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { taskAgentConfigForCreation } from "../../shared/security/task-entrypoint";
import { USER_TYPED_TASK_PROMPT } from "../agent/task-prompt-provenance";
import { getTrayIconImage } from "../branding";

const trayLogger = createLogger("TrayManager");
const LEGACY_SETTINGS_FILE = "tray-settings.json";

/**
 * Escape text before interpolating it into the quick-input window's HTML.
 *
 * QuickInputWindow.updateResponse assigns its argument to innerHTML inside a
 * `data:text/html` document that has no CSP and no preload, so inline handlers
 * in that markup execute. Anything derived from agent output — plan step
 * descriptions in progress events, tool error text — must come through here.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface TrayManagerOptions {
  showDockIcon?: boolean;
  startMinimized?: boolean;
  closeToTray?: boolean;
}

export interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
  showApprovalSavedNotifications: boolean;
}

const DEFAULT_SETTINGS: TraySettings = {
  enabled: false,
  showDockIcon: true,
  startMinimized: false,
  closeToTray: true,
  showNotifications: true,
  showApprovalSavedNotifications: false,
};

/**
 * Coerce persisted tray settings to valid booleans. Missing or invalid values
 * (e.g. `null` from corrupted JSON) fall back to defaults, so a corrupted
 * `enabled` leaves the menu bar / system tray icon at its default (off).
 */
/**
 * Marks tray settings saved since the menu bar icon became opt-in. Settings
 * stored before that carry `enabled: true` from the old default, not from a
 * choice, so they load with the icon off until it is turned on again.
 */
const TRAY_ICON_OPT_IN_VERSION = 1;

type StoredTraySettings = Partial<TraySettings> & { iconOptInVersion?: number };

export function traySettingsFromStorage(stored: StoredTraySettings | null): TraySettings {
  const settings = normalizeTraySettings(stored);
  if (stored?.iconOptInVersion !== TRAY_ICON_OPT_IN_VERSION) {
    settings.enabled = DEFAULT_SETTINGS.enabled;
  }
  return settings;
}

export function traySettingsForStorage(settings: TraySettings): StoredTraySettings {
  return { ...settings, iconOptInVersion: TRAY_ICON_OPT_IN_VERSION };
}

export function normalizeTraySettings(raw: Partial<TraySettings> | null | undefined): TraySettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  return {
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : DEFAULT_SETTINGS.enabled,
    showDockIcon:
      typeof merged.showDockIcon === "boolean"
        ? merged.showDockIcon
        : DEFAULT_SETTINGS.showDockIcon,
    startMinimized:
      typeof merged.startMinimized === "boolean"
        ? merged.startMinimized
        : DEFAULT_SETTINGS.startMinimized,
    closeToTray:
      typeof merged.closeToTray === "boolean" ? merged.closeToTray : DEFAULT_SETTINGS.closeToTray,
    showNotifications:
      typeof merged.showNotifications === "boolean"
        ? merged.showNotifications
        : DEFAULT_SETTINGS.showNotifications,
    showApprovalSavedNotifications:
      typeof merged.showApprovalSavedNotifications === "boolean"
        ? merged.showApprovalSavedNotifications
        : DEFAULT_SETTINGS.showApprovalSavedNotifications,
  };
}

export class TrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private gateway: ChannelGateway | null = null;
  private dbManager: DatabaseManager | null = null;
  private agentDaemon: AgentDaemon | null = null;
  private taskRepo: TaskRepository | null = null;
  private workspaceRepo: WorkspaceRepository | null = null;
  private settings: TraySettings = DEFAULT_SETTINGS;
  private connectedChannels: number = 0;
  private contextMenuSequence = 0;
  private activeTaskCount: number = 0;
  private quickInputWindow: QuickInputWindow | null = null;
  private currentQuickTaskId: string | null = null;
  private quickTaskAccumulatedResponse: string = "";
  private currentStepInfo: string = "";
  private legacySettingsPath: string;
  private statusUpdateTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by destroy() at quit so closing the window is no longer turned into hiding it. */
  private shuttingDown = false;

  private static instance: TrayManager | null = null;
  private static migrationCompleted = false;

  static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  private constructor() {
    // Defer app.getPath() - it's not available until app is ready.
    // legacySettingsPath will be resolved lazily in initialize().
    this.legacySettingsPath = "";
  }

  /**
   * Initialize the tray manager
   */
  async initialize(
    mainWindow: BrowserWindow,
    gateway: ChannelGateway,
    dbManager: DatabaseManager,
    agentDaemon?: AgentDaemon,
    options: TrayManagerOptions = {},
  ): Promise<void> {
    this.mainWindow = mainWindow;
    this.gateway = gateway;
    this.dbManager = dbManager;
    this.agentDaemon = agentDaemon || null;

    // Resolve legacy settings path now that app is ready
    this.legacySettingsPath = path.join(getUserDataDir(), LEGACY_SETTINGS_FILE);

    // Initialize repositories
    const db = dbManager.getDatabase();
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);

    // Load settings
    this.loadSettings();

    // Apply options overrides
    if (options.showDockIcon !== undefined) {
      this.settings.showDockIcon = options.showDockIcon;
    }
    if (options.startMinimized !== undefined) {
      this.settings.startMinimized = options.startMinimized;
    }
    if (options.closeToTray !== undefined) {
      this.settings.closeToTray = options.closeToTray;
    }

    // Create tray if enabled
    if (this.settings.enabled) {
      this.createTray();
    }

    // Apply dock icon setting (macOS only)
    this.applyDockIconSetting();

    // Handle start minimized
    if (this.settings.startMinimized && this.mainWindow) {
      this.mainWindow.hide();
    }

    // Set up window close behavior
    this.setupCloseToTray();

    // Update status periodically
    this.startStatusUpdates();

    // Set up task event listening for quick input responses
    this.setupTaskEventListener();

    // Initialize quick input window
    this.quickInputWindow = new QuickInputWindow();
    this.quickInputWindow.setOnSubmit((task, workspaceId) => {
      void this.handleQuickTaskSubmit(task, workspaceId).catch((error: unknown) => {
        trayLogger.warn("Quick task submission failed:", error);
      });
    });
    this.quickInputWindow.setOnOpenMain(() => {
      this.showMainWindow();
      this.quickInputWindow?.hide();
    });

    // Register global shortcut for quick input (Cmd+Shift+Space)
    this.registerGlobalShortcut();

    console.log("[TrayManager] Initialized");
  }

  /**
   * Set up listener for task events to stream to quick input
   */
  private setupTaskEventListener(): void {
    if (!this.agentDaemon) return;

    // Listen for assistant messages (the main text response)
    this.agentDaemon.on("assistant_message", (event: { taskId: string; message?: string }) => {
      if (event.taskId !== this.currentQuickTaskId) return;
      const message = event.message || "";
      if (message) {
        // Append to accumulated response (assistant may send multiple messages)
        if (this.quickTaskAccumulatedResponse) {
          this.quickTaskAccumulatedResponse += "\n\n" + message;
        } else {
          this.quickTaskAccumulatedResponse = message;
        }
        this.quickInputWindow?.updateResponse(
          this.formatResponseWithQuestion(this.quickTaskAccumulatedResponse),
          false,
        );
      }
    });

    // Listen for progress updates
    this.agentDaemon.on(
      "progress_update",
      (event: { taskId: string; message?: string; progress?: number }) => {
        if (event.taskId !== this.currentQuickTaskId) return;
        // Only show progress if we don't have response content yet
        if (!this.quickTaskAccumulatedResponse && event.message) {
          // escapeHtml: progress messages embed LLM-authored plan step text,
          // and updateResponse assigns to innerHTML in a window that has no
          // CSP, so unescaped markup here executes script.
          this.quickInputWindow?.updateResponse(
            `<p style="color: rgba(255,255,255,0.6);">${escapeHtml(event.message)}</p>`,
            false,
          );
        }
      },
    );

    // Listen for task completion
    this.agentDaemon.on(
      "task_completed",
      (event: { taskId: string; message?: string; result?: string }) => {
        if (event.taskId !== this.currentQuickTaskId) return;
        // Show the accumulated response as complete (without step prefix)
        const finalContent =
          this.quickTaskAccumulatedResponse ||
          event.result ||
          event.message ||
          "Task completed successfully";
        this.quickInputWindow?.updateResponse(this.formatResponseWithQuestion(finalContent), true);
        this.currentQuickTaskId = null;
        this.quickTaskAccumulatedResponse = "";
        this.currentStepInfo = "";
      },
    );

    // Listen for errors
    this.agentDaemon.on("error", (event: { taskId: string; message?: string }) => {
      if (event.taskId !== this.currentQuickTaskId) return;
      const question = this.quickInputWindow?.getCurrentQuestion() || "";
      const questionHtml = question
        ? `<div class="user-question"><strong>You:</strong> ${escapeHtml(question)}</div>`
        : "";
      this.quickInputWindow?.updateResponse(
        `${questionHtml}<div class="error-message">Error: ${escapeHtml(
          event.message || "An error occurred",
        )}</div>`,
        true,
      );
      this.currentQuickTaskId = null;
      this.quickTaskAccumulatedResponse = "";
      this.currentStepInfo = "";
    });

    // Listen for step started (show what step is being executed)
    this.agentDaemon.on(
      "step_started",
      (event: { taskId: string; step?: { id: number; description: string } }) => {
        if (event.taskId !== this.currentQuickTaskId) return;
        // Show step info above the response
        if (event.step?.description) {
          const stepInfo = `**Step ${event.step.id}:** ${event.step.description}\n\n`;
          // Prepend step info (it will be replaced by next step)
          this.currentStepInfo = stepInfo;
          this.quickInputWindow?.updateResponse(
            this.formatResponseWithQuestion(
              this.currentStepInfo + this.quickTaskAccumulatedResponse,
            ),
            false,
          );
        }
      },
    );

    // Listen for plan created (show what the agent is going to do)
    this.agentDaemon.on(
      "plan_created",
      (event: { taskId: string; plan?: { steps: Array<{ id: number; description: string }> } }) => {
        if (event.taskId !== this.currentQuickTaskId) return;
        if (event.plan?.steps && event.plan.steps.length > 0) {
          const planSummary = event.plan.steps
            .map((s, i) => `${i + 1}. ${s.description}`)
            .join("\n");
          this.quickTaskAccumulatedResponse = `**Plan:**\n${planSummary}\n\n`;
          this.quickInputWindow?.updateResponse(
            this.formatResponseWithQuestion(this.quickTaskAccumulatedResponse),
            false,
          );
        }
      },
    );
  }

  /**
   * Format response text for HTML display
   */
  private formatResponseForDisplay(text: string): string {
    // Basic markdown-like formatting
    return (
      toPlainAnswerText(text)
        // Escape HTML
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        // Bold
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        // Code blocks
        .replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
        // Inline code
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // Line breaks
        .replace(/\n/g, "<br>")
    );
  }

  /**
   * Format response with user's question prepended
   */
  private formatResponseWithQuestion(text: string): string {
    const question = this.quickInputWindow?.getCurrentQuestion() || "";
    const formattedResponse = this.formatResponseForDisplay(text);

    if (question) {
      const escapedQuestion = question
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div class="user-question"><strong>You:</strong> ${escapedQuestion}</div>${formattedResponse}`;
    }

    return formattedResponse;
  }

  /**
   * Get or create the temp workspace
   */
  private async getOrCreateTempWorkspace(): Promise<Workspace> {
    if (!this.dbManager) throw new Error("Database not available");
    if (!this.workspaceRepo) throw new Error("Workspace repository not available");

    const db = this.dbManager.getDatabase();
    const workspaceRepo = this.workspaceRepo;
    const ensureTempWorkspace = async (
      workspaceId: string,
      workspacePath: string,
      existing?: Workspace,
    ): Promise<Workspace> => {
      const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
      const safeWorkspacePath = ensureTempWorkspaceDirectoryPathSync(
        tempWorkspaceRoot,
        workspacePath,
      );

      const createdAt = existing?.createdAt ?? Date.now();
      const lastUsedAt = Date.now();
      const permissions = {
        ...existing?.permissions,
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: existing?.permissions?.shell ?? false,
        unrestrictedFileAccess: true,
      };

      await workspaceRepo.upsertWithId({
        id: workspaceId,
        name: TEMP_WORKSPACE_NAME,
        path: safeWorkspacePath,
        createdAt,
        lastUsedAt,
        permissions,
      });

      return {
        id: workspaceId,
        name: TEMP_WORKSPACE_NAME,
        path: safeWorkspacePath,
        createdAt,
        lastUsedAt,
        permissions,
        isTemp: true,
      };
    };

    const existing = (await this.workspaceRepo.findAll()).find((workspace) =>
      isTempWorkspaceInScope(workspace.id, "tray"),
    );
    let workspace: Workspace;
    if (existing) {
      workspace = await ensureTempWorkspace(existing.id, existing.path, existing);
    } else {
      const created = createUniqueScopedTempWorkspaceDirectorySync(
        path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME),
        "tray",
      );
      workspace = await ensureTempWorkspace(created.workspaceId, created.path);
    }

    try {
      await pruneTempWorkspaces({
        db,
        tempWorkspaceRoot: path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME),
        currentWorkspaceId: workspace.id,
        protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
      });
    } catch (error) {
      console.warn("[TrayManager] Failed to prune temp workspaces:", error);
    }

    touchTempWorkspaceLease(workspace.id);

    return workspace;
  }

  /**
   * Handle quick task submission - create and run task
   */
  private async handleQuickTaskSubmit(prompt: string, workspaceId?: string): Promise<void> {
    if (!this.taskRepo || !this.workspaceRepo || !this.agentDaemon) {
      // Fall back to sending to main window
      console.log("[TrayManager] Agent daemon not available, falling back to main window");
      this.showMainWindow();
      this.mainWindow?.webContents.send(IPC_CHANNELS.TRAY_QUICK_TASK, {
        task: prompt,
        workspaceId,
      });
      return;
    }

    // Show loading state and reset accumulated response
    this.quickInputWindow?.showLoading();
    this.quickTaskAccumulatedResponse = "";
    this.currentStepInfo = "";

    try {
      // Get or select workspace
      let wsId = workspaceId;
      if (!wsId) {
        // Get the first non-temp workspace, or use temp workspace as fallback
        const workspaces = (await this.workspaceRepo.findAll()).filter(
          (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
        );
        if (workspaces.length > 0) {
          wsId = workspaces[0].id;
        } else {
          // No user workspaces, use temp workspace
          const tempWorkspace = await this.getOrCreateTempWorkspace();
          wsId = tempWorkspace.id;
        }
      }

      // Create task
      const task = await this.taskRepo.create({
        title: prompt.slice(0, 50) + (prompt.length > 50 ? "..." : ""),
        prompt,
        workspaceId: wsId,
        status: "queued",
        agentConfig: taskAgentConfigForCreation(
          undefined,
          PermissionSettingsManager.loadSettings(),
        ),
        // The owner typed this into the tray's quick task field, so it may expose the
        // admin-lane tools (Task.promptProvenance).
        ...USER_TYPED_TASK_PROMPT,
      });

      this.currentQuickTaskId = task.id;

      // Start task execution
      await this.agentDaemon.startTask(task);

      // Also notify main window so it updates the task list
      this.mainWindow?.webContents.send("tray:task-created", { taskId: task.id });
    } catch (error) {
      console.error("[TrayManager] Failed to create quick task:", error);
      const question = this.quickInputWindow?.getCurrentQuestion() || "";
      const questionHtml = question
        ? `<div class="user-question"><strong>You:</strong> ${question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
        : "";
      this.quickInputWindow?.updateResponse(
        `${questionHtml}<div class="error-message">Failed to create task: ${error instanceof Error ? error.message : "Unknown error"}</div>`,
        true,
      );
      this.currentQuickTaskId = null;
    }
  }

  /**
   * Show the quick input window
   */
  showQuickInput(): void {
    this.quickInputWindow?.show();
  }

  /**
   * Toggle the quick input window
   */
  toggleQuickInput(): void {
    this.quickInputWindow?.toggle();
  }

  /**
   * Register global keyboard shortcut for quick input
   */
  private registerGlobalShortcut(): void {
    try {
      // Unregister first in case it's already registered
      globalShortcut.unregister("CommandOrControl+Shift+Space");

      const registered = globalShortcut.register("CommandOrControl+Shift+Space", () => {
        this.showQuickInput();
      });

      if (registered) {
        console.log("[TrayManager] Global shortcut registered: Cmd+Shift+Space");
      } else {
        console.warn(
          "[TrayManager] Failed to register global shortcut - may be in use by another app",
        );
      }
    } catch (error) {
      console.error("[TrayManager] Error registering global shortcut:", error);
    }
  }

  /**
   * Unregister global keyboard shortcut
   */
  private unregisterGlobalShortcut(): void {
    try {
      globalShortcut.unregister("CommandOrControl+Shift+Space");
      console.log("[TrayManager] Global shortcut unregistered");
    } catch (error) {
      console.error("[TrayManager] Error unregistering global shortcut:", error);
    }
  }

  /**
   * Create the system tray icon
   */
  private createTray(): void {
    if (this.tray) {
      return;
    }

    try {
      this.tray = new Tray(getTrayIconImage());
      this.tray.setToolTip("CoWork OS");

      // Build and set context menu
      this.updateContextMenu();

      // Handle click events - always show context menu on click
      this.tray.on("click", () => {
        this.tray?.popUpContextMenu();
      });
    } catch (error) {
      console.error("[TrayManager] Failed to create tray:", error);
    }
  }

  /**
   * Update the tray context menu
   */
  private updateContextMenu(): void {
    const sequence = ++this.contextMenuSequence;
    void this.refreshContextMenu(sequence).catch((error) => {
      trayLogger.warn("Failed to update the tray menu:", error);
    });
  }

  private async refreshContextMenu(sequence: number): Promise<void> {
    if (!this.tray) return;

    // Channels are read through the async storage facade; a refresh that an
    // overlapping later one has superseded drops its result.
    const channels = (await this.gateway?.getChannels()) || [];
    if (!this.tray || sequence !== this.contextMenuSequence) return;
    const statusText = this.getStatusText(channels);
    const workspaces = await this.getWorkspaces();

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      // Status section
      {
        label: statusText,
        enabled: false,
        icon: this.getStatusIcon(),
      },
      { type: "separator" },

      // Quick actions
      {
        label: "Quick Task...",
        accelerator: "CmdOrCtrl+Shift+Space",
        click: () => {
          this.showQuickInput();
        },
      },
      {
        label: "New Task...",
        accelerator: "CmdOrCtrl+N",
        click: () => {
          this.showMainWindow();
          this.mainWindow?.webContents.send("tray:new-task");
        },
      },
      { type: "separator" },

      // Workspaces submenu
      {
        label: "Workspaces",
        submenu:
          workspaces.length > 0
            ? workspaces.map((ws) => ({
                label: ws.name,
                click: () => {
                  this.showMainWindow();
                  this.mainWindow?.webContents.send("tray:select-workspace", ws.id);
                },
              }))
            : [{ label: "No workspaces", enabled: false }],
      },

      // Channels submenu
      {
        label: "Channels",
        submenu: this.buildChannelsSubmenu(channels),
      },
      { type: "separator" },

      // Window controls
      {
        label: this.mainWindow?.isVisible() ? "Hide Window" : "Show Window",
        accelerator: "CmdOrCtrl+H",
        click: () => this.toggleMainWindow(),
      },
      {
        label: "Settings...",
        accelerator: "CmdOrCtrl+,",
        click: () => {
          this.showMainWindow();
          this.mainWindow?.webContents.send("tray:open-settings");
        },
      },
      ...(this.buildChronicleMenuItems().length > 0
        ? [...this.buildChronicleMenuItems(), { type: "separator" as const }]
        : []),

      // App controls
      {
        label: "About CoWork OS",
        click: () => {
          this.showMainWindow();
          this.mainWindow?.webContents.send("tray:open-about");
        },
      },
      {
        label: "Check for Updates...",
        click: () => void getUpdatePrompt().checkNow(),
      },
      { type: "separator" },
      {
        label: "Quit CoWork OS",
        accelerator: "CmdOrCtrl+Q",
        click: () => {
          // Force quit (bypass close-to-tray)
          this.settings.closeToTray = false;
          app.quit();
        },
      },
    ];

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Build the channels submenu
   */
  private buildChannelsSubmenu(channels: Channel[]): Electron.MenuItemConstructorOptions[] {
    if (channels.length === 0) {
      return [{ label: "No channels configured", enabled: false }];
    }

    return channels.map((channel) => {
      const statusIcon =
        channel.status === "connected"
          ? "🟢"
          : channel.status === "connecting"
            ? "🟡"
            : channel.status === "error"
              ? "🔴"
              : "⚪";
      return {
        label: `${statusIcon} ${channel.name} (${channel.type})`,
        enabled: false,
      };
    });
  }

  /**
   * Get status text for the menu
   */
  private getStatusText(channels: Channel[]): string {
    const chronicleSettings = ChronicleSettingsManager.loadSettings();
    this.connectedChannels = channels.filter((c) => c.status === "connected").length;

    if (this.activeTaskCount > 0) {
      return `${chronicleSettings.enabled && chronicleSettings.paused ? "Chronicle paused • " : ""}Working on ${this.activeTaskCount} task${this.activeTaskCount > 1 ? "s" : ""}`;
    }

    if (this.connectedChannels > 0) {
      return `${chronicleSettings.enabled && chronicleSettings.paused ? "Chronicle paused • " : ""}${this.connectedChannels} channel${this.connectedChannels > 1 ? "s" : ""} connected`;
    }

    if (chronicleSettings.enabled && chronicleSettings.paused) {
      return "Chronicle paused";
    }

    return "Ready";
  }

  private buildChronicleMenuItems(): Electron.MenuItemConstructorOptions[] {
    const chronicleSettings = ChronicleSettingsManager.loadSettings();
    if (!chronicleSettings.enabled) {
      return [];
    }
    return [
      {
        label: chronicleSettings.paused ? "Resume Chronicle" : "Pause Chronicle",
        click: () => {
          void this.toggleChroniclePause(!chronicleSettings.paused);
        },
      },
    ];
  }

  private async toggleChroniclePause(paused: boolean): Promise<void> {
    const next = ChronicleSettingsManager.saveSettings({ paused });
    await ChronicleCaptureService.getInstance().applySettings(next);
    ChronicleMemoryService.getInstance().applySettings(next);
    this.updateContextMenu();
  }

  /**
   * Get status icon for the menu
   */
  private getStatusIcon(): NativeImage | undefined {
    // Return undefined for now - icons in menu items can be complex
    return undefined;
  }

  /**
   * Get workspaces from database (excluding temp workspace)
   */
  private async getWorkspaces(): Promise<Array<{ id: string; name: string; path: string }>> {
    if (!this.workspaceRepo) return [];

    try {
      return (await this.workspaceRepo.findAll())
        .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id))
        .map(({ id, name, path: workspacePath }) => ({ id, name, path: workspacePath }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("[TrayManager] Failed to get workspaces:", error);
      return [];
    }
  }

  /**
   * Toggle main window visibility
   */
  private toggleMainWindow(): void {
    if (!this.mainWindow) return;

    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.showMainWindow();
    }

    // Update menu to reflect new state
    this.updateContextMenu();
  }

  /**
   * Show and focus the main window
   */
  private showMainWindow(): void {
    if (!this.mainWindow) return;

    this.mainWindow.show();
    this.mainWindow.focus();

    // On macOS, also bring app to foreground
    if (process.platform === "darwin") {
      void app.dock?.show();
    }
  }

  /**
   * Set up close-to-tray behavior
   */
  private setupCloseToTray(): void {
    if (!this.mainWindow) return;

    this.mainWindow.on("close", (event) => {
      if (this.shuttingDown || !this.settings.closeToTray) return;
      // Without a tray icon only macOS can bring a hidden window back (from the Dock),
      // so elsewhere the window closes normally.
      if (!this.tray && process.platform !== "darwin") return;

      event.preventDefault();
      this.mainWindow?.hide();

      // On macOS, hide from dock when minimized to tray
      if (process.platform === "darwin" && !this.settings.showDockIcon && this.tray) {
        app.dock?.hide();
      }
    });
  }

  /**
   * Apply dock icon visibility setting (macOS only). The Dock icon stays while
   * there is no menu bar icon, so a hidden window can always be reopened.
   */
  private applyDockIconSetting(): void {
    if (process.platform !== "darwin") return;

    if (this.settings.showDockIcon || !this.tray) {
      void app.dock?.show();
    } else {
      app.dock?.hide();
    }
  }

  /**
   * Start periodic status updates
   */
  private startStatusUpdates(): void {
    // Update every 5 seconds
    this.statusUpdateTimer = setInterval(() => {
      this.updateContextMenu();
    }, 5000);
  }

  /**
   * Update active task count
   */
  setActiveTaskCount(count: number): void {
    this.activeTaskCount = count;
    this.updateContextMenu();
  }

  /**
   * Migrate settings from legacy JSON file to encrypted database
   */
  private migrateFromLegacyFile(): void {
    if (TrayManager.migrationCompleted) return;

    try {
      if (!SecureSettingsRepository.isInitialized()) {
        return;
      }

      const repository = SecureSettingsRepository.getInstance();

      // Check if already migrated
      if (repository.exists("tray")) {
        TrayManager.migrationCompleted = true;
        return;
      }

      // Check if legacy file exists
      if (!fs.existsSync(this.legacySettingsPath)) {
        TrayManager.migrationCompleted = true;
        return;
      }

      console.log(
        "[TrayManager] Migrating settings from legacy JSON file to encrypted database...",
      );

      // Create backup before migration
      const backupPath = this.legacySettingsPath + ".migration-backup";
      fs.copyFileSync(this.legacySettingsPath, backupPath);

      try {
        const data = fs.readFileSync(this.legacySettingsPath, "utf-8");
        const parsed = JSON.parse(data);
        const merged = normalizeTraySettings({ ...DEFAULT_SETTINGS, ...parsed });

        repository.save("tray", merged);
        console.log("[TrayManager] Settings migrated to encrypted database");

        // Migration successful - delete backup and original
        fs.unlinkSync(backupPath);
        fs.unlinkSync(this.legacySettingsPath);
        console.log("[TrayManager] Migration complete, cleaned up legacy files");

        TrayManager.migrationCompleted = true;
      } catch (migrationError) {
        console.error("[TrayManager] Migration failed, backup preserved at:", backupPath);
        throw migrationError;
      }
    } catch (error) {
      console.error("[TrayManager] Migration failed:", error);
    }
  }

  /**
   * Load settings from encrypted database
   */
  private loadSettings(): void {
    // Migrate from legacy file if needed
    this.migrateFromLegacyFile();

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<StoredTraySettings>("tray");
        if (stored) {
          this.settings = traySettingsFromStorage(stored);
          console.log("[TrayManager] Loaded settings from encrypted database");
          return;
        }
      }
    } catch (error) {
      console.error("[TrayManager] Failed to load settings:", error);
    }

    // Fall back to defaults
    this.settings = normalizeTraySettings(null);
  }

  /**
   * Save settings to encrypted database
   */
  saveSettings(settings: Partial<TraySettings>): void {
    const patch = Object.fromEntries(
      Object.entries(settings).filter(([, v]) => v !== undefined),
    ) as Partial<TraySettings>;
    this.settings = normalizeTraySettings({ ...this.settings, ...patch });

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        repository.save("tray", traySettingsForStorage(this.settings));
        console.log("[TrayManager] Settings saved to encrypted database");
      } else {
        console.warn(
          "[TrayManager] SecureSettingsRepository not initialized, settings not persisted",
        );
      }

      // Apply settings immediately; the tray first, since the Dock depends on it.
      if (this.settings.enabled && !this.tray) {
        this.createTray();
      } else if (!this.settings.enabled && this.tray) {
        this.destroyTray();
      }
      this.applyDockIconSetting();
    } catch (error) {
      console.error("[TrayManager] Failed to save settings:", error);
    }
  }

  /**
   * Get current settings
   */
  getSettings(): TraySettings {
    return { ...this.settings };
  }

  /**
   * Show a notification from the tray
   */
  showNotification(title: string, body: string, taskId?: string): void {
    if (!this.settings.showNotifications) return;

    const notification = {
      id: `tray-${randomUUID()}`,
      title,
      message: body,
      taskId,
    };
    showDesktopNotification(notification);
  }

  /**
   * Destroy the tray
   */
  destroy(): void {
    this.shuttingDown = true;
    if (this.statusUpdateTimer) {
      clearInterval(this.statusUpdateTimer);
      this.statusUpdateTimer = null;
    }

    // Unregister global shortcut
    this.unregisterGlobalShortcut();

    if (this.quickInputWindow) {
      this.quickInputWindow.destroy();
      this.quickInputWindow = null;
    }
    this.destroyTray();
  }

  /**
   * Remove only the menu bar / system tray icon; Quick Task and its shortcut stay.
   */
  private destroyTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

export const trayManager = TrayManager.getInstance();
