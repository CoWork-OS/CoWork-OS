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
  shell as _shell,
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
  TEMP_WORKSPACE_NAME,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  IPC_CHANNELS,
  Workspace,
  isTempWorkspaceId,
} from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { pruneTempWorkspaces } from "../utils/temp-workspace";
import {
  createScopedTempWorkspaceIdentity,
  isTempWorkspaceInScope,
  sanitizeTempWorkspaceKey,
} from "../utils/temp-workspace-scope";
import { getActiveTempWorkspaceLeases, touchTempWorkspaceLease } from "../utils/temp-workspace-lease";
import { ChronicleCaptureService, ChronicleMemoryService, ChronicleSettingsManager } from "../chronicle";
import {
  NativeNotificationCenter,
  NotificationOverlayManager,
} from "../notifications";

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
  showApprovalSavedNotifications: boolean;
}

const DEFAULT_SETTINGS: TraySettings = {
  enabled: true,
  showDockIcon: true,
  startMinimized: false,
  closeToTray: true,
  showNotifications: true,
  showApprovalSavedNotifications: false,
};

/**
 * Coerce persisted tray settings to valid booleans. Missing or invalid values
 * (e.g. `null` from corrupted JSON) fall back to defaults so `enabled` does not
 * silently become falsy and hide the menu bar / system tray icon.
 */
