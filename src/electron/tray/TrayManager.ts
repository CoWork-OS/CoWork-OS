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

import {
  app,
  Tray,
  Menu,
  nativeImage,
  BrowserWindow,
  shell,
  NativeImage,
  globalShortcut,
} from "electron";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ChannelGateway } from "../gateway";
import { DatabaseManager } from "../database/schema";
import { TaskRepository, WorkspaceRepository } from "../database/repositories";
import { AgentDaemon } from "../agent/daemon";
import { QuickInputWindow } from "./QuickInputWindow";
import {
  TEMP_WORKSPACE_ID_PREFIX,
  TEMP_WORKSPACE_NAME,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  IPC_CHANNELS,
  Workspace,
  isTempWorkspaceId,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { pruneTempWorkspaces } from "../utils/temp-workspace";

const LEGACY_SETTINGS_FILE = "tray-settings.json";

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
}

const DEFAULT_SETTINGS: TraySettings = {
  enabled: true,
  showDockIcon: true,
  startMinimized: false,
  closeToTray: true,
  showNotifications: true,
};

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
  private activeTaskCount: number = 0;
  private quickInputWindow: QuickInputWindow | null = null;
  private currentQuickTaskId: string | null = null;
  private quickTaskAccumulatedResponse: string = "";
  private currentStepInfo: string = "";
  private legacySettingsPath: string;

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
      this.handleQuickTaskSubmit(task, workspaceId);
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
          this.quickInputWindow?.updateResponse(
            `<p style="color: rgba(255,255,255,0.6);">${event.message}</p>`,
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
        ? `<div class="user-question"><strong>You:</strong> ${question.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
        : "";
      this.quickInputWindow?.updateResponse(
        `${questionHtml}<div class="error-message">Error: ${event.message || "An error occurred"}</div>`,
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
      text
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
    const ensureTempWorkspace = (
      workspaceId: string,
      workspacePath: string,
      existing?: Workspace,
    ): Workspace => {
      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }

      const createdAt = existing?.createdAt ?? Date.now();
      const lastUsedAt = Date.now();
      const permissions = {
        ...(existing?.permissions ?? {}),
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: existing?.permissions?.shell ?? false,
        unrestrictedFileAccess: true,
      };

      const stmt = db.prepare(`
        INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          last_used_at = excluded.last_used_at,
          permissions = excluded.permissions
      `);
      stmt.run(
        workspaceId,
        TEMP_WORKSPACE_NAME,
        workspacePath,
        createdAt,
        lastUsedAt,
        JSON.stringify(permissions),
      );

      return {
        id: workspaceId,
        name: TEMP_WORKSPACE_NAME,
        path: workspacePath,
        createdAt,
        lastUsedAt,
        permissions,
        isTemp: true,
      };
    };

    const existing = this.workspaceRepo
      .findAll()
      .find((workspace) => workspace.isTemp || isTempWorkspaceId(workspace.id));
    let workspace: Workspace;
    if (existing) {
      workspace = ensureTempWorkspace(existing.id, existing.path, existing);
    } else {
      const key = `tray-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const workspaceId = `${TEMP_WORKSPACE_ID_PREFIX}${key}`;
      const tempDir = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME, key);
      workspace = ensureTempWorkspace(workspaceId, tempDir);
    }

    try {
      pruneTempWorkspaces({
        db,
        tempWorkspaceRoot: path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME),
        currentWorkspaceId: workspace.id,
      });
    } catch (error) {
      console.warn("[TrayManager] Failed to prune temp workspaces:", error);
    }

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
        const workspaces = this.workspaceRepo
          .findAll()
          .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
        if (workspaces.length > 0) {
          wsId = workspaces[0].id;
        } else {
          // No user workspaces, use temp workspace
          const tempWorkspace = await this.getOrCreateTempWorkspace();
          wsId = tempWorkspace.id;
        }
      }

      // Create task
      const task = this.taskRepo.create({
        title: prompt.slice(0, 50) + (prompt.length > 50 ? "..." : ""),
        prompt,
        workspaceId: wsId,
        status: "queued",
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
      // Create tray icon (use template image for macOS)
      const icon = this.getTrayIcon("idle");

      this.tray = new Tray(icon);
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
   * Get or create tray icon
   */
  private getTrayIcon(state: "idle" | "active" | "error"): NativeImage {
    // Try to load from file first
    const iconPath = this.getIconPath("trayTemplate");
    const fs = require("fs");

    if (fs.existsSync(iconPath)) {
      let icon = nativeImage.createFromPath(iconPath);
      // Resize to standard macOS menu bar icon size (~18x18 pt)
      icon = icon.resize({ width: 18, height: 18 });
      if (process.platform === "darwin") {
        icon.setTemplateImage(true);
      }
      return icon;
    }

    // Create programmatic icon if file doesn't exist
    return this.createProgrammaticIcon(state);
  }

  /**
   * Create a programmatic tray icon using raw RGBA bitmap
   * More reliable than SVG data URLs for Electron tray icons
   */
  private createProgrammaticIcon(state: "idle" | "active" | "error"): NativeImage {
    // Standard macOS menu bar icon size (16x16 for 1x, 32x32 for 2x retina)
    const size = 16;
    const scale = 2; // Create at 2x for retina
    const actualSize = size * scale;

    // Create RGBA buffer (4 bytes per pixel)
    const buffer = Buffer.alloc(actualSize * actualSize * 4);

    // Get color based on state
    const [r, g, b] =
      state === "error"
        ? [255, 59, 48] // Red
        : state === "active"
          ? [0, 122, 255] // Blue
          : [255, 255, 255]; // White

    // Draw a simple filled circle
    const centerX = actualSize / 2;
    const centerY = actualSize / 2;
    const outerRadius = actualSize / 2 - 2;
    const innerRadius = outerRadius - 4;

    for (let y = 0; y < actualSize; y++) {
      for (let x = 0; x < actualSize; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const idx = (y * actualSize + x) * 4;

        // Draw ring (between inner and outer radius)
        if (distance <= outerRadius && distance >= innerRadius) {
          // Anti-aliasing at edges
          let alpha = 255;
          if (distance > outerRadius - 1) {
            alpha = Math.round(255 * (outerRadius - distance));
          } else if (distance < innerRadius + 1) {
            alpha = Math.round(255 * (distance - innerRadius));
          }
          alpha = Math.max(0, Math.min(255, alpha));

          buffer[idx] = r;
          buffer[idx + 1] = g;
          buffer[idx + 2] = b;
          buffer[idx + 3] = alpha;
        } else {
          // Transparent
          buffer[idx] = 0;
          buffer[idx + 1] = 0;
          buffer[idx + 2] = 0;
          buffer[idx + 3] = 0;
        }
      }
    }

    return nativeImage.createFromBuffer(buffer, {
      width: actualSize,
      height: actualSize,
      scaleFactor: scale,
    });
  }

  /**
   * Get the path to a tray icon
   */
  private getIconPath(name: string): string {
    const isDev = process.env.NODE_ENV === "development";
    const basePath = isDev
      ? path.join(__dirname, "../../../../assets/tray")
      : path.join(process.resourcesPath, "assets/tray");

    // Use PNG for cross-platform compatibility
    const extension = process.platform === "darwin" ? "png" : "png";
    return path.join(basePath, `${name}.${extension}`);
  }

  /**
   * Update the tray context menu
   */
  private updateContextMenu(): void {
    if (!this.tray) return;

    const statusText = this.getStatusText();
    const workspaces = this.getWorkspaces();

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
        submenu: this.buildChannelsSubmenu(),
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
      { type: "separator" },

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
        click: () => {
          this.showMainWindow();
          this.mainWindow?.webContents.send("tray:check-updates");
        },
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
  private buildChannelsSubmenu(): Electron.MenuItemConstructorOptions[] {
    const channels = this.gateway?.getChannels() || [];

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
  private getStatusText(): string {
    const channels = this.gateway?.getChannels() || [];
    this.connectedChannels = channels.filter((c) => c.status === "connected").length;

    if (this.activeTaskCount > 0) {
      return `Working on ${this.activeTaskCount} task${this.activeTaskCount > 1 ? "s" : ""}`;
    }

    if (this.connectedChannels > 0) {
      return `${this.connectedChannels} channel${this.connectedChannels > 1 ? "s" : ""} connected`;
    }

    return "Ready";
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
  private getWorkspaces(): Array<{ id: string; name: string; path: string }> {
    if (!this.workspaceRepo) return [];

    try {
      return this.workspaceRepo
        .findAll()
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
      app.dock?.show();
    }
  }

  /**
   * Set up close-to-tray behavior
   */
  private setupCloseToTray(): void {
    if (!this.mainWindow) return;

    this.mainWindow.on("close", (event) => {
      if (this.settings.closeToTray && this.tray) {
        event.preventDefault();
        this.mainWindow?.hide();

        // On macOS, hide from dock when minimized to tray
        if (process.platform === "darwin" && !this.settings.showDockIcon) {
          app.dock?.hide();
        }
      }
    });
  }

  /**
   * Apply dock icon visibility setting (macOS only)
   */
  private applyDockIconSetting(): void {
    if (process.platform !== "darwin") return;

    if (this.settings.showDockIcon) {
      app.dock?.show();
    } else {
      app.dock?.hide();
    }
  }

  /**
   * Start periodic status updates
   */
  private startStatusUpdates(): void {
    // Update every 5 seconds
    setInterval(() => {
      this.updateContextMenu();
      this.updateTrayIcon();
    }, 5000);
  }

  /**
   * Update tray icon based on status
   */
  private updateTrayIcon(): void {
    if (!this.tray) return;

    // Determine icon state based on app status
    const state: "idle" | "active" | "error" = this.activeTaskCount > 0 ? "active" : "idle";
    const icon = this.getTrayIcon(state);
    this.tray.setImage(icon);
  }

  /**
   * Update active task count
   */
  setActiveTaskCount(count: number): void {
    this.activeTaskCount = count;
    this.updateContextMenu();
    this.updateTrayIcon();
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
        const merged = { ...DEFAULT_SETTINGS, ...parsed };

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
        const stored = repository.load<TraySettings>("tray");
        if (stored) {
          this.settings = { ...DEFAULT_SETTINGS, ...stored };
          console.log("[TrayManager] Loaded settings from encrypted database");
          return;
        }
      }
    } catch (error) {
      console.error("[TrayManager] Failed to load settings:", error);
    }

    // Fall back to defaults
    this.settings = { ...DEFAULT_SETTINGS };
  }

  /**
   * Save settings to encrypted database
   */
  saveSettings(settings: Partial<TraySettings>): void {
    this.settings = { ...this.settings, ...settings };

    try {
      if (SecureSettingsRepository.isInitialized()) {
        const repository = SecureSettingsRepository.getInstance();
        repository.save("tray", this.settings);
        console.log("[TrayManager] Settings saved to encrypted database");
      } else {
        console.warn(
          "[TrayManager] SecureSettingsRepository not initialized, settings not persisted",
        );
      }

      // Apply settings immediately
      this.applyDockIconSetting();

      // Recreate tray if enabled status changed
      if (settings.enabled !== undefined) {
        if (settings.enabled && !this.tray) {
          this.createTray();
        } else if (!settings.enabled && this.tray) {
          this.destroy();
        }
      }
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
  showNotification(title: string, body: string): void {
    if (!this.settings.showNotifications) return;

    const { Notification } = require("electron");
    if (Notification.isSupported()) {
      const notification = new Notification({
        title,
        body,
        silent: false,
      });
      notification.on("click", () => {
        this.showMainWindow();
      });
      notification.show();
    }
  }

  /**
   * Destroy the tray
   */
  destroy(): void {
    // Unregister global shortcut
    this.unregisterGlobalShortcut();

    if (this.quickInputWindow) {
      this.quickInputWindow.destroy();
      this.quickInputWindow = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

export const trayManager = TrayManager.getInstance();
