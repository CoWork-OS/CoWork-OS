import path from "path";
import os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  shell,
  Notification,
  nativeTheme,
} from "electron";
import mime from "mime-types";
import { DatabaseManager } from "./database/schema";
import { SecureSettingsRepository } from "./database/SecureSettingsRepository";
import {
  setupIpcHandlers,
  getHooksServer,
  getNotificationService,
  setHeartbeatWakeSubmitter,
  setHookAgentDispatchObserver,
  setHookTriggerEmitter,
} from "./ipc/handlers";
import { setupMissionControlHandlers } from "./ipc/mission-control-handlers";
import { setupPersonaTemplateHandlers } from "./ipc/persona-template-handlers";
import { setupPluginPackHandlers } from "./ipc/plugin-pack-handlers";
import { setupPluginDistributionHandlers } from "./ipc/plugin-distribution-handlers";
import { setupAdminPolicyHandlers } from "./ipc/admin-policy-handlers";
import { getPersonaTemplateService } from "./agents/PersonaTemplateService";
import { setupWorktreeHandlers } from "./ipc/worktree-handlers";
import { ComparisonService } from "./git/ComparisonService";
import { TaskSubscriptionRepository } from "./agents/TaskSubscriptionRepository";
import { StandupReportService } from "./reports/StandupReportService";
import { UsageInsightsProjector } from "./reports/UsageInsightsProjector";
import {
  HeartbeatService,
  HeartbeatServiceDeps,
  setHeartbeatService,
} from "./agents/HeartbeatService";
import { AgentRoleRepository } from "./agents/AgentRoleRepository";
import { MentionRepository } from "./agents/MentionRepository";
import { ActivityRepository } from "./activity/ActivityRepository";
import { WorkingStateRepository } from "./agents/WorkingStateRepository";
import { CrossSignalService } from "./agents/CrossSignalService";
import { FeedbackService } from "./agents/FeedbackService";
import { LoreService } from "./agents/LoreService";
import { AutomationProfileRepository } from "./agents/AutomationProfileRepository";
import { ProactiveSuggestionsService } from "./agent/ProactiveSuggestionsService";
import { AgentDaemon } from "./agent/daemon";
import { CoreMemoryCandidateRepository } from "./core/CoreMemoryCandidateRepository";
import { CoreMemoryCandidateService } from "./core/CoreMemoryCandidateService";
import { CoreMemoryDistillRunRepository } from "./core/CoreMemoryDistillRunRepository";
import { CoreMemoryDistiller } from "./core/CoreMemoryDistiller";
import { CoreEvalCaseRepository } from "./core/CoreEvalCaseRepository";
import { CoreEvalCaseService } from "./core/CoreEvalCaseService";
import { CoreFailureClusterRepository } from "./core/CoreFailureClusterRepository";
import { CoreFailureClusterService } from "./core/CoreFailureClusterService";
import { CoreFailureMiningService } from "./core/CoreFailureMiningService";
import { CoreFailureRecordRepository } from "./core/CoreFailureRecordRepository";
import { CoreHarnessExperimentRepository } from "./core/CoreHarnessExperimentRepository";
import { CoreHarnessExperimentRunner } from "./core/CoreHarnessExperimentRunner";
import { CoreHarnessExperimentService } from "./core/CoreHarnessExperimentService";
import { CoreLearningPipelineService } from "./core/CoreLearningPipelineService";
import { CoreLearningsRepository } from "./core/CoreLearningsRepository";
import { CoreLearningsService } from "./core/CoreLearningsService";
import { CoreRegressionGateRepository } from "./core/CoreRegressionGateRepository";
import { CoreRegressionGateService } from "./core/CoreRegressionGateService";
import { CoreMemoryScopeResolver } from "./core/CoreMemoryScopeResolver";
import { CoreMemoryScopeStateRepository } from "./core/CoreMemoryScopeStateRepository";
import { CoreTraceRepository } from "./core/CoreTraceRepository";
import { CoreTraceService } from "./core/CoreTraceService";
import {
  ChannelMessageRepository,
  ChannelRepository,
  ChannelUserRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "./database/repositories";
import { LLMProviderFactory } from "./agent/llm";
import { SearchProviderFactory } from "./agent/search";
import { ChannelGateway } from "./gateway";
import { formatChatTranscriptForPrompt } from "./gateway/chat-transcript";
import { updateManager } from "./updater";
import {
  importProcessEnvToSettings,
  migrateEnvToSettings,
} from "./utils/env-migration";
import {
  TEMP_WORKSPACE_ID,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  IPC_CHANNELS,
  isTempWorkspaceId,
} from "../shared/types";
import type { Task } from "../shared/types";
import { isAutomatedTaskLike } from "../shared/automated-task-detection";
import { GuardrailManager } from "./guardrails/guardrail-manager";
import { AppearanceManager } from "./settings/appearance-manager";
import { MemoryFeaturesManager } from "./settings/memory-features-manager";
import { PersonalityManager } from "./settings/personality-manager";
import { MCPClientManager } from "./mcp/client/MCPClientManager";
import { InfraManager } from "./infra/infra-manager";
import { trayManager } from "./tray";
import { CronService, setCronService, getCronStorePath } from "./cron";
import { resolveTaskResultText } from "./cron/result-text";
import {
  StrategicPlannerService,
  setStrategicPlannerService,
} from "./control-plane/StrategicPlannerService";
import { attachControlPlaneTaskLifecycleSync } from "./control-plane/task-run-sync";
import {
  buildManagedScheduledWorkspacePath,
  createScheduledRunDirectory,
  isManagedScheduledWorkspacePath,
} from "./cron/workspace-context";
import { MemoryService } from "./memory/MemoryService";
import { CuratedMemoryService } from "./memory/CuratedMemoryService";
import { ChronicleCaptureService, ChronicleMemoryService, ChronicleSettingsManager } from "./chronicle";
import { revealWindow } from "./utils/window-visibility";
import { KnowledgeGraphService } from "./knowledge-graph/KnowledgeGraphService";
import { MailboxAutomationHub } from "./mailbox/MailboxAutomationHub";
import { MailboxAutomationRegistry } from "./mailbox/MailboxAutomationRegistry";
import { MailboxForwardingService } from "./mailbox/MailboxForwardingService";
import { getMailboxServiceInstance } from "./mailbox/MailboxService";
import { setMailboxForwardingServiceInstance } from "./mailbox/mailbox-forwarding-singleton";
import {
  ControlPlaneSettingsManager,
  setupControlPlaneHandlers,
  shutdownControlPlane,
  startControlPlaneFromSettings,
} from "./control-plane";
import { sanitizeTaskMessageParams } from "./control-plane/sanitize";
import {
  getArgValue,
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldEnableControlPlaneFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
  shouldPrintControlPlaneTokenFromArgsOrEnv,
} from "./utils/runtime-mode";
import {
  getActiveProfileId,
  getUserDataDir,
  hasNonDefaultProfile,
} from "./utils/user-data-dir";
// Live Canvas feature
import {
  registerCanvasScheme,
  registerCanvasProtocol,
  CanvasManager,
} from "./canvas";
import {
  setupCanvasHandlers,
  cleanupCanvasHandlers,
} from "./ipc/canvas-handlers";
import { setupQAHandlers } from "./ipc/qa-handlers";
import { pruneTempWorkspaces } from "./utils/temp-workspace";
import { getActiveTempWorkspaceLeases } from "./utils/temp-workspace-lease";
import { getPluginRegistry } from "./extensions/registry";
import { getCustomSkillLoader } from "./agent/custom-skill-loader";
import { pruneTempSandboxProfiles } from "./utils/temp-sandbox-profiles";
// Gap features: triggers, briefing, file hub, web access
import { EventTriggerService } from "./triggers/EventTriggerService";
import { setupTriggerHandlers } from "./ipc/trigger-handlers";
import { setupRoutineHandlers } from "./ipc/routine-handlers";
import { RoutineService } from "./routines/service";
import { DailyBriefingService } from "./briefing/DailyBriefingService";
import {
  syncDailyBriefingCronJob,
  DAILY_BRIEFING_MARKER,
} from "./briefing/briefing-scheduler";
import { CouncilService } from "./council/CouncilService";
import { setCouncilService } from "./council";
import {
  readWorkspaceOpenLoops,
  readWorkspacePriorities,
} from "./briefing/workspace-briefing-context";
import { setupBriefingHandlers } from "./ipc/briefing-handlers";
import {
  setupImprovementHandlers,
  setupSubconsciousHandlers,
} from "./ipc/subconscious-handlers";
import { FileHubService } from "./file-hub/FileHubService";
import { setupFileHubHandlers } from "./ipc/file-hub-handlers";
import { HooksSettingsManager } from "./hooks/settings";
import { WebAccessServer } from "./web-server/WebAccessServer";
import {
  DEFAULT_WEB_ACCESS_CONFIG,
  type WebAccessConfig,
} from "./web-server/types";
import { setupWebAccessHandlers } from "./ipc/web-access-handlers";
import {
  ManagedAccountManager,
  type ManagedAccountStatus,
} from "./accounts/managed-account-manager";
import {
  initializeXMentionBridgeService,
  XMentionBridgeService,
} from "./x-mentions";
import { AmbientMonitoringService } from "./monitoring/AmbientMonitoringService";
import { AwarenessService } from "./awareness/AwarenessService";
import { AutonomyEngine } from "./awareness/AutonomyEngine";
import { SubconsciousLoopService } from "./subconscious/SubconsciousLoopService";
import { ManagedSessionService } from "./managed/ManagedSessionService";
import { createLogger } from "./utils/logger";
import { registerMediaProtocol, registerMediaScheme } from "./media";
import { rememberApprovedImportFiles } from "./security/file-import-approvals";
import { healMovedDesktopWorkspacePaths } from "./utils/workspace-path-healer";

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;
let cronService: CronService | null = null;
let councilService: CouncilService | null = null;
let dailyBriefingService: DailyBriefingService | null = null;
let ambientMonitoringService: AmbientMonitoringService | null = null;
let mailboxForwardingService: MailboxForwardingService | null = null;
let heartbeatService: HeartbeatService | null = null;
let awarenessService: AwarenessService | null = null;
let autonomyEngine: AutonomyEngine | null = null;
let subconsciousLoopService: SubconsciousLoopService | null = null;
let crossSignalService: CrossSignalService | null = null;
let feedbackService: FeedbackService | null = null;
let loreService: LoreService | null = null;
let xMentionBridgeService: XMentionBridgeService | null = null;
let strategicPlannerService: StrategicPlannerService | null = null;
let eventTriggerService: EventTriggerService | null = null;
let routineService: RoutineService | null = null;
let coreTraceService: CoreTraceService | null = null;
let coreMemoryCandidateService: CoreMemoryCandidateService | null = null;
let coreMemoryDistiller: CoreMemoryDistiller | null = null;
let coreFailureMiningService: CoreFailureMiningService | null = null;
let coreFailureClusterService: CoreFailureClusterService | null = null;
let coreEvalCaseService: CoreEvalCaseService | null = null;
let coreHarnessExperimentService: CoreHarnessExperimentService | null = null;
let coreHarnessExperimentRunner: CoreHarnessExperimentRunner | null = null;
let coreLearningsService: CoreLearningsService | null = null;
let coreLearningPipelineService: CoreLearningPipelineService | null = null;
let detachTaskLifecycleSync: (() => void) | null = null;
let tempWorkspacePruneTimer: NodeJS.Timeout | null = null;
let tempSandboxProfilePruneTimer: NodeJS.Timeout | null = null;
let coreMemoryDistillTimer: NodeJS.Timeout | null = null;
const TEMP_WORKSPACE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEMP_SANDBOX_PROFILE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const managedBriefingRuns = new Map<
  string,
  {
    text: string;
    delivered: boolean;
    generatedAt: number;
  }
>();

const HEADLESS = isHeadlessMode();
const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();
const logger = createLogger("Main");
const TRANSIENT_MAIN_PROCESS_ERROR_RE =
  /(ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|Timed Out|Connection Closed)/i;
let processErrorGuardsInstalled = false;
const STARTER_AUTOMATION_ROLE_NAMES = ["assistant", "project_manager"];

function normalizeTwinCoreBoundary(): void {
  const db = dbManager.getDatabase();
  const twinRoles = db
    .prepare(
      `SELECT id
       FROM agent_roles
       WHERE COALESCE(source_template_id, '') != ''
          OR name LIKE 'twin-%'
          OR display_name LIKE '%Twin%'`,
    )
    .all() as Array<{ id?: string }>;

  const roleIds = twinRoles
    .map((row) => (typeof row.id === "string" ? row.id : ""))
    .filter(Boolean);
  if (!roleIds.length) {
    return;
  }

  const placeholders = roleIds.map(() => "?").join(", ");
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE agent_roles
       SET role_kind = 'persona_template',
           heartbeat_enabled = 0,
           heartbeat_status = 'idle',
           heartbeat_last_pulse_result = NULL,
           heartbeat_last_dispatch_kind = NULL,
           updated_at = ?
       WHERE id IN (${placeholders})`,
    ).run(Date.now(), ...roleIds);

    db.prepare(
      `UPDATE automation_profiles
       SET enabled = 0,
           updated_at = ?
       WHERE agent_role_id IN (${placeholders})`,
    ).run(Date.now(), ...roleIds);

    db.prepare(
      `DELETE FROM heartbeat_policies
       WHERE agent_role_id IN (${placeholders})`,
    ).run(...roleIds);

    db.prepare(
      `DELETE FROM subconscious_dispatch_records
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_backlog_items
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_decisions
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_critiques
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_hypotheses
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_runs
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));
    db.prepare(
      `DELETE FROM subconscious_targets
       WHERE target_key IN (${placeholders})`,
    ).run(...roleIds.map((id) => `agent_role:${id}`));

    db.exec("COMMIT");
    logger.info("Normalized Twin roles out of core cognition ownership", {
      roleCount: roleIds.length,
    });
  } catch (error) {
    db.exec("ROLLBACK");
    logger.error("Failed to normalize Twin cognition ownership:", error);
  }
}