export function normalizeTraySettings(
  raw: Partial<TraySettings> | null | undefined,
): TraySettings {
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
        ...existing?.permissions,
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
      .find((workspace) => isTempWorkspaceInScope(workspace.id, "tray"));
    let workspace: Workspace;
    if (existing) {
      workspace = ensureTempWorkspace(existing.id, existing.path, existing);
    } else {
      const key = sanitizeTempWorkspaceKey(`session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
      const identity = createScopedTempWorkspaceIdentity("tray", key);
      const workspaceId = identity.workspaceId;
      const tempDir = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME, identity.slug);
      workspace = ensureTempWorkspace(workspaceId, tempDir);
    }

    try {
      pruneTempWorkspaces({
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

      // Supply tray bounds so overlay notifications resolve the correct display (multi-monitor)
      try {
        const trayRef = this.tray;
        NotificationOverlayManager.getInstance().setAnchorBoundsProvider(
          () => trayRef?.getBounds() ?? null,
        );
      } catch {
        // Overlay fallback can still use the primary display if tray bounds are unavailable.
      }

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
  private getTrayIcon(_state: "idle" | "active" | "error"): NativeImage {
    return this.createProgrammaticIcon();
  }

  /**
   * Create a programmatic tray icon — Mac Mini device icon
   * Matches the icon used in notification overlays
   */
  private createProgrammaticIcon(): NativeImage {
    const size = 18;
    const scale = 2;
    const s = size * scale; // 36px actual

    const buffer = Buffer.alloc(s * s * 4);

    // Helper to set a pixel with alpha blending
    const setPixel = (x: number, y: number, alpha: number) => {
      if (x < 0 || x >= s || y < 0 || y >= s) return;
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || ix >= s || iy < 0 || iy >= s) return;
      const idx = (iy * s + ix) * 4;
      const a = Math.max(0, Math.min(255, Math.round(alpha)));
      // Template image: use black with alpha (macOS inverts automatically)
      if (a > buffer[idx + 3]) {
        buffer[idx] = 0;
        buffer[idx + 1] = 0;
        buffer[idx + 2] = 0;
        buffer[idx + 3] = a;
      }
    };

    // Draw anti-aliased line (horizontal or vertical)
    const drawHLine = (x1: number, x2: number, y: number, thickness: number) => {
      for (let x = Math.floor(x1); x <= Math.ceil(x2); x++) {
        for (let dy = -thickness / 2; dy < thickness / 2; dy++) {
          const py = y + dy;
          // Coverage-based alpha
          const xCov = Math.min(x + 1, x2) - Math.max(x, x1);
          const yCov = Math.min(py + 1, y + thickness / 2) - Math.max(py, y - thickness / 2);
          setPixel(x, Math.floor(py), xCov * yCov * 255);
        }
      }
    };

    const drawVLine = (x: number, y1: number, y2: number, thickness: number) => {
      for (let y = Math.floor(y1); y <= Math.ceil(y2); y++) {
        for (let dx = -thickness / 2; dx < thickness / 2; dx++) {
          const px = x + dx;
          const yCov = Math.min(y + 1, y2) - Math.max(y, y1);
          const xCov = Math.min(px + 1, x + thickness / 2) - Math.max(px, x - thickness / 2);
          setPixel(Math.floor(px), y, xCov * yCov * 255);
        }
      }
    };

    // Draw stroked rounded rect
    const strokeRoundedRect = (
      rx: number, ry: number, rw: number, rh: number,
      radius: number, strokeWidth: number
    ) => {
      // Top and bottom edges
      drawHLine(rx + radius, rx + rw - radius, ry, strokeWidth);
      drawHLine(rx + radius, rx + rw - radius, ry + rh, strokeWidth);
      // Left and right edges
      drawVLine(rx, ry + radius, ry + rh - radius, strokeWidth);
      drawVLine(rx + rw, ry + radius, ry + rh - radius, strokeWidth);

      // Draw rounded corners
      const cornerCenters = [
        [rx + radius, ry + radius, Math.PI, Math.PI * 1.5],
        [rx + rw - radius, ry + radius, Math.PI * 1.5, Math.PI * 2],
        [rx + radius, ry + rh - radius, Math.PI * 0.5, Math.PI],
        [rx + rw - radius, ry + rh - radius, 0, Math.PI * 0.5],
      ];
      for (const [cx, cy, startAngle, endAngle] of cornerCenters) {
        const steps = Math.ceil(radius * 8);
        for (let i = 0; i <= steps; i++) {
          const angle = startAngle + (endAngle - startAngle) * (i / steps);
          const px = cx + Math.cos(angle) * radius;
          const py = cy + Math.sin(angle) * radius;
          // Draw thick point
          for (let dy = -strokeWidth / 2; dy < strokeWidth / 2; dy++) {
            for (let dx = -strokeWidth / 2; dx < strokeWidth / 2; dx++) {
              setPixel(Math.floor(px + dx), Math.floor(py + dy), 255);
            }
          }
        }
      }
    };

    // Draw filled circle
    const fillCircle = (cx: number, cy: number, r: number) => {
      for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
        for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= r + 0.5) {
            const a = dist > r - 0.5 ? (r + 0.5 - dist) * 255 : 255;
            setPixel(x, y, a);
          }
        }
      }
    };

    // === Draw Mac Mini icon ===
    // Scale from 24-unit viewBox to our 36px canvas
    const sc = s / 24;

    // Main body: rounded rectangle
    const bodyX = 2.2 * sc;
    const bodyY = 6.5 * sc;
    const bodyW = 19.6 * sc;
    const bodyH = 9.4 * sc;
    const bodyR = 1.8 * sc;
    const sw = 1.7 * sc; // stroke width

    strokeRoundedRect(bodyX, bodyY, bodyW, bodyH, bodyR, sw);

    // Stand/base: curved line beneath the body
    // Draw as a filled arc shape
    const baseY = bodyY + bodyH + 0.3 * sc;
    const baseLeft = 6.5 * sc;
    const baseRight = s - 6.5 * sc;
    const baseSag = 2.2 * sc;
    const baseStroke = 1.5 * sc;
    const baseSteps = 40;
    for (let i = 0; i <= baseSteps; i++) {
      const t = i / baseSteps;
      const x = baseLeft + (baseRight - baseLeft) * t;
      const sag = Math.sin(t * Math.PI) * baseSag;
      const py = baseY + sag;
      for (let dy = -baseStroke / 2; dy < baseStroke / 2; dy++) {
        for (let dx = -0.5; dx <= 0.5; dx++) {
          setPixel(Math.floor(x + dx), Math.floor(py + dy), 255);
        }
      }
    }

    // Indicator dots (right side of body)
    const dotR = 1.1 * sc;
    const smallDotR = 0.55 * sc;
    const dotY = 11.2 * sc;
    fillCircle(17.0 * sc, dotY, dotR);
    fillCircle(19.6 * sc, dotY, smallDotR);

    const icon = nativeImage.createFromBuffer(buffer, {
      width: s,
      height: s,
      scaleFactor: scale,
    });
    icon.setTemplateImage(true);
    return icon;
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
    const chronicleSettings = ChronicleSettingsManager.loadSettings();
    const channels = this.gateway?.getChannels() || [];
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
        const stored = repository.load<TraySettings>("tray");
        if (stored) {
          this.settings = normalizeTraySettings(stored);
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
  showNotification(title: string, body: string, taskId?: string): void {
    if (!this.settings.showNotifications) return;

    const notification = {
      id: `tray-${Date.now()}`,
      title,
      message: body,
      taskId,
    };
    if (NativeNotificationCenter.getInstance().show(notification)) {
      return;
    }

    NotificationOverlayManager.getInstance().show(notification);
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