function buildDefaultAutomationProfile(role: import("../shared/types").AgentRole): {
  enabled: boolean;
  cadenceMinutes: number;
  staggerOffsetMinutes: number;
  dispatchCooldownMinutes: number;
  maxDispatchesPerDay: number;
  profile: import("../shared/types").HeartbeatProfile;
  activeHours?: import("../shared/types").HeartbeatActiveHours;
} {
  const isStarter = STARTER_AUTOMATION_ROLE_NAMES.includes(role.name);
  if (role.name === "project_manager") {
    return {
      enabled: true,
      cadenceMinutes: 20,
      staggerOffsetMinutes: 0,
      dispatchCooldownMinutes: 90,
      maxDispatchesPerDay: 4,
      profile: "dispatcher",
      activeHours: role.activeHours,
    };
  }
  if (role.name === "assistant") {
    return {
      enabled: true,
      cadenceMinutes: 30,
      staggerOffsetMinutes: 5,
      dispatchCooldownMinutes: 180,
      maxDispatchesPerDay: 3,
      profile: "observer",
      activeHours: role.activeHours,
    };
  }
  return {
    enabled: false,
    cadenceMinutes:
      role.pulseEveryMinutes || role.heartbeatIntervalMinutes || (role.autonomyLevel === "lead" ? 20 : 30),
    staggerOffsetMinutes: role.heartbeatStaggerOffset || 0,
    dispatchCooldownMinutes: role.dispatchCooldownMinutes || (role.autonomyLevel === "lead" ? 90 : 120),
    maxDispatchesPerDay: role.maxDispatchesPerDay || (role.autonomyLevel === "lead" ? 6 : 4),
    profile: role.heartbeatProfile || (role.autonomyLevel === "lead" ? "dispatcher" : "observer"),
    activeHours: role.activeHours,
  };
}

function ensureCoreAutomationProfiles(): void {
  const db = dbManager.getDatabase();
  const agentRoleRepo = new AgentRoleRepository(db);
  const automationProfileRepo = new AutomationProfileRepository(db);

  const addedAgents = agentRoleRepo.syncNewDefaults();
  if (addedAgents.length > 0) {
    logger.info(`Added ${addedAgents.length} new default agent(s)`);
  }

  const eligibleRoles = agentRoleRepo
    .findAll(false)
    .filter(
      (role) =>
        role.roleKind !== "persona_template" &&
        (role.roleKind === "system" || role.roleKind === "custom"),
    );
  if (!eligibleRoles.length) {
    return;
  }

  const existingProfiles = new Map(
    automationProfileRepo.listAll().map((profile) => [profile.agentRoleId, profile]),
  );

  let createdCount = 0;
  for (const role of eligibleRoles) {
    if (existingProfiles.has(role.id)) {
      continue;
    }
    const seeded = buildDefaultAutomationProfile(role);
    const created = automationProfileRepo.create({
      agentRoleId: role.id,
      enabled: seeded.enabled,
      cadenceMinutes: seeded.cadenceMinutes,
      staggerOffsetMinutes: seeded.staggerOffsetMinutes,
      dispatchCooldownMinutes: seeded.dispatchCooldownMinutes,
      maxDispatchesPerDay: seeded.maxDispatchesPerDay,
      profile: seeded.profile,
      activeHours: seeded.activeHours,
    });
    existingProfiles.set(role.id, created);
    createdCount += 1;
  }

  const enabledEligibleProfiles = automationProfileRepo
    .listEnabled()
    .filter((profile) => eligibleRoles.some((role) => role.id === profile.agentRoleId));

  if (enabledEligibleProfiles.length === 0) {
    const starterRoles = eligibleRoles.filter((role) =>
      STARTER_AUTOMATION_ROLE_NAMES.includes(role.name),
    );
    const fallbackRoles = starterRoles.length ? starterRoles : eligibleRoles.slice(0, 1);
    for (const role of fallbackRoles) {
      const seeded = buildDefaultAutomationProfile(role);
      const existing = existingProfiles.get(role.id);
      if (!existing) continue;
      automationProfileRepo.update({
        id: existing.id,
        enabled: true,
        cadenceMinutes: seeded.cadenceMinutes,
        staggerOffsetMinutes: seeded.staggerOffsetMinutes,
        dispatchCooldownMinutes: seeded.dispatchCooldownMinutes,
        maxDispatchesPerDay: seeded.maxDispatchesPerDay,
        profile: seeded.profile,
        activeHours: seeded.activeHours,
      });
    }
  }

  const totalProfiles = automationProfileRepo.listAll();
  const enabledProfiles = totalProfiles.filter((profile) => profile.enabled);
  logger.info("Core automation profiles ready", {
    eligibleRoleCount: eligibleRoles.length,
    profileCount: totalProfiles.length,
    enabledProfileCount: enabledProfiles.length,
    createdCount,
    enabledRoles: enabledProfiles
      .map((profile) => agentRoleRepo.findById(profile.agentRoleId)?.name || profile.agentRoleId)
      .slice(0, 10),
  });
}

function isAllowedWebviewUrl(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  if (raw === "about:blank") {
    return true;
  }

  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "canvas:"
    );
  } catch {
    return false;
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
    delete (webPreferences as Record<string, unknown>).preloadURL;
    delete (webPreferences as Record<string, unknown>).additionalArguments;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;

    if (params) {
      delete (params as Record<string, unknown>).preload;
      delete (params as Record<string, unknown>).preloadURL;
      delete (params as Record<string, unknown>).allowpopups;
    }

    const targetUrl = typeof params?.src === "string" ? params.src : "";
    if (!isAllowedWebviewUrl(targetUrl)) {
      logger.warn(
        `Blocked webview attachment for disallowed URL: ${
          targetUrl || "<empty>"
        }`,
      );
      event.preventDefault();
    }
  });
});

const submitHeartbeatSignalForAll = (input: {
  text?: string;
  mode?: "now" | "next-heartbeat";
  source?: "hook" | "cron" | "api" | "manual";
}): void => {
  heartbeatService?.submitWakeForAll(input);
};

function getDevServerUrl(): string {
  const configured = String(process.env.COWORK_DEV_SERVER_URL || "").trim();
  if (configured.length > 0) {
    return configured;
  }

  const port =
    String(process.env.COWORK_DEV_SERVER_PORT || "5173").trim() || "5173";
  return `http://127.0.0.1:${port}`;
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// WebSocket close codes that are transient network events, not bugs.
// 1006 = abnormal closure (connection dropped without close frame, common in WhatsApp Web reconnects).
const TRANSIENT_WS_CLOSE_CODES = new Set([1006]);

function isTransientMainProcessError(reason: unknown): boolean {
  if (typeof reason === "number" && TRANSIENT_WS_CLOSE_CODES.has(reason)) {
    return true;
  }
  return TRANSIENT_MAIN_PROCESS_ERROR_RE.test(toErrorMessage(reason));
}

function installProcessErrorGuards(): void {
  if (processErrorGuardsInstalled) {
    return;
  }
  processErrorGuardsInstalled = true;

  process.on("unhandledRejection", (reason) => {
    if (isTransientMainProcessError(reason)) {
      logger.warn(
        `Suppressed transient unhandledRejection: ${toErrorMessage(reason)}`,
      );
      return;
    }
    logger.error("unhandledRejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    if (isTransientMainProcessError(error)) {
      logger.warn(
        `Suppressed transient uncaughtException: ${toErrorMessage(error)}`,
      );
      return;
    }
    logger.error("uncaughtException:", error);
  });
}

installProcessErrorGuards();

// Use the OS certificate store so Node.js TLS connections (e.g. WhatsApp WebSocket)
// can verify certificates issued by system-trusted CAs
app.commandLine.appendSwitch("use-system-cert-store");

// Suppress GPU-related Chromium errors that occur with transparent windows and vibrancy
// These are cosmetic errors that don't affect functionality
app.commandLine.appendSwitch("disable-gpu-driver-bug-workarounds");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// Register canvas:// protocol scheme (must be called before app.ready)
registerCanvasScheme();
registerMediaScheme();

// Ensure only one CoWork OS instance runs at a time.
// Without this, a second instance can mark in-flight tasks as "orphaned" (failed) and contend on the DB.
const gotTheLock = app.requestSingleInstanceLock();

const ACTIVE_FOREGROUND_TASK_STATUSES = new Set<Task["status"]>([
  "pending",
  "queued",
  "planning",
  "executing",
  "interrupted",
  "paused",
  "blocked",
]);

function isForegroundUserTask(task: Task): boolean {
  if (!ACTIVE_FOREGROUND_TASK_STATUSES.has(task.status)) return false;
  if (isAutomatedTaskLike(task)) return false;
  const source = task.source || "manual";
  return source === "manual" || source === "api";
}
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (HEADLESS) return;
    // Focus the existing window instead of starting a second instance.
    if (revealWindow(mainWindow)) {
      return;
    }
    // If the window was closed (but app kept running), recreate it.
    createWindow();
  });

  function createWindow() {
    const isMac = process.platform === "darwin";
    let useMacVibrancy = isMac && !nativeTheme.prefersReducedTransparency;

    // Determine initial background color when the window should be opaque.
    let windowBgColor = "#1a1a1c";
    try {
      const saved = AppearanceManager.loadSettings();
      if (isMac && saved.transparencyEffectsEnabled === false) {
        useMacVibrancy = false;
      }
      const mode = saved.themeMode || "dark";
      const isLight =
        mode === "light" ||
        (mode === "system" && nativeTheme.shouldUseDarkColors === false);
      if (isLight) windowBgColor = "#f0f0f2";
    } catch {
      // Fallback to dark if settings aren't available yet
    }

    mainWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1200,
      minHeight: 800,
      center: true,
      titleBarStyle: isMac ? "hiddenInset" : "hidden",
      ...(useMacVibrancy
        ? {
            vibrancy: "under-window" as const,
            visualEffectState: "active" as const,
            transparent: true,
            backgroundColor: "#00000000",
          }
        : {
            transparent: false,
            backgroundColor: windowBgColor,
          }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Preload needs Node built-ins (path/fs/os/crypto)
        webviewTag: true, // Enable webview for canvas interactive mode
        preload: path.join(__dirname, "preload.js"),
      },
    });

    // Load the app
    if (process.env.NODE_ENV === "development") {
      mainWindow.loadURL(getDevServerUrl());
      mainWindow.webContents.openDevTools();
    } else {
      const rendererDir = path.join(__dirname, "../../renderer");
      const rendererIndex = path.join(rendererDir, "index.html");

      if (!fsSync.existsSync(rendererIndex)) {
        console.error(
          `[Main] Renderer entry not found: ${rendererIndex}. ` +
            "The installed package is missing UI assets.",
        );
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoWork OS - Installation Error</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; background: #111215; color: #f3f4f6; }
    .wrap { max-width: 760px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #d1d5db; line-height: 1.6; }
    pre { background: #0a0a0c; border: 1px solid #27272a; padding: 12px; overflow-x: auto; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CoWork OS could not load UI assets</h1>
    <p>The installed npm package is missing <code>dist/renderer/index.html</code>.</p>
    <p>Reinstall the latest release, or ask the maintainer to republish with built renderer assets.</p>
    <pre>${rendererIndex}</pre>
  </div>
</body>
</html>`;
        mainWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
        );
      } else {
        mainWindow.loadFile(rendererIndex);
      }
    }

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    mainWindow.webContents.on("did-finish-load", () => {});

    mainWindow.webContents.on("render-process-gone", (_event, details) => {});

    // Open external links in the system browser instead of inside the app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Open all new window requests in external browser
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
      // Allow navigation to the app itself (dev server or file://), block external URLs
      const appUrl =
        process.env.NODE_ENV === "development"
          ? getDevServerUrl()
          : `file://${path.join(__dirname, "../../renderer")}`;

      if (!url.startsWith(appUrl)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  }

  app.whenReady().then(async () => {
    const startupStartedAt = Date.now();
    const logPhase = (name: string, phaseStartedAt: number): void => {
      logger.debug(
        `Startup phase "${name}" completed in ${Date.now() - phaseStartedAt} ms`,
      );
    };
    let mcpStartupSummary = {
      enabled: 0,
      attempted: 0,
      connected: 0,
      failed: 0,
    };
    let pluginStartupSummary = { loaded: 0, enabled: 0 };

    const resolvedUserDataDir = getUserDataDir();
    const activeProfileId = getActiveProfileId();
    const defaultUserDataDir = app.getPath("userData");
    if (
      path.resolve(defaultUserDataDir) !== path.resolve(resolvedUserDataDir)
    ) {
      try {
        await fs.mkdir(resolvedUserDataDir, { recursive: true });
        app.setPath("userData", resolvedUserDataDir);
        logger.info(`Using userData directory: ${resolvedUserDataDir}`);
      } catch (error) {
        logger.warn("Failed to apply userData directory:", error);
      }
    }
    if (hasNonDefaultProfile()) {
      logger.info(`Active profile: ${activeProfileId}`);
    }

    // Set up Content Security Policy for production builds
    if (process.env.NODE_ENV !== "development") {
      const appRoot = pathToFileURL(
        path.join(__dirname, "../../renderer"),
      ).toString();
      session.defaultSession.webRequest.onHeadersReceived(
        (details, callback) => {
          if (!details.url.startsWith(appRoot)) {
            callback({ responseHeaders: details.responseHeaders });
            return;
          }
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [
                "default-src 'self'; " +
                  "script-src 'self'; " +
                  "style-src 'self' 'unsafe-inline'; " + // Allow inline styles for React
                  "img-src 'self' data: https:; " + // Allow images from self, data URIs, and HTTPS
                  "font-src 'self' data:; " + // Allow fonts from self and data URIs
                  "connect-src 'self' https:; " + // Allow API calls to HTTPS endpoints
                  "media-src 'self' data: blob: media: https:; " + // Allow inline video previews via blob/data URLs and the media:// protocol
                  "worker-src 'self' blob:; " + // Allow web workers from blob URLs
                  "frame-ancestors 'none'; " + // Prevent embedding in iframes
                  "form-action 'self';", // Restrict form submissions
              ],
            },
          });
        },
      );
    }

    // Initialize database first - required for SecureSettingsRepository
    const coreInitStartedAt = Date.now();
    dbManager = new DatabaseManager();
    UsageInsightsProjector.initialize(dbManager.getDatabase()).warm();
    const tempWorkspaceRoot = path.join(
      os.tmpdir(),
      TEMP_WORKSPACE_ROOT_DIR_NAME,
    );
    const runTempWorkspacePrune = () => {
      try {
        pruneTempWorkspaces({
          db: dbManager.getDatabase(),
          tempWorkspaceRoot,
          protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
        });
      } catch (error) {
        logger.warn("Failed to prune temp workspaces:", error);
      }
    };
    runTempWorkspacePrune();
    tempWorkspacePruneTimer = setInterval(
      runTempWorkspacePrune,
      TEMP_WORKSPACE_PRUNE_INTERVAL_MS,
    );
    tempWorkspacePruneTimer.unref();
    const runTempSandboxProfilePrune = () => {
      try {
        pruneTempSandboxProfiles();
      } catch (error) {
        logger.warn("Failed to prune temp sandbox profiles:", error);
      }
    };
    runTempSandboxProfilePrune();
    tempSandboxProfilePruneTimer = setInterval(
      runTempSandboxProfilePrune,
      TEMP_SANDBOX_PROFILE_PRUNE_INTERVAL_MS,
    );
    tempSandboxProfilePruneTimer.unref();

    // Initialize secure settings repository for encrypted settings storage
    // This MUST be done before provider factories so they can migrate legacy settings
    new SecureSettingsRepository(dbManager.getDatabase());
    logger.info("SecureSettingsRepository initialized");
    {
      const workspaceRepo = new WorkspaceRepository(dbManager.getDatabase());
      const repairs = healMovedDesktopWorkspacePaths(
        workspaceRepo.findAll(),
        (workspaceId, nextPath) => workspaceRepo.updatePath(workspaceId, nextPath),
        {
          log: (message, meta) => logger.info(message, meta),
        },
      );
      if (repairs.length) {
        logger.info("Healed moved workspace paths.", {
          repairedCount: repairs.length,
          repairs: repairs.map((item) => ({
            workspaceId: item.workspaceId,
            oldPath: item.oldPath,
            newPath: item.newPath,
          })),
        });
      }
    }
    normalizeTwinCoreBoundary();
    ensureCoreAutomationProfiles();
    try {
      const db = dbManager.getDatabase();
      const automationProfileRepo = new AutomationProfileRepository(db);
      const coreTraceRepo = new CoreTraceRepository(db);
      const coreMemoryCandidateRepo = new CoreMemoryCandidateRepository(db);
      const coreMemoryDistillRunRepo = new CoreMemoryDistillRunRepository(db);
      const coreMemoryScopeStateRepo = new CoreMemoryScopeStateRepository(db);
      const coreFailureRecordRepo = new CoreFailureRecordRepository(db);
      const coreFailureClusterRepo = new CoreFailureClusterRepository(db);
      const coreEvalCaseRepo = new CoreEvalCaseRepository(db);
      const coreHarnessExperimentRepo = new CoreHarnessExperimentRepository(db);
      const coreRegressionGateRepo = new CoreRegressionGateRepository(db);
      const coreLearningsRepo = new CoreLearningsRepository(db);
      const coreMemoryScopeResolver = new CoreMemoryScopeResolver();
      coreTraceService = new CoreTraceService(coreTraceRepo, coreMemoryCandidateRepo);
      coreMemoryCandidateService = new CoreMemoryCandidateService(
        coreTraceRepo,
        coreMemoryCandidateRepo,
        coreMemoryScopeResolver,
      );
      coreMemoryDistiller = new CoreMemoryDistiller(
        coreTraceRepo,
        coreMemoryCandidateRepo,
        coreMemoryDistillRunRepo,
        coreMemoryScopeStateRepo,
        automationProfileRepo,
        new WorkspaceRepository(db),
        coreMemoryScopeResolver,
      );
      coreFailureMiningService = new CoreFailureMiningService(coreTraceRepo, coreFailureRecordRepo);
      coreFailureClusterService = new CoreFailureClusterService(
        coreFailureRecordRepo,
        coreFailureClusterRepo,
      );
      coreEvalCaseService = new CoreEvalCaseService(coreFailureClusterRepo, coreEvalCaseRepo);
      coreLearningsService = new CoreLearningsService(coreLearningsRepo);
      coreHarnessExperimentService = new CoreHarnessExperimentService(
        coreFailureClusterRepo,
        coreHarnessExperimentRepo,
        automationProfileRepo,
      );
      const coreRegressionGateService = new CoreRegressionGateService(coreRegressionGateRepo);
      coreHarnessExperimentRunner = new CoreHarnessExperimentRunner(
        coreHarnessExperimentRepo,
        coreHarnessExperimentService,
        coreFailureClusterRepo,
        coreEvalCaseRepo,
        automationProfileRepo,
        coreRegressionGateService,
        coreLearningsService,
      );
      coreLearningPipelineService = new CoreLearningPipelineService(
        coreFailureMiningService,
        coreFailureClusterService,
        coreEvalCaseService,
        coreHarnessExperimentService,
        coreLearningsService,
      );
      logger.info("Core trace services initialized");
    } catch (error) {
      logger.error("Failed to initialize core trace services:", error);
    }

    // Initialize provider factories (loads settings from disk, migrates legacy files)
    LLMProviderFactory.initialize();
    SearchProviderFactory.initialize();
    GuardrailManager.initialize();
    AppearanceManager.initialize();
    PersonalityManager.initialize();
    MemoryFeaturesManager.initialize();
    logPhase("core-init", coreInitStartedAt);

    // Migrate .env configuration to Settings (one-time upgrade path)
    const migrationResult = await migrateEnvToSettings();

    // Optional: import process.env keys into Settings (explicit opt-in; useful for headless/server deployments).
    if (IMPORT_ENV_SETTINGS) {
      const importResult = await importProcessEnvToSettings({
        mode: IMPORT_ENV_SETTINGS_MODE,
      });
      if (importResult.migrated && importResult.migratedKeys.length > 0) {
        logger.info(
          `Imported credentials from process.env (${IMPORT_ENV_SETTINGS_MODE}): ${importResult.migratedKeys.join(", ")}`,
        );
      }
      if (importResult.error) {
        logger.warn(
          "Failed to import credentials from process.env:",
          importResult.error,
        );
      }
    }

    // Headless deployments commonly forget to configure LLM creds; warn early with a concrete next step.
    if (HEADLESS) {
      try {
        const llmSettings = LLMProviderFactory.loadSettings();
        const hasAnyLlmCreds = !!(
          llmSettings?.anthropic?.apiKey ||
          llmSettings?.anthropic?.subscriptionToken ||
          llmSettings?.openai?.apiKey ||
          llmSettings?.openai?.accessToken ||
          llmSettings?.gemini?.apiKey ||
          llmSettings?.openrouter?.apiKey ||
          llmSettings?.groq?.apiKey ||
          llmSettings?.xai?.apiKey ||
          llmSettings?.kimi?.apiKey ||
          llmSettings?.azure?.apiKey ||
          llmSettings?.bedrock?.accessKeyId ||
          llmSettings?.bedrock?.profile
        );
        if (!hasAnyLlmCreds) {
          logger.warn(
            "No LLM credentials configured. In headless mode, set COWORK_IMPORT_ENV_SETTINGS=1 and an LLM key (e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY), then restart.",
          );
        }
      } catch (error) {
        logger.warn("Failed to check LLM credential configuration:", error);
      }
    }

    // Initialize Memory Service before queue recovery starts. AgentDaemon.initialize()
    // can immediately resume queued tasks, and their early timeline events capture to memory.
    try {
      MemoryService.initialize(dbManager);
      CuratedMemoryService.initialize(dbManager);
      logger.info("Memory Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Memory Service:", error);
      // Don't fail app startup if memory init fails
    }

    try {
      const chronicleSettings = ChronicleSettingsManager.loadSettings();
      await ChronicleCaptureService.getInstance().applySettings(chronicleSettings);
      ChronicleMemoryService.getInstance().applySettings(chronicleSettings);
      logger.info(
        `Chronicle initialized (enabled=${chronicleSettings.enabled}, mode=${chronicleSettings.mode})`,
      );
    } catch (error) {
      logger.warn("Failed to initialize Chronicle:", error);
    }

    // Initialize agent daemon
    agentDaemon = new AgentDaemon(dbManager);
    await agentDaemon.initialize();
    detachTaskLifecycleSync = attachControlPlaneTaskLifecycleSync({
      agentDaemon,
      db: dbManager.getDatabase(),
      log: (...args) => logger.warn(...args),
    });

    // Optional: bootstrap a default workspace on startup for headless/server deployments.
    // This makes a fresh VPS instance usable without first opening the desktop UI.
    try {
      const bootstrapPathRaw =
        process.env.COWORK_BOOTSTRAP_WORKSPACE_PATH ||
        getArgValue("--bootstrap-workspace");
      if (
        bootstrapPathRaw &&
        typeof bootstrapPathRaw === "string" &&
        bootstrapPathRaw.trim().length > 0
      ) {
        const raw = bootstrapPathRaw.trim();
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const expanded =
          raw.startsWith("~/") && homeDir
            ? path.join(homeDir, raw.slice(2))
            : raw;
        const workspacePath = path.resolve(expanded);
        await fs.mkdir(workspacePath, { recursive: true });

        const existing = agentDaemon.getWorkspaceByPath(workspacePath);
        if (!existing) {
          const nameFromEnv =
            process.env.COWORK_BOOTSTRAP_WORKSPACE_NAME ||
            getArgValue("--bootstrap-workspace-name");
          const workspaceName =
            typeof nameFromEnv === "string" && nameFromEnv.trim().length > 0
              ? nameFromEnv.trim()
              : path.basename(workspacePath) || "Workspace";

          const ws = agentDaemon.createWorkspace(workspaceName, workspacePath);
          logger.info(
            `Bootstrapped workspace: ${ws.id} (${ws.name}) at ${ws.path}`,
          );
        } else {
          logger.info(
            `Bootstrap workspace exists: ${existing.id} (${existing.name}) at ${existing.path}`,
          );
        }
      }
    } catch (error) {
      logger.warn("Failed to bootstrap workspace:", error);
    }

    // Initialize cross-agent signal tracker (best-effort; do not block app startup)
    try {
      crossSignalService = new CrossSignalService(dbManager.getDatabase());
      await crossSignalService.start(agentDaemon);
      logger.info("CrossSignalService initialized");
    } catch (error) {
      logger.error("Failed to initialize CrossSignalService:", error);
    }

    // Initialize feedback logger (best-effort; persists approve/reject/edit/next into workspace kit files)
    try {
      feedbackService = new FeedbackService(dbManager.getDatabase());
      await feedbackService.start(agentDaemon);
      logger.info("FeedbackService initialized");
    } catch (error) {
      logger.error("Failed to initialize FeedbackService:", error);
    }

    // Initialize lore service (best-effort; auto-records workspace history from task completions)
    try {
      loreService = new LoreService(dbManager.getDatabase());
      await loreService.start(agentDaemon);
      logger.info("LoreService initialized");
    } catch (error) {
      logger.error("Failed to initialize LoreService:", error);
    }

    try {
      subconsciousLoopService = new SubconsciousLoopService(
        dbManager.getDatabase(),
        {
          notify: async ({ type, title, message, taskId, workspaceId }) => {
            const notificationService = getNotificationService();
            if (notificationService) {
              try {
                await notificationService.add({
                  type,
                  title,
                  message,
                  taskId,
                  workspaceId,
                });
              } catch (error) {
                console.error(
                  "[Main] Failed to add subconscious notification:",
                  error,
                );
              }
            }
            try {
              trayManager.showNotification(title, message, taskId);
            } catch (error) {
              console.error(
                "[Main] Failed to show subconscious desktop notification:",
                error,
              );
            }
          },
          isUserFocused: () => BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
          getTriggerService: () => eventTriggerService,
          getGlobalRoot: () => getUserDataDir(),
          automationProfileRepo: new AutomationProfileRepository(
            dbManager.getDatabase(),
          ),
          coreTraceService: coreTraceService || undefined,
          coreMemoryCandidateService: coreMemoryCandidateService || undefined,
          coreMemoryDistiller: coreMemoryDistiller || undefined,
          coreLearningPipelineService: coreLearningPipelineService || undefined,
        },
      );
      await subconsciousLoopService.start(agentDaemon);
      logger.info("SubconsciousLoopService initialized");
    } catch (error) {
      logger.error("Failed to initialize SubconsciousLoopService:", error);
    }

    // Initialize Knowledge Graph Service for structured entity/relationship memory
    try {
      KnowledgeGraphService.initialize(dbManager.getDatabase());
      logger.info("Knowledge Graph Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Knowledge Graph Service:", error);
      // Don't fail app startup if KG init fails
    }

    // Initialize MCP Client Manager - auto-connects enabled servers on startup
    try {
      const mcpInitStartedAt = Date.now();
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.initialize();
      mcpStartupSummary = mcpClientManager.getStartupStats();
      logger.info(
        `MCP summary: enabled=${mcpStartupSummary.enabled}, attempted=${mcpStartupSummary.attempted}, connected=${mcpStartupSummary.connected}, failed=${mcpStartupSummary.failed}`,
      );
      logger.info("MCP Client Manager initialized");
      logPhase("mcp-init", mcpInitStartedAt);
    } catch (error) {
      logger.error("Failed to initialize MCP Client Manager:", error);
      // Don't fail app startup if MCP init fails
    }

    // Initialize Infrastructure Manager - restores wallet, configures providers
    try {
      await InfraManager.getInstance().initialize();
      logger.info("InfraManager initialized");
    } catch (error) {
      logger.error("Failed to initialize InfraManager:", error);
      // Don't fail app startup if infra init fails
    }

    try {
      councilService = new CouncilService({
        db: dbManager.getDatabase(),
        getCronService: () => cronService,
        getNotificationService: () => getNotificationService(),
        deliverToChannel: async (params) => {
          if (!channelGateway) {
            throw new Error(
              "Cannot deliver council memo - gateway not initialized",
            );
          }
          let resolvedType = params.channelType as string;
          if (params.channelDbId) {
            const ch = channelGateway.getChannel(params.channelDbId);
            if (ch) resolvedType = ch.type;
          }
          await channelGateway.sendMessage(
            resolvedType as Any,
            params.channelId,
            params.message,
            {
              parseMode: "markdown",
              idempotencyKey: params.idempotencyKey,
            },
          );
        },
      });
      setCouncilService(councilService);
    } catch (error) {
      logger.error("Failed to initialize Council Service:", error);
    }

    // Initialize Cron Service for scheduled task execution
    try {
      const db = dbManager.getDatabase();
      const taskRepo = new TaskRepository(db);
      const taskEventRepo = new TaskEventRepository(db);
      const channelRepo = new ChannelRepository(db);
      const channelUserRepo = new ChannelUserRepository(db);
      const channelMessageRepo = new ChannelMessageRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);
      const userDataDir = getUserDataDir();

      const ensureManagedWorkspaceForCronJob = async (
        job: { id: string; name: string },
        nowMs: number,
      ) => {
        const managedPath = buildManagedScheduledWorkspacePath(
          userDataDir,
          job.name,
          job.id,
        );
        await fs.mkdir(managedPath, { recursive: true });

        let workspace = workspaceRepo.findByPath(managedPath);
        if (!workspace) {
          workspace = agentDaemon.createWorkspace(
            `Scheduled: ${job.name}`.trim(),
            managedPath,
          );
        } else {
          workspaceRepo.updateLastUsedAt(workspace.id, nowMs);
        }

        return workspace;
      };

      cronService = new CronService({
        cronEnabled: true,
        storePath: getCronStorePath(),
        maxConcurrentRuns: 3, // Allow up to 3 concurrent jobs
        // Webhook configuration (disabled by default, can be enabled in settings)
        webhook: {
          enabled: false, // Set to true to enable webhook triggers
          port: 9876,
          host: "127.0.0.1",
          // secret: 'your-secret-here', // Uncomment and set for secure webhooks
        },
        resolveWorkspaceContext: async ({ job, nowMs, phase }) => {
          let workspace = workspaceRepo.findById(job.workspaceId);

          const needsManagedWorkspace =
            !workspace || workspace.isTemp || isTempWorkspaceId(workspace.id);
          if (!workspace) {
            return null;
          }

          if (needsManagedWorkspace) {
            workspace = await ensureManagedWorkspaceForCronJob(job, nowMs);
            if (!workspace) {
              return null;
            }
          } else {
            workspaceRepo.updateLastUsedAt(workspace.id, nowMs);
          }

          const managedWorkspace = isManagedScheduledWorkspacePath(
            workspace.path,
            userDataDir,
          );
          if (phase === "run" && managedWorkspace) {
            let runDirectory: ReturnType<
              typeof createScheduledRunDirectory
            > | null = null;
            try {
              runDirectory = createScheduledRunDirectory(workspace.path, {
                nowMs,
              });
            } catch (error) {
              console.warn(
                `[Cron] Failed to prepare run directory for job "${job.name}" (${job.id})`,
                error,
              );
            }
            if (runDirectory) {
              return {
                workspaceId: workspace.id,
                workspacePath: workspace.path,
                runWorkspacePath: runDirectory.path,
                runWorkspaceRelativePath: runDirectory.relativePath,
              };
            }
          }

          return {
            workspaceId: workspace.id,
            workspacePath: workspace.path,
          };
        },
        createTask: async (params) => {
          const isManagedBriefing =
            params.title.startsWith("Daily Briefing:") ||
            params.prompt.includes(DAILY_BRIEFING_MARKER);
          if (isManagedBriefing && dailyBriefingService) {
            const briefing = await dailyBriefingService.generateBriefing(
              params.workspaceId,
            );
            const text = dailyBriefingService.renderBriefingAsText(briefing);
            const syntheticTaskId = `briefing:${randomUUID()}`;
            managedBriefingRuns.set(syntheticTaskId, {
              text,
              delivered: briefing.delivered,
              generatedAt: briefing.generatedAt,
            });
            return { id: syntheticTaskId };
          }
          let preparedCouncilTask = null;
          if (councilService) {
            try {
              preparedCouncilTask = await councilService.prepareTaskForTrigger(
                params.prompt,
                params.workspaceId,
              );
            } catch (err) {
              console.error(
                "[Council] Failed to prepare council task trigger:",
                err,
              );
            }
          }
          if (preparedCouncilTask) {
            const task = await agentDaemon.createTask({
              title: preparedCouncilTask.title,
              prompt: preparedCouncilTask.prompt,
              workspaceId: preparedCouncilTask.workspaceId,
              agentConfig: preparedCouncilTask.agentConfig,
              source: "cron",
            });
            councilService?.bindRunTask(preparedCouncilTask.runId, task.id);
            return { id: task.id };
          }
          const allowUserInput = params.allowUserInput ?? false;
          const mergedAgentConfig = {
            ...(params.agentConfig ? params.agentConfig : {}),
            ...(params.modelKey ? { modelKey: params.modelKey } : {}),
            allowUserInput,
          };
          const task = await agentDaemon.createTask({
            title: params.title,
            prompt: params.prompt,
            workspaceId: params.workspaceId,
            agentConfig: mergedAgentConfig,
            source: "cron",
          });
          return { id: task.id };
        },
        resolveTemplateVariables: async ({
          job,
          runAtMs,
          prevRunAtMs,
        }): Promise<Record<string, string>> => {
          const template =
            typeof job?.taskPrompt === "string" ? job.taskPrompt : "";
          const wantsChatVars =
            template.includes("{{chat_messages}}") ||
            template.includes("{{chat_since}}") ||
            template.includes("{{chat_until}}") ||
            template.includes("{{chat_message_count}}") ||
            template.includes("{{chat_truncated}}");
          if (!wantsChatVars) return {};

          const chatContext =
            job.chatContext ||
            (job.delivery?.channelType && job.delivery?.channelId
              ? {
                  channelType: job.delivery.channelType,
                  channelId: job.delivery.channelId,
                }
              : null);
          const channelType = chatContext?.channelType;
          const chatId = chatContext?.channelId;
          if (!channelType || !chatId) return {};

          const channel = channelRepo.findByType(channelType);
          if (!channel) return {};

          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
          const sinceMs = Math.max(
            0,
            Number.isFinite(prevRunAtMs) ? prevRunAtMs! : runAtMs - sevenDaysMs,
          );

          // Fetch a bounded window; formatting further caps message count/size.
          const raw = channelMessageRepo.findByChatId(channel.id, chatId, 500);
          const userCache = new Map<string, Any>();
          const lookupUser = (id: string) => {
            if (!id) return undefined;
            if (userCache.has(id)) return userCache.get(id);
            const u = channelUserRepo.findById(id);
            userCache.set(id, u);
            return u;
          };

          const rendered = formatChatTranscriptForPrompt(raw, {
            lookupUser,
            sinceMs,
            untilMs: runAtMs,
            includeOutgoing: false,
            dropCommands: true,
            maxMessages: 120,
            maxChars: 30_000,
            maxMessageChars: 500,
          });

          return {
            chat_messages:
              rendered.usedCount > 0
                ? rendered.transcript
                : "[no messages found]",
            chat_since: new Date(sinceMs).toISOString(),
            chat_until: new Date(runAtMs).toISOString(),
            chat_message_count: String(rendered.usedCount),
            chat_truncated: rendered.truncated ? "true" : "false",
          };
        },
        getTaskStatus: async (taskId) => {
          const managedRun = managedBriefingRuns.get(taskId);
          if (managedRun) {
            return {
              status: "completed",
              error: null,
              resultSummary: managedRun.text,
              terminalStatus: "ok",
              failureClass: null,
              budgetUsage: null,
            };
          }
          const task = taskRepo.findById(taskId);
          if (!task) return null;
          return {
            status: task.status,
            error: task.error ?? null,
            resultSummary: task.resultSummary ?? null,
            terminalStatus: task.terminalStatus ?? null,
            failureClass: task.failureClass ?? null,
            budgetUsage: task.budgetUsage ?? null,
          };
        },
        getTaskResultText: async (taskId) => {
          const managedRun = managedBriefingRuns.get(taskId);
          if (managedRun) {
            return managedRun.text;
          }
          const task = taskRepo.findById(taskId);
          const events = taskEventRepo.findByTaskId(taskId);
          return resolveTaskResultText({
            summary: task?.resultSummary,
            semanticSummary: task?.semanticSummary,
            verificationVerdict: task?.verificationVerdict,
            verificationReport: task?.verificationReport,
            events,
          });
        },
        // Channel delivery handler - sends job results to messaging platforms
        deliverToChannel: async (params) => {
          if (!channelGateway) {
            throw new Error(
              "Cannot deliver to channel - gateway not initialized",
            );
          }

          const resultAvailable =
            typeof params.resultText === "string" &&
            params.resultText.trim().length > 0;
          const hasFullResult =
            (params.status === "ok" ||
              params.status === "partial_success" ||
              params.status === "needs_user_action") &&
            !params.summaryOnly &&
            resultAvailable;

          console.log(
            `[Cron] Delivery for "${params.jobName}": hasFullResult=${hasFullResult}, ` +
              `resultTextLength=${params.resultText?.length ?? 0}, summaryOnly=${params.summaryOnly}`,
          );

          // Build the message
          const statusEmoji =
            params.status === "ok"
              ? "✅"
              : params.status === "partial_success" ||
                  params.status === "needs_user_action"
                ? "⚠️"
                : params.status === "error"
                  ? "❌"
                  : "⏱️";
          let message: string;

          if (hasFullResult) {
            // Full result mode — send the complete task output
            message = `**${params.jobName}**\n\n${params.resultText!.trim()}`;
          } else if (params.summaryOnly && resultAvailable) {
            // Summary-only mode but result exists — include a truncated preview
            const preview = params.resultText!.trim();
            const truncated =
              preview.length > 500 ? `${preview.slice(0, 500)}…` : preview;
            message = `${statusEmoji} **${params.jobName}**\n\n${truncated}`;
          } else {
            // No result text or error/timeout — generic status message
            let msg = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

            if (params.status === "ok") {
              msg += `Task completed successfully.\n`;
            } else if (params.status === "partial_success") {
              msg += `Task completed with partial results.\n`;
            } else if (params.status === "needs_user_action") {
              msg += `Task completed - action required.\n`;
            } else if (params.status === "error") {
              msg += `Task failed.\n`;
            } else {
              msg += `Task timed out.\n`;
            }

            if (params.error) {
              msg += `\n**Error:** ${params.error}\n`;
            }

            if (params.taskId) {
              msg += `\n_Task ID: ${params.taskId}_`;
            }

            message = msg;
          }

          try {
            // Resolve the actual channel type when a specific channel DB ID is provided
            let resolvedType = params.channelType as string;
            if (params.channelDbId) {
              const ch = channelGateway.getChannel(params.channelDbId);
              if (ch) {
                resolvedType = ch.type;
              }
            }

            // Send the message via the gateway
            await channelGateway.sendMessage(
              resolvedType as Any,
              params.channelId,
              message,
              {
                parseMode: "markdown",
                idempotencyKey: params.idempotencyKey,
              },
            );
            console.log(
              `[Cron] Delivered to ${resolvedType}:${params.channelId}`,
            );
          } catch (err) {
            console.error(
              `[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`,
              err,
            );
            throw err;
          }
        },
        onEvent: async (evt) => {
          // Forward cron events to renderer
          if (mainWindow?.webContents) {
            mainWindow.webContents.send("cron:event", evt);
          }
          console.log("[Cron] Event:", evt.action, evt.jobId);
          try {
            await MailboxAutomationRegistry.recordCronEvent(evt);
          } catch (error) {
            logger.debug(
              "[MailboxAutomationRegistry] Failed to record cron event:",
              error,
            );
          }
          try {
            routineService?.recordScheduledEvent(evt);
          } catch (error) {
            logger.debug("[Routines] Failed to record cron routine run:", error);
          }

          if (
            evt.action === "finished" &&
            evt.taskId &&
            councilService?.isCouncilJob(evt.jobId)
          ) {
            await councilService
              .finalizeRunForTask(evt.taskId)
              .catch((error) => {
                console.error(
                  "[Council] Failed to finalize council run:",
                  error,
                );
              });
            return;
          }

          // Show desktop notification when scheduled task finishes
          if (evt.action === "finished") {
            const statusEmoji =
              evt.status === "ok"
                ? "✅"
                : evt.status === "partial_success" ||
                    evt.status === "needs_user_action"
                  ? "⚠️"
                  : evt.status === "error"
                    ? "❌"
                    : "⏱️";
            const statusText =
              evt.status === "ok"
                ? "completed"
                : evt.status === "partial_success"
                  ? "completed with partial results"
                  : evt.status === "needs_user_action"
                    ? "completed, action required"
                    : evt.status === "error"
                      ? "failed"
                      : "timed out";

            // Add in-app notification
            const notificationService = getNotificationService();
            if (notificationService) {
              try {
                // Get job name for the notification
                const job = cronService
                  ? await cronService.get(evt.jobId)
                  : null;
                const jobName = job?.name || "Scheduled Task";
                const task = evt.taskId ? taskRepo.findById(evt.taskId) : null;
                const taskResult = resolveTaskResultText({
                  summary: task?.resultSummary,
                  semanticSummary: task?.semanticSummary,
                  verificationVerdict: task?.verificationVerdict,
                  verificationReport: task?.verificationReport,
                });
                await notificationService.add({
                  type:
                    evt.status === "ok"
                      ? "task_completed"
                      : evt.status === "partial_success" ||
                          evt.status === "needs_user_action"
                        ? "warning"
                        : "task_failed",
                  title: `${statusEmoji} ${jobName} ${statusText}`,
                  message:
                    evt.error ||
                    taskResult ||
                    (evt.status === "ok"
                      ? "Task completed successfully."
                      : evt.status === "needs_user_action"
                        ? "Task completed but is waiting on user action."
                        : "Task did not complete."),
                  taskId: evt.taskId,
                  cronJobId: evt.jobId,
                  workspaceId: job?.workspaceId,
                });
              } catch (err) {
                console.error("[Cron] Failed to add in-app notification:", err);
              }
            }

            // Custom overlay notification is shown automatically via
            // notificationService.add() -> onEvent -> NotificationOverlayManager
          }
        },
        log: {
          debug: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ""),
          info: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ""),
          warn: (msg, data) => console.warn(`[Cron] ${msg}`, data ?? ""),
          error: (msg, data) => console.error(`[Cron] ${msg}`, data ?? ""),
        },
      });
      setCronService(cronService);
      await cronService.start();
      if (councilService) {
        const db = dbManager.getDatabase();
        const rows = db
          .prepare("SELECT id FROM council_configs")
          .all() as Array<{ id: string }>;
        for (const row of rows) {
          await councilService.syncManagedJob(row.id).catch((error) => {
            console.error(
              `[Council] Failed to sync managed cron job for council ${row.id}:`,
              error,
            );
          });
        }
      }
      logger.info("Cron Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Cron Service:", error);
      // Don't fail app startup if cron init fails
    }

    // Initialize extension/plugin system — auto-discovers and loads plugins
    try {
      const pluginInitStartedAt = Date.now();
      const pluginRegistry = getPluginRegistry();
      await pluginRegistry.initialize();
      const plugins = pluginRegistry.getPlugins();
      pluginStartupSummary = {
        loaded: plugins.length,
        enabled: plugins.filter((plugin: Any) => plugin.state === "enabled")
          .length,
      };
      logger.info(
        `Plugins summary: loaded=${pluginStartupSummary.loaded}, enabled=${pluginStartupSummary.enabled}`,
      );
      logger.info(`Plugin registry initialized (${plugins.length} plugins)`);
      logPhase("plugin-init", pluginInitStartedAt);
    } catch (error) {
      logger.error("Failed to initialize Plugin Registry:", error);
      // Don't fail app startup if plugin init fails
    }

    // Initialize channel gateway with agent daemon for task processing
    channelGateway = new ChannelGateway(dbManager.getDatabase(), {
      autoConnect: true, // Auto-connect enabled channels on startup
      agentDaemon,
    });

    // Setup IPC handlers
    await setupIpcHandlers(dbManager, agentDaemon, channelGateway, {
      getMainWindow: () => mainWindow,
      getRoutineService: () => routineService,
    });
    if (subconsciousLoopService) {
      setupSubconsciousHandlers(subconsciousLoopService);
      setupImprovementHandlers(subconsciousLoopService);
    }
    void getCustomSkillLoader()
      .initialize()
      .then(() => {
        const skills = getCustomSkillLoader().getLoadStats();
        logger.info(
          `Skills summary: total=${skills.total}, bundled=${skills.bundled}, external=${skills.external}, managed=${skills.managed}, workspace=${skills.workspace}, overrides=${skills.overridden}`,
        );
      })
      .catch((error) => {
        logger.debug("Skills summary unavailable:", error);
      });

    const startXMentionBridge = () => {
      if (!xMentionBridgeService) {
        xMentionBridgeService = initializeXMentionBridgeService(agentDaemon, {
          isNativeXChannelEnabled: () => {
            const nativeX = channelGateway.getChannelByType("x");
            return nativeX?.enabled === true && nativeX.status === "connected";
          },
        });
      }
      xMentionBridgeService.start();
    };

    // Initialize heartbeat and Mission Control services
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);

      const mentionRepo = new MentionRepository(db);
      const activityRepo = new ActivityRepository(db);
      const workingStateRepo = new WorkingStateRepository(db);

      // Create repositories for heartbeat service
      const taskRepo = new TaskRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);

      const resolveDefaultWorkspace = ():
        | ReturnType<typeof workspaceRepo.findById>
        | undefined => {
        const workspaces = workspaceRepo.findAll();
        return (
          workspaces.find(
            (workspace) =>
              !workspace.isTemp && !isTempWorkspaceId(workspace.id),
          ) ?? workspaces[0]
        );
      };

      const hasActiveForegroundTask = (workspaceId?: string): boolean => {
        const activeTasks = taskRepo.findByStatus(
          Array.from(ACTIVE_FOREGROUND_TASK_STATUSES),
        );
        return activeTasks.some((task) => {
          if (workspaceId && task.workspaceId !== workspaceId) return false;
          return isForegroundUserTask(task);
        });
      };

      // Initialize HeartbeatService with dependencies
      const heartbeatDeps: HeartbeatServiceDeps = {
        db,
        agentRoleRepo,
        mentionRepo,
        activityRepo,
        workingStateRepo,
        createTask: async (
          workspaceId,
          prompt,
          title,
          _agentRoleId,
          options,
        ) => {
          const task = await agentDaemon.createTask({
            title,
            prompt,
            workspaceId,
            agentConfig: {
              allowUserInput: false,
              ...(options?.agentConfig ?? {}),
            },
            ...(options?.source ? { source: options.source } : {}),
            ...(options?.taskOverrides
              ? { taskOverrides: options.taskOverrides }
              : {}),
          });
          if (_agentRoleId) {
            taskRepo.update(task.id, {
              assignedAgentRoleId: _agentRoleId,
            });
          }
          return task;
        },
        updateTask: (taskId, updates) => {
          taskRepo.update(taskId, updates);
        },
        getTasksForAgent: (agentRoleId, workspaceId) => {
          const tasks = workspaceId
            ? taskRepo.findByWorkspace(workspaceId)
            : taskRepo.findByStatus(["pending", "running"]);
          return tasks.filter(
            (t: { assignedAgentRoleId?: string }) =>
              t.assignedAgentRoleId === agentRoleId,
          );
        },
        getDefaultWorkspaceId: () => {
          const fallbackTemp = workspaceRepo
            .findAll()
            .find(
              (workspace) =>
                workspace.isTemp || isTempWorkspaceId(workspace.id),
            );
          return (
            resolveDefaultWorkspace()?.id ??
            fallbackTemp?.id ??
            TEMP_WORKSPACE_ID
          );
        },
        getDefaultWorkspacePath: () => {
          const fallbackTempPath = workspaceRepo
            .findAll()
            .find(
              (workspace) =>
                workspace.isTemp || isTempWorkspaceId(workspace.id),
            )?.path;
          return resolveDefaultWorkspace()?.path || fallbackTempPath;
        },
        getWorkspacePath: (workspaceId: string) => {
          const workspace = workspaceRepo.findById(workspaceId);
          return workspace?.path;
        },
        hasActiveForegroundTask,
        recordActivity: ({
          workspaceId,
          agentRoleId,
          title,
          description,
          metadata,
        }) => {
          activityRepo.create({
            workspaceId,
            agentRoleId,
            actorType: "system",
            activityType: "info",
            title,
            description,
            metadata,
          });
        },
        listWorkspaceContexts: () =>
          workspaceRepo
            .findAll()
            .filter(
              (workspace) =>
                workspace.path &&
                !workspace.isTemp &&
                !isTempWorkspaceId(workspace.id),
            )
            .map((workspace) => ({
              workspaceId: workspace.id,
              workspacePath: workspace.path,
            })),
        getMemoryFeaturesSettings: () => MemoryFeaturesManager.loadSettings(),
        getAwarenessSummary: (workspaceId?: string) =>
          awarenessService?.getSummary(workspaceId) || null,
        getAutonomyState: (workspaceId?: string) =>
          autonomyEngine?.getWorldModel(workspaceId) || null,
        getAutonomyDecisions: (workspaceId?: string) =>
          autonomyEngine?.listDecisions(workspaceId) || [],
        listActiveSuggestions: (workspaceId: string) =>
          ProactiveSuggestionsService.listActive(workspaceId, {
            includeDeferred: true,
            recordSurface: false,
          }),
        createCompanionSuggestion: (workspaceId, suggestion) =>
          ProactiveSuggestionsService.createCompanionSuggestion(
            workspaceId,
            suggestion,
          ),
        addNotification: async (params) => {
          const notificationService = getNotificationService();
          await notificationService?.add(params);
        },
        captureMemory: (
          workspaceId,
          taskId,
          type,
          content,
          isPrivate,
          options,
        ) =>
          MemoryService.capture(
            workspaceId,
            taskId,
            type,
            content,
            isPrivate,
            options,
          ),
        automationProfileRepo: new AutomationProfileRepository(
          dbManager.getDatabase(),
        ),
        coreTraceService: coreTraceService || undefined,
        coreMemoryCandidateService: coreMemoryCandidateService || undefined,
        coreMemoryDistiller: coreMemoryDistiller || undefined,
        coreLearningPipelineService: coreLearningPipelineService || undefined,
      };

      heartbeatService = new HeartbeatService(heartbeatDeps);
      setHeartbeatService(heartbeatService);
      await heartbeatService.start();

      setHeartbeatWakeSubmitter(async ({ text, mode }) => {
        submitHeartbeatSignalForAll({ text, mode, source: "hook" });
      });

      autonomyEngine = AutonomyEngine.initialize({
        getDefaultWorkspaceId: () => {
          const fallbackTemp = workspaceRepo
            .findAll()
            .find(
              (workspace) =>
                workspace.isTemp || isTempWorkspaceId(workspace.id),
            );
          return (
            resolveDefaultWorkspace()?.id ??
            fallbackTemp?.id ??
            TEMP_WORKSPACE_ID
          );
        },
        listWorkspaceIds: () =>
          workspaceRepo
            .findAll()
            .filter(
              (workspace) =>
                !workspace.isTemp && !isTempWorkspaceId(workspace.id),
            )
            .map((workspace) => workspace.id),
        createTask: async (workspaceId, title, prompt) =>
          agentDaemon.createTask({
            title,
            prompt,
            workspaceId,
            source: "hook",
            agentConfig: {
              allowUserInput: false,
            },
          }),
        hasActiveManualTask: (workspaceId) =>
          hasActiveForegroundTask(workspaceId) || hasActiveForegroundTask(),
        recordActivity: ({ workspaceId, title, description, metadata }) => {
          activityRepo.create({
            workspaceId,
            actorType: "system",
            activityType: "info",
            title,
            description,
            metadata,
          });
        },
        wakeHeartbeats: ({ text, mode }) => {
          submitHeartbeatSignalForAll({ text, mode, source: "hook" });
        },
        log: (...args: unknown[]) => logger.debug("[Autonomy]", ...args),
      });
      await autonomyEngine.start();
      logger.info("AutonomyEngine initialized");

      // Initialize AwarenessService after Heartbeat and Autonomy so onWakeHeartbeats and onEventCaptured work
      try {
        awarenessService = AwarenessService.initialize({
          getDefaultWorkspaceId: () => {
            try {
              const workspaceRepo = new WorkspaceRepository(
                dbManager.getDatabase(),
              );
              const workspaces = workspaceRepo.findAll();
              return (
                workspaces.find(
                  (workspace) =>
                    !workspace.isTemp && !isTempWorkspaceId(workspace.id),
                )?.id || workspaces[0]?.id
              );
            } catch {
              return undefined;
            }
          },
          onWakeHeartbeats: ({ text, mode }) => {
            submitHeartbeatSignalForAll({ text, mode, source: "hook" });
          },
          onEventCaptured: (event) => {
            autonomyEngine?.notifyEvent(event);
          },
          log: (...args: unknown[]) => logger.debug("[Awareness]", ...args),
        });
        await awarenessService.start();
        logger.info("AwarenessService initialized");
      } catch (awarenessError) {
        logger.error("Failed to initialize AwarenessService:", awarenessError);
      }
    } catch (error) {
      logger.error("Failed to initialize Heartbeat:", error);
      // Don't fail app startup if heartbeat init fails
    }

    // Setup Mission Control IPC handlers
    try {
      if (
        !heartbeatService ||
        !coreTraceService ||
        !coreMemoryDistiller ||
        !coreFailureMiningService ||
        !coreFailureClusterService ||
        !coreEvalCaseService ||
        !coreHarnessExperimentService ||
        !coreHarnessExperimentRunner ||
        !coreLearningsService
      ) {
        logger.error(
          "Mission Control handlers skipped: core automation services unavailable",
        );
      } else {
        const db = dbManager.getDatabase();
        const agentRoleRepo = new AgentRoleRepository(db);
        const taskSubscriptionRepo = new TaskSubscriptionRepository(db);
        const standupService = new StandupReportService(db);

        setupMissionControlHandlers({
          db,
          agentRoleRepo,
          taskSubscriptionRepo,
          standupService,
          heartbeatService,
          getPlannerService: () => strategicPlannerService,
          getMainWindow: () => mainWindow,
          coreTraceService,
          coreMemoryDistiller,
          coreFailureMiningService,
          coreFailureClusterService,
          coreEvalCaseService,
          coreHarnessExperimentService,
          coreHarnessExperimentRunner,
          coreLearningsService,
        });

        logger.info("Mission Control services initialized");
      }
    } catch (error) {
      logger.error("Failed to initialize Mission Control:", error);
      // Don't fail app startup if Mission Control init fails
    }

    try {
      if (coreMemoryDistiller) {
        const db = dbManager.getDatabase();
        const automationProfileRepo = new AutomationProfileRepository(db);
        const runCoreDistill = async () => {
          for (const profile of automationProfileRepo.listEnabled()) {
            try {
              await coreMemoryDistiller?.runOffline({ profileId: profile.id });
            } catch (error) {
              logger.warn("Core memory distillation failed for profile:", {
                profileId: profile.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        };
        void runCoreDistill();
        coreMemoryDistillTimer = setInterval(() => {
          void runCoreDistill();
        }, 6 * 60 * 60 * 1000);
        coreMemoryDistillTimer.unref();
      }
    } catch (error) {
      logger.error("Failed to schedule core memory distillation:", error);
    }

    try {
      strategicPlannerService = new StrategicPlannerService({
        db: dbManager.getDatabase(),
        agentDaemon,
        log: (...args) => logger.info(...args),
      });
      setStrategicPlannerService(strategicPlannerService);
      strategicPlannerService.start();
      logger.info("Strategic Planner initialized");
    } catch (error) {
      logger.error("Failed to initialize Strategic Planner:", error);
    }

    // Initialize Persona Templates (Digital Twins) service — independent of heartbeat
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);
      const personaTemplateService = getPersonaTemplateService(agentRoleRepo);
      await personaTemplateService.initialize();
      setupPersonaTemplateHandlers({ personaTemplateService });
      logger.info("Persona Template service initialized");
    } catch (error) {
      logger.error("Failed to initialize Persona Templates:", error);
    }

    // Initialize Plugin Pack handlers (Customize panel)
    try {
      setupPluginPackHandlers();
      logger.debug("Plugin Pack handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Plugin Pack handlers:", error);
    }

    // Initialize Plugin Distribution handlers (scaffold, install, registry)
    try {
      setupPluginDistributionHandlers();
      logger.debug("Plugin Distribution handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Plugin Distribution handlers:", error);
    }

    // Initialize Admin Policy handlers
    try {
      setupAdminPolicyHandlers();
      logger.debug("Admin Policy handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Admin Policy handlers:", error);
    }

    if (HEADLESS) {
      logger.info("Headless mode enabled (no UI)");
      logger.info(`userData: ${getUserDataDir()}`);

      // For security, only print the token when explicitly requested, or when it was just generated.
      let hadControlPlaneToken = false;
      if (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) {
        try {
          ControlPlaneSettingsManager.initialize();
          const before = ControlPlaneSettingsManager.loadSettings();
          hadControlPlaneToken = Boolean(before?.token);
        } catch {
          // ignore
        }
      }

      // Apply Control Plane overrides (optional)
      const cpHost =
        process.env.COWORK_CONTROL_PLANE_HOST ||
        getArgValue("--control-plane-host");
      const cpPortRaw =
        process.env.COWORK_CONTROL_PLANE_PORT ||
        getArgValue("--control-plane-port");
      const cpPort = cpPortRaw ? Number.parseInt(cpPortRaw, 10) : undefined;
      if (
        (typeof cpHost === "string" && cpHost.trim()) ||
        (typeof cpPort === "number" && Number.isFinite(cpPort))
      ) {
        try {
          ControlPlaneSettingsManager.updateSettings({
            ...(typeof cpHost === "string" && cpHost.trim()
              ? { host: cpHost.trim() }
              : {}),
            ...(typeof cpPort === "number" && Number.isFinite(cpPort)
              ? { port: cpPort }
              : {}),
          });
        } catch (error) {
          logger.warn("Failed to apply Control Plane overrides:", error);
        }
      }

      // Initialize messaging gateway without a BrowserWindow
      try {
        const channelInitStartedAt = Date.now();
        await channelGateway.initialize();
        const channelStats = channelGateway.getStartupStats();
        logger.info(
          `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}`,
        );
        logPhase("channel-gateway-headless", channelInitStartedAt);
        startXMentionBridge();
      } catch (error) {
        logger.error("Failed to initialize Channel Gateway (headless):", error);
        // Don't fail app startup if gateway init fails
      }

      // Start Control Plane if enabled (or force-enabled via flag/env)
      const cp = await startControlPlaneFromSettings({
        deps: { agentDaemon, dbManager, channelGateway, getRoutineService: () => routineService },
        forceEnable: FORCE_ENABLE_CONTROL_PLANE,
        onEvent: (event) => {
          try {
            const action =
              typeof event?.action === "string" ? event.action : "event";
            console.log(`[ControlPlane] ${action}`);
          } catch {
            // ignore
          }
        },
      });

      if (!cp.ok) {
        logger.error("Control Plane failed to start:", cp.error);
      } else if (!cp.skipped && cp.address) {
        logger.info(`Control Plane listening: ${cp.address.wsUrl}`);
        if (
          (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) &&
          (PRINT_CONTROL_PLANE_TOKEN || !hadControlPlaneToken)
        ) {
          try {
            const settings = ControlPlaneSettingsManager.loadSettings();
            if (settings?.token) {
              logger.info("Control Plane token present: yes");
            }
          } catch {
            // ignore
          }
        }
      } else if (cp.skipped) {
        logger.info("Control Plane disabled (skipping auto-start)");
      }

      logger.info(`Startup complete in ${Date.now() - startupStartedAt} ms`);
      return;
    }

    // Register canvas:// protocol handler (must be after app.ready)
    registerCanvasProtocol();
    registerMediaProtocol();

    // Create window
    createWindow();

    // Initialize gateway with main window reference
    if (mainWindow) {
      // Initialize Live Canvas handlers BEFORE async operations so IPC handlers
      // are registered before the renderer finishes loading and calls them
      setupCanvasHandlers(mainWindow, agentDaemon);
      setupQAHandlers(mainWindow, agentDaemon);
      CanvasManager.getInstance().setMainWindow(mainWindow);

      // Initialize Git Worktree & Comparison handlers
      const comparisonService = new ComparisonService(
        dbManager.getDatabase(),
        agentDaemon,
      );
      agentDaemon.setComparisonService(comparisonService);
      setupWorktreeHandlers(agentDaemon);

      const channelInitStartedAt = Date.now();
      await channelGateway.initialize(mainWindow);
      const channelStats = channelGateway.getStartupStats();
      logger.info(
        `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}`,
      );
      logPhase("channel-gateway-ui", channelInitStartedAt);
      startXMentionBridge();
      // Initialize update manager with main window reference
      updateManager.setMainWindow(mainWindow);

      // Restore persisted canvas sessions from disk
      await CanvasManager.getInstance().restoreSessions();

      // Initialize control plane (WebSocket gateway)
      setupControlPlaneHandlers(mainWindow, {
        agentDaemon,
        dbManager,
        channelGateway,
        getRoutineService: () => routineService,
      });
      // Auto-start control plane if enabled (and register methods/bridge)
      await startControlPlaneFromSettings({
        deps: { agentDaemon, dbManager, channelGateway, getRoutineService: () => routineService },
      });

      // ── Gap features: triggers, briefing, file hub, web access ───────
      const db = dbManager.getDatabase();
      const workspaceRepo = new WorkspaceRepository(db);
      const activityRepo = new ActivityRepository(db);
      const resolveDefaultWorkspace = ():
        | ReturnType<typeof workspaceRepo.findById>
        | undefined => {
        const workspaces = workspaceRepo.findAll();
        return (
          workspaces.find(
            (workspace) =>
              !workspace.isTemp && !isTempWorkspaceId(workspace.id),
          ) ?? workspaces[0]
        );
      };
      const extractConnectorTriggerSubscription = (trigger: {
        source: string;
        conditions: Array<{ field: string; value: string }>;
      }): {
        serverId?: string;
        connectorId?: string;
        resourceUri?: string;
      } | null => {
        if (trigger.source !== "connector_event") {
          return null;
        }
        const getConditionValue = (...fields: string[]): string | undefined => {
          for (const field of fields) {
            const match = trigger.conditions.find(
              (condition) => condition.field === field,
            );
            if (match?.value) {
              return match.value;
            }
          }
          return undefined;
        };
        return {
          serverId: getConditionValue("serverId"),
          connectorId: getConditionValue("connectorId", "source"),
          resourceUri: getConditionValue("resourceUri"),
        };
      };

      // Event Triggers
      eventTriggerService = new EventTriggerService(
        {
          createTask: async (params: {
            title: string;
            prompt: string;
            workspaceId: string;
            agentConfig?: Any;
          }) => {
            const task = await agentDaemon.createTask({
              title: params.title,
              prompt: params.prompt,
              workspaceId: params.workspaceId,
              agentConfig: params.agentConfig,
              source: "hook",
            });
            return { id: task.id };
          },
          deliverToChannel: async (params: {
            channelType: string;
            channelId: string;
            text: string;
          }) => {
            await channelGateway.sendMessage?.(
              params.channelType as Any,
              params.channelId,
              params.text,
            );
          },
          wakeAgent: (agentRoleId: string) => {
            if (!heartbeatService) return;
            void heartbeatService
              .triggerHeartbeat(agentRoleId)
              .catch((error) => {
                logger.debug("[EventTriggers] wakeAgent failed:", error);
              });
          },
          getDefaultWorkspaceId: () => "",
          log: (...args: unknown[]) => console.log("[EventTriggers]", ...args),
          onTriggerFired: (payload) => {
            MailboxAutomationRegistry.recordTriggerFire(payload);
            routineService?.recordEventTriggerFire(payload);
          },
        },
        db,
      );
      const currentTriggerService = eventTriggerService;
      const mcpClientManager = MCPClientManager.getInstance();
      const syncMcpTriggerSubscriptions = async (): Promise<void> => {
        const subscriptions = currentTriggerService
          .listTriggers()
          .map(extractConnectorTriggerSubscription)
          .filter((value): value is NonNullable<typeof value> =>
            Boolean(value),
          );
        await mcpClientManager.syncTriggerResourceSubscriptions(subscriptions);
      };
      mailboxForwardingService = new MailboxForwardingService({
        db,
        log: (...args: unknown[]) =>
          logger.debug("[MailboxForwardingService]", ...args),
      });
      setMailboxForwardingServiceInstance(mailboxForwardingService);
      MailboxAutomationRegistry.configure({
        db,
        triggerService: currentTriggerService,
        resolveDefaultWorkspaceId: () => resolveDefaultWorkspace()?.id,
        log: (...args: unknown[]) =>
          logger.debug("[MailboxAutomationRegistry]", ...args),
        onMutation: () => {
          void mailboxForwardingService?.refresh();
        },
      });
      mailboxForwardingService.start();
      currentTriggerService.start();
      setHookTriggerEmitter((event) => {
        void currentTriggerService.evaluateEvent(event);
      });
      mcpClientManager.on("connector_event", (event) => {
        void currentTriggerService.evaluateEvent({
          source: "connector_event",
          timestamp: event.timestamp,
          fields: {
            type: event.type,
            changeType: event.type,
            serverId: event.serverId,
            connectorId: event.connectorId || "",
            serverName: event.serverName,
            source: event.connectorId || event.serverName,
            resourceUri: event.resourceUri || "",
            data: JSON.stringify(event.payload || {}),
            payload: JSON.stringify(event.payload || {}),
          },
        });
        if ((event.connectorId || "").trim().toLowerCase() === "github") {
          const githubPayload =
            event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
          void currentTriggerService.evaluateEvent({
            source: "github_event",
            timestamp: event.timestamp,
            fields: {
              connectorId: "github",
              eventName:
                typeof githubPayload.eventName === "string"
                  ? githubPayload.eventName
                  : typeof githubPayload.event === "string"
                    ? githubPayload.event
                    : "",
              action: typeof githubPayload.action === "string" ? githubPayload.action : "",
              repository:
                typeof githubPayload.repository === "string"
                  ? githubPayload.repository
                  : typeof githubPayload.repo === "string"
                    ? githubPayload.repo
                    : "",
              ref: typeof githubPayload.ref === "string" ? githubPayload.ref : "",
              resourceUri: event.resourceUri || "",
              payload: JSON.stringify(event.payload || {}),
            },
          });
        }
      });
      void syncMcpTriggerSubscriptions();
      setupTriggerHandlers(currentTriggerService, syncMcpTriggerSubscriptions);
      const managedSessionService = new ManagedSessionService(db, agentDaemon);
      const routineTaskRepo = new TaskRepository(db);
      routineService = new RoutineService({
        db,
        getCronService: () => cronService,
        getEventTriggerService: () => eventTriggerService,
        loadHooksSettings: () => HooksSettingsManager.loadSettings(),
        saveHooksSettings: (settings) => HooksSettingsManager.saveSettings(settings),
        createTask: async (params) => {
          const task = await agentDaemon.createTask({
            title: params.title,
            prompt: params.prompt,
            workspaceId: params.workspaceId,
            agentConfig: params.agentConfig,
            source: params.source,
          });
          return { id: task.id };
        },
        createManagedSession: async (params) => {
          const agent = params.agentId
            ? managedSessionService.getAgent(params.agentId)?.agent
            : managedSessionService.listAgents({ limit: 1 })[0];
          if (!agent) {
            throw new Error("No managed agents are available for routine execution");
          }
          const session = await managedSessionService.createSession({
            agentId: agent.id,
            environmentId: params.environmentId,
            title: params.title,
            initialEvent: {
              type: "user.message",
              content: [{ type: "text", text: params.prompt }],
            },
          });
          return {
            id: session.id,
            backingTaskId: session.backingTaskId || undefined,
            workspaceId: session.workspaceId,
          };
        },
        getManagedSessionSnapshot: async (sessionId) => {
          const session = managedSessionService.getSession(sessionId);
          if (!session) return null;
          return {
            status: session.status,
            latestSummary: session.latestSummary || undefined,
            completedAt: session.completedAt || undefined,
            backingTaskId: session.backingTaskId || undefined,
          };
        },
        getTaskSnapshot: (taskId) => {
          const task = routineTaskRepo.findById(taskId);
          if (!task) return null;
          return {
            status: task.status,
            error: task.error || undefined,
            resultSummary: task.resultSummary || task.semanticSummary || undefined,
            terminalStatus: task.terminalStatus || undefined,
            completedAt: task.completedAt || undefined,
          };
        },
        onHooksConfigChanged: (settings) => {
          const server = getHooksServer();
          if (server && settings.enabled) {
            server.setHooksConfig(settings);
          }
        },
        onTriggerMutation: syncMcpTriggerSubscriptions,
      });
      setupRoutineHandlers(routineService);
      setHookAgentDispatchObserver((payload) => {
        routineService?.recordApiTriggerDispatch(payload);
      });
      MailboxAutomationHub.configure({
        triggerService: eventTriggerService,
        heartbeatService,
        resolveDefaultWorkspaceId: () => resolveDefaultWorkspace()?.id,
        emitMailboxEvent: (event) => {
          mainWindow?.webContents.send(IPC_CHANNELS.MAILBOX_EVENT, event);
        },
        log: (...args: unknown[]) =>
          logger.debug("[MailboxAutomationHub]", ...args),
      });
      ambientMonitoringService = new AmbientMonitoringService({
        listWorkspaces: () =>
          workspaceRepo
            .findAll()
            .filter(
              (workspace) =>
                workspace.path &&
                !workspace.isTemp &&
                !isTempWorkspaceId(workspace.id) &&
                !isManagedScheduledWorkspacePath(
                  workspace.path,
                  getUserDataDir(),
                ),
            )
            .map((workspace) => ({
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              name: workspace.name,
            })),
        getDefaultWorkspaceId: () =>
          resolveDefaultWorkspace()?.id ?? TEMP_WORKSPACE_ID,
        recordActivity: ({
          workspaceId,
          activityType,
          title,
          description,
          metadata,
        }) => {
          activityRepo.create({
            workspaceId,
            actorType: "system",
            activityType,
            title,
            description,
            metadata,
          });
        },
        emitTrigger: (event) => {
          void currentTriggerService.evaluateEvent(event);
        },
        wakeHeartbeats: ({ text, mode }) => {
          submitHeartbeatSignalForAll({ text, mode, source: "hook" });
        },
        captureAwarenessEvent: ({
          source,
          workspaceId,
          title,
          summary,
          sensitivity,
          payload,
          tags,
        }) => {
          awarenessService?.captureEvent({
            source,
            workspaceId,
            title,
            summary,
            sensitivity: sensitivity || "low",
            payload,
            tags,
          });
        },
        log: (...args: unknown[]) =>
          console.log("[AmbientMonitoring]", ...args),
      });
      await ambientMonitoringService.start();

      // Daily Briefing
      dailyBriefingService = new DailyBriefingService(
        {
          getRecentTasks: (_workspaceId, _sinceMs) => {
            try {
              const taskRepo = new TaskRepository(db);
              return (taskRepo.findByWorkspace(_workspaceId, 200) || []).filter(
                (task) =>
                  typeof task.createdAt === "number" &&
                  task.createdAt >= _sinceMs,
              );
            } catch {
              return [];
            }
          },
          searchMemory: (workspaceId, query, limit) => {
            try {
              return MemoryService.search(workspaceId, query, limit).map(
                (memory) => ({
                  summary: memory.snippet,
                  content: memory.snippet,
                  snippet: memory.snippet,
                  type: memory.type,
                }),
              );
            } catch {
              return [];
            }
          },
          refreshSuggestions: async (workspaceId) => {
            await ProactiveSuggestionsService.generateAll(workspaceId);
          },
          getActiveSuggestions: (workspaceId) =>
            ProactiveSuggestionsService.getTopForBriefing(workspaceId, 5),
          getPriorities: (workspaceId) => {
            const workspacePath = workspaceRepo.findById(workspaceId)?.path;
            return readWorkspacePriorities(workspacePath);
          },
          getUpcomingJobs: async (workspaceId, limit) => {
            if (!cronService) return [];
            try {
              const jobs = await cronService.list({ includeDisabled: false });
              return jobs
                .filter((job) => job.workspaceId === workspaceId)
                .sort(
                  (a, b) =>
                    (a.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER) -
                    (b.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER),
                )
                .slice(0, limit);
            } catch {
              return [];
            }
          },
          getOpenLoops: (workspaceId) => {
            const workspacePath = workspaceRepo.findById(workspaceId)?.path;
            return readWorkspaceOpenLoops(workspacePath);
          },
          getMailboxDigest: async (workspaceId) =>
            getMailboxServiceInstance()?.getMailboxDigest(workspaceId) || null,
          getAwarenessSummary: async (workspaceId) =>
            awarenessService?.getSummary(workspaceId) || null,
          getAutonomyState: async (workspaceId) =>
            autonomyEngine?.getWorldModel(workspaceId) || null,
          getAutonomyDecisions: async (workspaceId) =>
            autonomyEngine?.listDecisions(workspaceId) || [],
          deliverToChannel: async (params) => {
            await channelGateway.sendMessage?.(
              params.channelType as Any,
              params.channelId,
              params.text,
            );
          },
          log: (...args: unknown[]) => console.log("[Briefing]", ...args),
        },
        db,
      );
      setupBriefingHandlers(dailyBriefingService, {
        onConfigSaved: async (workspaceId, config) => {
          await syncDailyBriefingCronJob(cronService, workspaceId, config);
        },
      });
      for (const workspace of workspaceRepo
        .findAll()
        .filter(
          (entry) =>
            !entry.isTemp &&
            !isTempWorkspaceId(entry.id) &&
            !isManagedScheduledWorkspacePath(entry.path, getUserDataDir()),
        )) {
        await syncDailyBriefingCronJob(
          cronService,
          workspace.id,
          dailyBriefingService.getConfig(workspace.id),
        );
      }

      // File Hub
      const fileHubService = new FileHubService(
        {
          getWorkspacePath: (wsId) => {
            try {
              const wsRepo = new WorkspaceRepository(db);
              const ws =
                (wsId ? wsRepo.findById(wsId) : null) ||
                wsRepo
                  .findAll()
                  .find(
                    (workspace) =>
                      !workspace.isTemp && !isTempWorkspaceId(workspace.id),
                  ) ||
                wsRepo.findAll()[0];
              return ws?.path || "";
            } catch {
              return "";
            }
          },
          getArtifacts: () => [],
          getConnectedSources: () => [],
        },
        db,
      );
      setupFileHubHandlers(fileHubService);

      // Web Access
      const loadWebAccessSettings = (): WebAccessConfig => {
        try {
          if (!SecureSettingsRepository.isInitialized()) {
            return { ...DEFAULT_WEB_ACCESS_CONFIG };
          }
          const repository = SecureSettingsRepository.getInstance();
          const stored = repository.load<Partial<WebAccessConfig>>("webaccess");
          if (!stored) {
            return { ...DEFAULT_WEB_ACCESS_CONFIG };
          }
          const allowedOrigins = Array.isArray(stored.allowedOrigins)
            ? stored.allowedOrigins
                .filter(
                  (origin): origin is string => typeof origin === "string",
                )
                .map((origin) => origin.trim())
                .filter(Boolean)
            : DEFAULT_WEB_ACCESS_CONFIG.allowedOrigins;
          return {
            ...DEFAULT_WEB_ACCESS_CONFIG,
            ...stored,
            enabled: stored.enabled === true,
            port: Number.isFinite(Number(stored.port))
              ? Math.min(65535, Math.max(1, Math.floor(Number(stored.port))))
              : DEFAULT_WEB_ACCESS_CONFIG.port,
            host:
              typeof stored.host === "string" && stored.host.trim().length > 0
                ? stored.host.trim()
                : DEFAULT_WEB_ACCESS_CONFIG.host,
            token: typeof stored.token === "string" ? stored.token.trim() : "",
            allowedOrigins,
          };
        } catch (error) {
          console.warn(
            "[WebAccess] Failed to load settings; using defaults:",
            error,
          );
          return { ...DEFAULT_WEB_ACCESS_CONFIG };
        }
      };

      const saveWebAccessSettings = (settings: WebAccessConfig): void => {
        try {
          if (!SecureSettingsRepository.isInitialized()) return;
          const repository = SecureSettingsRepository.getInstance();
          repository.save("webaccess", settings);
        } catch (error) {
          console.error("[WebAccess] Failed to persist settings:", error);
        }
      };

      const webAccessTaskRepo = new TaskRepository(db);
      const webAccessWorkspaceRepo = new WorkspaceRepository(db);

      const getDefaultWebWorkspaceId = (): string => {
        const firstWorkspace = webAccessWorkspaceRepo
          .findAll()
          .find(
            (workspace) =>
              !workspace.isTemp && !isTempWorkspaceId(workspace.id),
          );
        return firstWorkspace?.id || "";
      };

      const initialWebAccessSettings = loadWebAccessSettings();
      const webAccessServer = new WebAccessServer(initialWebAccessSettings, {
        handleIpcInvoke: async (channel: string, ...args: Any[]) => {
          switch (channel) {
            case "task:list":
              return webAccessTaskRepo.findAll();
            case "task:create": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              const prompt =
                typeof payload.prompt === "string" ? payload.prompt.trim() : "";
              if (!prompt) {
                throw new Error("Task prompt is required.");
              }
              const workspaceId =
                typeof payload.workspaceId === "string" &&
                payload.workspaceId.trim().length > 0
                  ? payload.workspaceId.trim()
                  : getDefaultWebWorkspaceId();
              if (!workspaceId) {
                throw new Error("No workspace available for task creation.");
              }
              const title =
                typeof payload.title === "string" &&
                payload.title.trim().length > 0
                  ? payload.title.trim()
                  : "Web Access Task";
              return agentDaemon.createTask({
                title,
                prompt,
                workspaceId,
                source: "api",
              });
            }
            case "task:get": {
              const taskId = typeof args[0] === "string" ? args[0].trim() : "";
              if (!taskId) {
                throw new Error("Task ID is required.");
              }
              return webAccessTaskRepo.findById(taskId) ?? null;
            }
            case "task:sendMessage": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              let taskId: string;
              let message: string;
              let images:
                | import("../shared/types").ImageAttachment[]
                | undefined;
              try {
                const sanitized = sanitizeTaskMessageParams(payload);
                taskId = sanitized.taskId;
                message = sanitized.message;
                images = sanitized.images;
              } catch (err) {
                throw new Error(
                  err instanceof Error
                    ? err.message
                    : "taskId and message are required.",
                );
              }
              return agentDaemon.sendMessage(taskId, message, images);
            }
            case "task:events": {
              const taskId = typeof args[0] === "string" ? args[0].trim() : "";
              if (!taskId) {
                throw new Error("Task ID is required.");
              }
              const events = agentDaemon.getTaskEvents(taskId);
              const maxEvents = 600;
              return events.length > maxEvents
                ? events.slice(-maxEvents)
                : events;
            }
            case "workspace:list":
              return webAccessWorkspaceRepo
                .findAll()
                .filter(
                  (workspace) =>
                    !workspace.isTemp && !isTempWorkspaceId(workspace.id),
                );
            case "account:list": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              const status =
                typeof payload.status === "string"
                  ? payload.status.trim()
                  : undefined;
              const accounts = ManagedAccountManager.list({
                provider:
                  typeof payload.provider === "string"
                    ? payload.provider
                    : undefined,
                status: status as ManagedAccountStatus | undefined,
              });
              const includeSecrets = payload.includeSecrets === true;
              return {
                accounts: accounts.map((account) =>
                  ManagedAccountManager.toPublicView(account, includeSecrets),
                ),
              };
            }
            case "account:get": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              const accountId =
                typeof payload.accountId === "string"
                  ? payload.accountId.trim()
                  : "";
              if (!accountId) {
                throw new Error("accountId is required.");
              }
              const account = ManagedAccountManager.getById(accountId);
              if (!account) {
                return { account: null };
              }
              return {
                account: ManagedAccountManager.toPublicView(
                  account,
                  payload.includeSecrets === true,
                ),
              };
            }
            case "account:upsert": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              const account = ManagedAccountManager.upsert(payload);
              return {
                account: ManagedAccountManager.toPublicView(account, false),
              };
            }
            case "account:remove": {
              const payload =
                args[0] && typeof args[0] === "object" ? args[0] : {};
              const accountId =
                typeof payload.accountId === "string"
                  ? payload.accountId.trim()
                  : "";
              if (!accountId) {
                throw new Error("accountId is required.");
              }
              return { removed: ManagedAccountManager.remove(accountId) };
            }
            case "briefing:generate": {
              const workspaceId =
                typeof args[0] === "string" && args[0].trim().length > 0
                  ? args[0].trim()
                  : getDefaultWebWorkspaceId();
              if (!workspaceId) {
                throw new Error("workspaceId is required.");
              }
              if (!dailyBriefingService) {
                throw new Error("Daily briefing service is not initialized.");
              }
              return dailyBriefingService.generateBriefing(workspaceId);
            }
            case "suggestions:list": {
              const workspaceId =
                typeof args[0] === "string" ? args[0].trim() : "";
              if (!workspaceId) return [];
              const { ProactiveSuggestionsService } =
                await import("./agent/ProactiveSuggestionsService");
              return ProactiveSuggestionsService.listActive(workspaceId);
            }
            default:
              throw new Error(`Unsupported web access channel: ${channel}`);
          }
        },
        getRendererPath: () => {
          // oxlint-disable-next-line typescript-eslint(no-require-imports)
          const { app } = require("electron");
          return path.join(app.getAppPath(), "dist", "renderer");
        },
        log: (...args: unknown[]) => console.log("[WebAccess]", ...args),
      });
      const normalizedWebAccessSettings = webAccessServer.getConfig();
      if (
        JSON.stringify(initialWebAccessSettings) !==
        JSON.stringify(normalizedWebAccessSettings)
      ) {
        saveWebAccessSettings(normalizedWebAccessSettings);
      }
      if (normalizedWebAccessSettings.enabled) {
        try {
          await webAccessServer.start();
        } catch (error) {
          console.error("[WebAccess] Failed to start enabled server:", error);
        }
      }
      setupWebAccessHandlers(webAccessServer, {
        saveSettings: saveWebAccessSettings,
      });

      // Hook triggers into gateway message events
      channelGateway.onEvent((event) => {
        if (event.type === "message:received" && event.data) {
          eventTriggerService?.evaluateEvent({
            source: "channel_message",
            fields: {
              channelType: event.channel || "",
              chatId: (event.data.chatId as string) || "",
              text: (event.data.text as string) || "",
              senderName: (event.data.senderName as string) || "",
            },
            timestamp: Date.now(),
          });
        }
      });

      // Initialize system tray (macOS menu bar / Windows system tray)
      if (process.platform === "darwin" || process.platform === "win32") {
        await trayManager.initialize(
          mainWindow,
          channelGateway,
          dbManager,
          agentDaemon,
        );
      }

      // Show migration notification after window is ready
      if (migrationResult.migrated && migrationResult.migratedKeys.length > 0) {
        mainWindow.webContents.once("did-finish-load", () => {
          dialog.showMessageBox(mainWindow!, {
            type: "info",
            title: "Configuration Migrated",
            message: "Your API credentials have been migrated",
            detail:
              `The following credentials were migrated from your .env file to secure Settings storage:\n\n` +
              `${migrationResult.migratedKeys.map((k) => `• ${k}`).join("\n")}\n\n` +
              `Your .env file has been renamed to .env.migrated. ` +
              `You can safely delete it after verifying your settings work correctly.\n\n` +
              `Open Settings (gear icon) to review your configuration.`,
            buttons: ["OK"],
          });
        });
      }
    }

    logger.info(`Startup complete in ${Date.now() - startupStartedAt} ms`);

    app.on("activate", () => {
      if (revealWindow(mainWindow)) {
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (HEADLESS) return;
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // In headless/server mode, allow clean shutdown via systemd/docker signals.
  if (HEADLESS) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        logger.info(`Received ${sig}, shutting down...`);
        app.quit();
      });
    }
  }

  app.on("before-quit", async () => {
    if (tempWorkspacePruneTimer) {
      clearInterval(tempWorkspacePruneTimer);
      tempWorkspacePruneTimer = null;
    }
    if (tempSandboxProfilePruneTimer) {
      clearInterval(tempSandboxProfilePruneTimer);
      tempSandboxProfilePruneTimer = null;
    }

    // Destroy tray
    trayManager.destroy();

    // Stop cron service (async to properly shutdown webhook server)
    if (cronService) {
      await cronService.stop();
      setCronService(null);
    }
    if (ambientMonitoringService) {
      await ambientMonitoringService.stop();
      ambientMonitoringService = null;
    }
    if (mailboxForwardingService) {
      mailboxForwardingService.stop();
      mailboxForwardingService = null;
      setMailboxForwardingServiceInstance(null);
    }
    if (awarenessService) {
      await awarenessService.stop();
      awarenessService = null;
    }
    if (autonomyEngine) {
      await autonomyEngine.stop();
      autonomyEngine = null;
    }
    if (strategicPlannerService) {
      try {
        strategicPlannerService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop Strategic Planner:", error);
      }
      strategicPlannerService = null;
      setStrategicPlannerService(null);
    }

    if (xMentionBridgeService) {
      try {
        xMentionBridgeService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop X mention bridge service:", error);
      }
      xMentionBridgeService = null;
    }

    if (subconsciousLoopService) {
      try {
        subconsciousLoopService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop SubconsciousLoopService:", error);
      }
      subconsciousLoopService = null;
    }

    // Cleanup canvas manager (close all windows and watchers)
    await cleanupCanvasHandlers();

    // Shutdown control plane (WebSocket gateway and Tailscale)
    await shutdownControlPlane();

    if (channelGateway) {
      await channelGateway.shutdown();
    }

    // Stop lore service to flush any debounced workspace history updates
    if (loreService) {
      try {
        await loreService.stop();
      } catch (error) {
        console.error("[Main] Failed to shutdown LoreService:", error);
      }
      loreService = null;
    }

    // Disconnect all MCP servers
    try {
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.shutdown();
    } catch (error) {
      console.error("[Main] Failed to shutdown MCP servers:", error);
    }
    // Shutdown Memory Service
    try {
      MemoryService.shutdown();
    } catch (error) {
      console.error("[Main] Failed to shutdown Memory Service:", error);
    }

    if (dbManager) {
      dbManager.close();
    }
    if (agentDaemon) {
      agentDaemon.shutdown();
    }
    if (detachTaskLifecycleSync) {
      try {
        detachTaskLifecycleSync();
      } catch (error) {
        console.error("[Main] Failed to detach task lifecycle sync:", error);
      }
      detachTaskLifecycleSync = null;
    }
  });

  // Window control handlers (used by custom title bar buttons on Windows)
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
    BrowserWindow.getFocusedWindow()?.close();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false;
  });
  const resolveDialogDefaultPath = async (candidate?: string | null) => {
    const requested = typeof candidate === "string" ? candidate.trim() : "";
    const tempWorkspaceRoot = path.resolve(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
    const homeDir = path.resolve(app.getPath("home"));
    const blockedRoots = new Set(
      [
        homeDir,
        path.join(homeDir, "Desktop"),
        path.join(homeDir, "Downloads"),
        path.join(homeDir, "Documents"),
        path.join(homeDir, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"),
      ].map((entry) => path.resolve(entry)),
    );

    const isBlockedDialogRoot = (candidatePath: string) => {
      const normalizedPath = path.resolve(candidatePath);
      if (
        normalizedPath === tempWorkspaceRoot ||
        normalizedPath.startsWith(`${tempWorkspaceRoot}${path.sep}`)
      ) {
        return "temp-workspace";
      }
      if (blockedRoots.has(normalizedPath)) {
        return "broad-root";
      }
      if (isManagedScheduledWorkspacePath(normalizedPath, getUserDataDir())) {
        return "managed-scheduled-workspace";
      }
      return null;
    };

    const recentWorkspaceCandidates = (() => {
      try {
        return new WorkspaceRepository(dbManager.getDatabase())
          .findAll()
          .filter((workspace) => {
            if (!workspace?.path || workspace.isTemp || isTempWorkspaceId(workspace.id)) {
              return false;
            }
            return isBlockedDialogRoot(workspace.path) === null;
          })
          .map((workspace) => workspace.path);
      } catch (error) {
        logger.warn("[Dialog] Failed to load recent workspace fallback paths:", error);
        return [] as string[];
      }
    })();

    const fallbacks = [requested, ...recentWorkspaceCandidates].filter(
      (value, index, values): value is string =>
        typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
    );

    for (const fallbackPath of fallbacks) {
      try {
        const normalizedPath = path.resolve(fallbackPath);
        const blockReason = isBlockedDialogRoot(normalizedPath);
        if (blockReason) {
          logger.info("[Dialog] Ignoring blocked defaultPath", {
            reason: blockReason,
            requestedPath: fallbackPath,
          });
          continue;
        }

        const stats = await fs.stat(normalizedPath);
        if (stats.isDirectory()) {
          return normalizedPath;
        }
        if (stats.isFile()) {
          return path.dirname(normalizedPath);
        }
      } catch {
        continue;
      }
    }

    return undefined;
  };

  const showOpenDialogWithLogging = async (
    dialogKind: "folder" | "files",
    options: Electron.OpenDialogOptions,
  ) => {
    const startedAt = Date.now();
    const slowLogTimer = setTimeout(() => {
      logger.warn(`[Dialog:${dialogKind}] showOpenDialog still pending`, {
        defaultPath: options.defaultPath ?? null,
        elapsedMs: Date.now() - startedAt,
        title: options.title ?? null,
      });
    }, 5000);
    slowLogTimer.unref();

    logger.info(`[Dialog:${dialogKind}] showOpenDialog requested`, {
      defaultPath: options.defaultPath ?? null,
      parentWindow: false,
      properties: options.properties ?? [],
      title: options.title ?? null,
    });

    try {
      const result = await dialog.showOpenDialog(options);
      clearTimeout(slowLogTimer);
      logger.info(`[Dialog:${dialogKind}] showOpenDialog resolved`, {
        canceled: result.canceled,
        durationMs: Date.now() - startedAt,
        selectionCount: result.filePaths.length,
      });
      return result;
    } catch (error) {
      clearTimeout(slowLogTimer);
      logger.error(
        `[Dialog:${dialogKind}] showOpenDialog failed after ${Date.now() - startedAt}ms:`,
        error,
      );
      throw error;
    }
  };

  // Handle folder selection
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async (_, defaultPath?: string | null) => {
    const resolvedDefaultPath = await resolveDialogDefaultPath(defaultPath);
    const result = await showOpenDialogWithLogging("folder", {
      // Allow creating folders directly from the native picker when supported.
      properties: ["openDirectory", "createDirectory"],
      title: "Select Workspace Folder",
      defaultPath: resolvedDefaultPath,
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // Handle file selection (attachments)
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILES, async (_, defaultPath?: string | null) => {
    const resolvedDefaultPath = await resolveDialogDefaultPath(defaultPath);
    const result = await showOpenDialogWithLogging("files", {
      properties: ["openFile", "multiSelections"],
      title: "Select Files to Upload",
      defaultPath: resolvedDefaultPath,
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    const entries = await Promise.all(
      result.filePaths.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) {
            return null;
          }
          return {
            path: filePath,
            name: path.basename(filePath),
            size: stats.size,
            mimeType: (mime.lookup(filePath) || undefined) as
              | string
              | undefined,
          };
        } catch {
          return null;
        }
      }),
    );

    const validEntries = entries.filter(
      (
        entry,
      ): entry is {
        path: string;
        name: string;
        size: number;
        mimeType: string | undefined;
      } => Boolean(entry),
    );
    rememberApprovedImportFiles(validEntries.map((entry) => entry.path));
    return validEntries;
  });
} // single-instance guard
