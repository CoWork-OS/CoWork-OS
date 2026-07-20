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
  nativeTheme,
  Menu,
  screen,
  type BrowserWindowConstructorOptions,
} from "electron";
import mime from "mime-types";
import { DatabaseManager } from "./database/schema";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "./database/SecureSettingsRepository";
import {
  setupIpcHandlers,
  getHooksServer,
  getNotificationService,
  setHeartbeatWakeSubmitter,
  setHookAgentDispatchObserver,
  setHookWorkflowDispatchObserver,
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
import { AutomationRunOutcomeRepository } from "./automation/AutomationRunOutcomeRepository";
import { AutomationOutcomeService } from "./automation/AutomationOutcomeService";
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
  AnnotationRepository,
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
import {
  SymphonyService,
  setSymphonyService,
} from "./control-plane/SymphonyService";
import { attachControlPlaneTaskLifecycleSync } from "./control-plane/task-run-sync";
import {
  buildManagedScheduledWorkspacePath,
  createScheduledRunDirectory,
  isManagedScheduledWorkspacePath,
} from "./cron/workspace-context";
import { MemoryService } from "./memory/MemoryService";
import { CuratedMemoryService } from "./memory/CuratedMemoryService";
import { MemoryWriteGate } from "./memory/MemoryWriteGate";
import { DreamingRepository } from "./memory/DreamingRepository";
import { DreamingService } from "./memory/DreamingService";
import { MemoryPressureService } from "./memory/MemoryPressureService";
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
  getControlPlaneAllowedOriginsFromEnv,
  getControlPlaneBindContextFromEnv,
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldAllowInsecureControlPlanePublicBindFromEnv,
  shouldEnableControlPlaneFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
  shouldPrintControlPlaneTokenFromArgsOrEnv,
  shouldTrustControlPlaneProxyFromEnv,
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
import { getBrowserWorkbenchService } from "./browser/browser-workbench-service";
import { isAllowedWebviewUrl } from "./browser/webview-url-policy";
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
import { createRoutineWorkflowActionExecutor } from "./routines/workflow/action-executor";
import { GoogleWorkspaceWorkflowStarterWatcher } from "./routines/workflow/google-starter-watcher";
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
import {
  getDesktopLocationService,
  registerLocationProbeScheme,
} from "./location/DesktopLocationService";
import { AmbientMonitoringService } from "./monitoring/AmbientMonitoringService";
import { AwarenessService } from "./awareness/AwarenessService";
import { AutonomyEngine } from "./awareness/AutonomyEngine";
import { SubconsciousLoopService } from "./subconscious/SubconsciousLoopService";
import { ManagedSessionService } from "./managed/ManagedSessionService";
import { createLogger } from "./utils/logger";
import { registerMediaProtocol, registerMediaScheme } from "./media";
import { rememberApprovedImportFiles } from "./security/file-import-approvals";
import { healMovedDesktopWorkspacePaths } from "./utils/workspace-path-healer";
import {
  APP_DISPLAY_NAME,
  applyApplicationIdentity,
  getDesktopIconImage,
  getDesktopIconPath,
} from "./branding";

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
let symphonyService: SymphonyService | null = null;
let automationOutcomeService: AutomationOutcomeService | null = null;
let eventTriggerService: EventTriggerService | null = null;
let routineService: RoutineService | null = null;
let workflowStarterWatcher: GoogleWorkspaceWorkflowStarterWatcher | null = null;
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
const MANAGED_BRIEFING_TTL_MS = 24 * 60 * 60 * 1000;
const managedBriefingCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - MANAGED_BRIEFING_TTL_MS;
  for (const [key, value] of managedBriefingRuns) {
    if (value.generatedAt < cutoff) managedBriefingRuns.delete(key);
  }
}, 60 * 60 * 1000);

const HEADLESS = isHeadlessMode();
const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();
const logger = createLogger("Main");
const cronLogger = createLogger("Cron");
let startupLaneStartedAt = Date.now();

function shouldAutoEnableDesktopControlPlane(): boolean {
  if (HEADLESS) return false;
  const raw = (process.env.COWORK_DESKTOP_AUTO_CONTROL_PLANE || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const logStartupLane = (lane: string, extra: Record<string, unknown> = {}): void => {
  logger.info(
    `[StartupLane] ${JSON.stringify({
      lane,
      elapsedMs: Date.now() - startupLaneStartedAt,
      ...extra,
    })}`,
  );
};
const TRANSIENT_MAIN_PROCESS_ERROR_RE = new RegExp(
  [
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTCONN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNABORTED",
    "ERR_SOCKET_CLOSED",
    "socket hang up",
    "Timed Out",
    "Connection Closed",
    "Client network socket disconnected before secure TLS connection was established",
    "read ENOTCONN",
  ].join("|"),
  "i",
);
let processErrorGuardsInstalled = false;
const MAIN_WINDOW_STATE_FILE = "main-window-state.json";
const MAIN_WINDOW_MIN_WIDTH = 1200;
const MAIN_WINDOW_MIN_HEIGHT = 800;
const MAIN_WINDOW_DEFAULT_WIDTH = 1600;
const MAIN_WINDOW_DEFAULT_HEIGHT = 1000;
let startupUserDataDir: string | null = null;

interface MainWindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

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
    const browserWorkbenchService = getBrowserWorkbenchService();
    if (
      !isAllowedWebviewUrl(targetUrl) &&
      !browserWorkbenchService.isAllowedLocalPreviewUrl(targetUrl)
    ) {
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

function applyStableUserDataPath(): string {
  const resolvedUserDataDir = getUserDataDir();
  const defaultUserDataDir = app.getPath("userData");
  if (path.resolve(defaultUserDataDir) !== path.resolve(resolvedUserDataDir)) {
    try {
      fsSync.mkdirSync(resolvedUserDataDir, { recursive: true });
      app.setPath("userData", resolvedUserDataDir);
      logger.info(`Using userData directory: ${resolvedUserDataDir}`);
    } catch (error) {
      logger.warn("Failed to apply userData directory:", error);
    }
  }
  startupUserDataDir = resolvedUserDataDir;
  return resolvedUserDataDir;
}

function getMainWindowStatePath(): string {
  return path.join(getUserDataDir(), MAIN_WINDOW_STATE_FILE);
}

function readMainWindowState(): MainWindowState | null {
  try {
    const raw = fsSync.readFileSync(getMainWindowStatePath(), "utf8");
    const parsed = JSON.parse(raw) as MainWindowState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isWindowBoundsOnScreen(bounds: Electron.Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const horizontalOverlap =
      bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const verticalOverlap =
      bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return horizontalOverlap && verticalOverlap;
  });
}

function getInitialMainWindowBounds(): Pick<
  BrowserWindowConstructorOptions,
  "x" | "y" | "width" | "height"
> & {
  isMaximized: boolean;
  isFullScreen: boolean;
} {
  const saved = readMainWindowState();
  const width = Math.max(
    MAIN_WINDOW_MIN_WIDTH,
    Math.round(
      isFinitePositiveNumber(saved?.width)
        ? saved.width
        : MAIN_WINDOW_DEFAULT_WIDTH,
    ),
  );
  const height = Math.max(
    MAIN_WINDOW_MIN_HEIGHT,
    Math.round(
      isFinitePositiveNumber(saved?.height)
        ? saved.height
        : MAIN_WINDOW_DEFAULT_HEIGHT,
    ),
  );
  const x = typeof saved?.x === "number" ? Math.round(saved.x) : undefined;
  const y = typeof saved?.y === "number" ? Math.round(saved.y) : undefined;

  if (
    x !== undefined &&
    y !== undefined &&
    isWindowBoundsOnScreen({ x, y, width, height })
  ) {
    return {
      x,
      y,
      width,
      height,
      isMaximized: saved?.isMaximized === true,
      isFullScreen: saved?.isFullScreen === true,
    };
  }

  return {
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    isMaximized: false,
    isFullScreen: false,
  };
}

function writeMainWindowState(
  window: BrowserWindow,
  options: { allowMinimized?: boolean } = {},
): Electron.Rectangle | null {
  if (
    window.isDestroyed() ||
    (window.isMinimized() && options.allowMinimized !== true)
  ) {
    return null;
  }
  try {
    const bounds = window.getNormalBounds();
    const state: MainWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    };
    const statePath = getMainWindowStatePath();
    fsSync.mkdirSync(path.dirname(statePath), { recursive: true });
    fsSync.writeFileSync(statePath, JSON.stringify(state, null, 2));
    return bounds;
  } catch (error) {
    logger.warn("Failed to save main window state:", error);
    return null;
  }
}

function installMainWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | null = null;
  let lastNormalBounds: Electron.Rectangle | null = window.getNormalBounds();
  const scheduleSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      lastNormalBounds = writeMainWindowState(window) ?? lastNormalBounds;
    }, 400);
  };

  window.on("move", scheduleSave);
  window.on("resize", scheduleSave);
  window.on("maximize", scheduleSave);
  window.on("unmaximize", scheduleSave);
  window.on("enter-full-screen", scheduleSave);
  window.on("leave-full-screen", scheduleSave);
  window.on("minimize", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    lastNormalBounds =
      writeMainWindowState(window, { allowMinimized: true }) ??
      lastNormalBounds;
  });
  window.on("restore", () => {
    if (
      !lastNormalBounds ||
      window.isDestroyed() ||
      window.isMaximized() ||
      window.isFullScreen()
    ) {
      return;
    }
    const currentBounds = window.getBounds();
    if (
      currentBounds.width !== lastNormalBounds.width ||
      currentBounds.height !== lastNormalBounds.height
    ) {
      window.setBounds(lastNormalBounds);
    }
  });
  window.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeMainWindowState(window);
  });
}

function installNativeApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    copyright: "CoWork OS Contributors",
  });

  const sendToMainWindow = (channel: string) => {
    if (!revealWindow(mainWindow)) {
      return;
    }
    mainWindow?.webContents.send(channel);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Command+,",
          click: () => sendToMainWindow("tray:open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          accelerator: "Command+N",
          click: () => sendToMainWindow("tray:new-task"),
        },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "CoWork OS on GitHub",
          click: () =>
            shell.openExternal("https://github.com/CoWork-OS/CoWork-OS"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installDevelopmentBranding(): void {
  if (process.platform === "darwin") {
    const iconPath = getDesktopIconPath();
    if (iconPath) {
      try {
        const icon = getDesktopIconImage();
        if (!icon) {
          logger.warn(`Development Dock icon is empty: ${iconPath}`);
        } else {
          app.dock?.setIcon(icon);
          logger.info(`Development Dock icon set: ${iconPath}`);
        }
      } catch (error) {
        logger.warn("Failed to set development Dock icon:", error);
      }
    } else {
      logger.warn("Development Dock icon not found in build assets");
    }
  }
}

function logCron(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  data?: unknown,
): void {
  if (data === undefined) {
    cronLogger[level](msg);
    return;
  }
  cronLogger[level](msg, data);
}

const RESETTABLE_SECURE_SETTINGS_CATEGORIES: SettingsCategory[] = [
  "subconscious-migration-v1",
  "autonomy-chief-of-staff",
  "awareness-state",
  "webaccess",
];

function healResettableSecureSettings(): void {
  if (!SecureSettingsRepository.isInitialized()) {
    return;
  }

  const repository = SecureSettingsRepository.getInstance();
  for (const category of RESETTABLE_SECURE_SETTINGS_CATEGORIES) {
    const status = repository.checkHealth(category, { logErrors: false });
    if (status === "decryption_failed" || status === "checksum_mismatch") {
      const didDelete = repository.delete(category);
      if (didDelete) {
        logger.warn(
          `Reset corrupted secure settings category ${category} (${status}); defaults will be recreated.`,
        );
      }
    }
  }
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
const TASK_DEEPLINK_PROTOCOL = "cowork";
const TASK_DEEPLINK_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let pendingTaskDeeplinkId: string | null = null;

function parseTaskDeeplink(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== `${TASK_DEEPLINK_PROTOCOL}:`) return null;
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const taskId =
      parsed.hostname === "tasks"
        ? pathParts[0]
        : parsed.hostname === "task"
          ? pathParts[0]
          : parsed.hostname;
    if (!taskId || !TASK_DEEPLINK_UUID_RE.test(taskId)) return null;
    return taskId;
  } catch {
    return null;
  }
}

function extractTaskDeeplinkArg(argv: string[]): string | null {
  for (const arg of argv) {
    const taskId = parseTaskDeeplink(arg);
    if (taskId) return taskId;
  }
  return null;
}

function registerTaskDeeplinkProtocol(): void {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(TASK_DEEPLINK_PROTOCOL, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
      return;
    }
    app.setAsDefaultProtocolClient(TASK_DEEPLINK_PROTOCOL);
  } catch (error) {
    logger.warn(`Failed to register ${TASK_DEEPLINK_PROTOCOL}:// deeplink handler: ${toErrorMessage(error)}`);
  }
}

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

function isEnvFlagEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function isBackgroundAutostartDisabled(): boolean {
  return /^(0|false|no|off)$/i.test(
    String(process.env.COWORK_BACKGROUND_AUTOSTART || "").trim(),
  );
}

function isStartupQuietMode(): boolean {
  return (
    isEnvFlagEnabled("COWORK_STARTUP_QUIET") ||
    isEnvFlagEnabled("COWORK_PROFILE_QUIET") ||
    isBackgroundAutostartDisabled()
  );
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
registerLocationProbeScheme();
registerTaskDeeplinkProtocol();

applyApplicationIdentity();
applyStableUserDataPath();

const CLI_DIRECT_RUN_FLAG = "--cowork-cli-direct-run";
const CLI_APPROVAL_RESPONSE_FLAG = "--cowork-cli-approval-response";
const DEV_SINGLE_INSTANCE_EXIT_CODE = 73;

function isCliDirectRunMode(): boolean {
  return process.argv.includes(CLI_DIRECT_RUN_FLAG);
}

function getCliDirectRunArgv(): string[] {
  const index = process.argv.indexOf(CLI_DIRECT_RUN_FLAG);
  return index >= 0 ? process.argv.slice(index + 1) : [];
}

function getArgValueFrom(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function getCliApprovalResponseArgv(argv: string[]): { approvalId: string; approved: boolean } | null {
  if (!argv.includes(CLI_APPROVAL_RESPONSE_FLAG)) return null;
  const approvalId = getArgValueFrom(argv, "--approval-id") || "";
  if (!approvalId) return null;
  return {
    approvalId,
    approved: argv.includes("--approved"),
  };
}

async function handleCliApprovalResponse(request: { approvalId: string; approved: boolean }): Promise<void> {
  if (!agentDaemon) {
    logger.warn("CLI approval response received before agent daemon was ready");
    return;
  }
  const result = await agentDaemon.respondToApproval(request.approvalId, request.approved);
  logger.info(
    `CLI approval response ${request.approved ? "approved" : "rejected"} ${request.approvalId}: ${result}`,
  );
}

async function runCliDirectMode(): Promise<void> {
  try {
    process.env.COWORK_HEADLESS = "1";
    await app.whenReady();
    const directRunPath = path.join(app.getAppPath(), "dist", "cli", "cli", "direct-run.js");
    if (!fsSync.existsSync(directRunPath)) {
      throw new Error(
        `CoWork CLI runtime is missing at ${directRunPath}. Run npm run build:cli or reinstall CoWork OS.`,
      );
    }
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const directRun = require(directRunPath) as { main: (argv: string[]) => Promise<number> };
    const code = await directRun.main(getCliDirectRunArgv());
    app.quit();
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.quit();
    process.exit(1);
  }
}

if (isCliDirectRunMode()) {
  void runCliDirectMode();
} else {
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
  if (process.env.NODE_ENV === "development") {
    console.error(
      `[startup] Another CoWork OS instance is already using ${getUserDataDir()}. ` +
        "Quit the existing app before running `npm run dev` so the new Electron main process and Vite renderer use the same build.",
    );
    app.exit(DEV_SINGLE_INSTANCE_EXIT_CODE);
  } else {
    app.quit();
  }
} else {
  function flushPendingTaskDeeplink(): void {
    const taskId = pendingTaskDeeplinkId;
    if (!taskId || !mainWindow || mainWindow.isDestroyed()) return;
    pendingTaskDeeplinkId = null;
    mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_TASK, taskId);
  }

  function openTaskDeeplink(taskId: string): void {
    if (HEADLESS) return;
    pendingTaskDeeplinkId = taskId;
    if (!revealWindow(mainWindow)) {
      createWindow();
      return;
    }
    if (mainWindow?.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.once("did-finish-load", flushPendingTaskDeeplink);
      return;
    }
    flushPendingTaskDeeplink();
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const taskId = parseTaskDeeplink(url);
    if (taskId) {
      openTaskDeeplink(taskId);
    }
  });
  pendingTaskDeeplinkId = extractTaskDeeplinkArg(process.argv);

  app.on("second-instance", (_event, argv) => {
    if (HEADLESS) return;
    const approvalResponse = getCliApprovalResponseArgv(argv);
    if (approvalResponse) {
      void handleCliApprovalResponse(approvalResponse);
      return;
    }
    const taskId = extractTaskDeeplinkArg(argv);
    if (taskId) {
      openTaskDeeplink(taskId);
      return;
    }
    // Focus the existing window instead of starting a second instance.
    if (revealWindow(mainWindow)) {
      return;
    }
    // If the window was closed (but app kept running), recreate it.
    createWindow();
  });

  const startupApprovalResponse = getCliApprovalResponseArgv(process.argv);
  if (startupApprovalResponse) {
    logger.warn("CLI approval response requested, but no existing CoWork OS instance accepted it");
    app.exit(1);
  }

  function createWindow() {
    const isMac = process.platform === "darwin";
    const isWsl =
      process.platform === "linux" &&
      (Boolean(process.env.WSL_DISTRO_NAME) ||
        os.release().toLowerCase().includes("microsoft"));
    let useMacVibrancy = isMac && !nativeTheme.prefersReducedTransparency;
    const {
      isMaximized: shouldStartMaximized,
      isFullScreen: shouldStartFullScreen,
      ...initialWindowBounds
    } = getInitialMainWindowBounds();
    let rendererRecoveryAttempts = 0;

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
      ...initialWindowBounds,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
      center:
        initialWindowBounds.x === undefined ||
        initialWindowBounds.y === undefined,
      icon: getDesktopIconPath(),
      ...(isWsl ? {} : { titleBarStyle: isMac ? "hiddenInset" : "hidden" }),
      ...(isWsl ? { frame: true } : {}),
      ...(isMac ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
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

    if (shouldStartMaximized) {
      mainWindow.maximize();
    }
    if (shouldStartFullScreen) {
      mainWindow.setFullScreen(true);
    }
    installMainWindowStatePersistence(mainWindow);

    const loadMainWindowContent = () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      if (process.env.NODE_ENV === "development") {
        mainWindow.loadURL(getDevServerUrl());
        mainWindow.webContents.openDevTools();
        return;
      }

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
    };

    // Load the app
    loadMainWindowContent();

    mainWindow.on("closed", () => {
      getBrowserWorkbenchService().setMainWindow(null);
      mainWindow = null;
    });
    getBrowserWorkbenchService().setMainWindow(mainWindow);

    mainWindow.on("unresponsive", () => {
      logger.warn("Main window became unresponsive");
    });

    mainWindow.on("responsive", () => {
      logger.info("Main window became responsive again");
    });

    mainWindow.webContents.on("did-finish-load", () => {
      rendererRecoveryAttempts = 0;
      logStartupLane("first_window_startup", { event: "did_finish_load" });
      flushPendingTaskDeeplink();
    });

    mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        logger.warn(
          `Main window failed to load (${errorCode}): ${errorDescription} ${validatedURL}`,
        );
      },
    );

    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      logger.error(
        `Main renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`,
      );
      if (
        details.reason !== "clean-exit" &&
        mainWindow &&
        !mainWindow.isDestroyed() &&
        rendererRecoveryAttempts < 1
      ) {
        rendererRecoveryAttempts += 1;
        setTimeout(() => {
          loadMainWindowContent();
        }, 750);
      }
    });

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
    getDesktopLocationService().installPermissionHandlers();
    const startupStartedAt = Date.now();
    startupLaneStartedAt = startupStartedAt;
    logStartupLane("blocking_startup", { event: "start" });
    const logPhase = (name: string, phaseStartedAt: number): void => {
      logger.debug(
        `Startup phase "${name}" completed in ${Date.now() - phaseStartedAt} ms`,
      );
    };
    const deferredStartupTasks: Array<{
      name: string;
      task: () => Promise<void>;
    }> = [];
    const startupQuietMode = isStartupQuietMode();
    if (startupQuietMode) {
      logger.info("Startup quiet mode enabled; background autostart is disabled.");
    }
    const deferStartupTask = (name: string, task: () => Promise<void>): void => {
      deferredStartupTasks.push({ name, task });
    };
    const runDeferredStartupTasks = (): void => {
      logStartupLane("post_interactive_startup", {
        event: "deferred_tasks_scheduled",
        taskCount: deferredStartupTasks.length,
      });
      deferredStartupTasks.forEach(({ name, task }, index) => {
        const timer = setTimeout(() => {
          if (index === 0) {
            logStartupLane("idle_startup", { event: "first_deferred_task_start" });
          }
          const startedAt = Date.now();
          void task()
            .then(() => {
              logger.info(
                `Deferred startup task "${name}" completed in ${Date.now() - startedAt} ms`,
              );
            })
            .catch((error) => {
              logger.error(`Deferred startup task "${name}" failed:`, error);
            });
        }, 250 + index * 50);
        timer.unref?.();
      });
    };

    const resolvedUserDataDir = startupUserDataDir || applyStableUserDataPath();
    const activeProfileId = getActiveProfileId();
    if (hasNonDefaultProfile()) {
      logger.info(`Active profile: ${activeProfileId}`);
    }
    installDevelopmentBranding();
    installNativeApplicationMenu();

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
                  "img-src 'self' data: media: https:; " + // Allow images from self, data URIs, HTTPS, and preview media URLs
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
    automationOutcomeService = new AutomationOutcomeService({
      repo: new AutomationRunOutcomeRepository(dbManager.getDatabase()),
      notify: async (params) => {
        const notificationService = getNotificationService();
        await notificationService?.add(params);
      },
    });
    UsageInsightsProjector.initialize(dbManager.getDatabase()).warm();
    if (startupQuietMode) {
      await dbManager.runPostStartupMaintenance();
    } else {
      deferStartupTask("database-maintenance", () =>
        dbManager.runPostStartupMaintenance(),
      );
    }
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
    healResettableSecureSettings();
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
      MemoryWriteGate.initialize(dbManager);
      MemoryService.initialize(dbManager);
      CuratedMemoryService.initialize(dbManager);

      // Initialize FTS worker thread for off-main-thread memory search
      const { FtsWorkerClient } = await import("./database/FtsWorkerClient");
      const ftsWorkerClient = new FtsWorkerClient(
        path.join(getUserDataDir(), "cowork-os.db"),
      );
      MemoryService.initFtsWorker(ftsWorkerClient);
      app.on("will-quit", () => ftsWorkerClient.destroy());

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
    try {
      symphonyService = new SymphonyService({
        db: dbManager.getDatabase(),
        agentDaemon,
        log: (...args) => logger.info(...args),
      });
      setSymphonyService(symphonyService);
      symphonyService.start();
      logger.info("Symphony issue orchestration initialized");
    } catch (error) {
      logger.error("Failed to initialize Symphony issue orchestration:", error);
    }

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
            } else {
              try {
                trayManager.showNotification(title, message, taskId);
              } catch (error) {
                console.error(
                  "[Main] Failed to show subconscious desktop notification:",
                  error,
                );
              }
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
      if (startupQuietMode) {
        logger.info("SubconsciousLoopService initialized (quiet mode; not started)");
      } else {
        await subconsciousLoopService.start(agentDaemon);
        logger.info("SubconsciousLoopService initialized");
      }
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

    const initializeMcpClientManager = async (): Promise<void> => {
      const mcpInitStartedAt = Date.now();
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.initialize();
      const mcpStartupSummary = mcpClientManager.getStartupStats();
      logger.info(
        `MCP summary: enabled=${mcpStartupSummary.enabled}, attempted=${mcpStartupSummary.attempted}, connected=${mcpStartupSummary.connected}, failed=${mcpStartupSummary.failed}`,
      );
      logger.info("MCP Client Manager initialized");
      logPhase("mcp-init", mcpInitStartedAt);
    };

    // Initialize MCP Client Manager in the background for desktop startup.
    // IPC settings handlers are already registered before first paint; network
    // handshakes do not need to block the first window.
    if (startupQuietMode) {
      logger.info("MCP Client Manager auto-connect skipped in quiet mode");
    } else if (HEADLESS) {
      try {
        await initializeMcpClientManager();
      } catch (error) {
        logger.error("Failed to initialize MCP Client Manager:", error);
      }
    } else {
      deferStartupTask("mcp-auto-connect", initializeMcpClientManager);
    }

    // Initialize Infrastructure Manager - restores wallet, configures providers
    if (startupQuietMode) {
      logger.info("InfraManager initialization skipped in quiet mode");
    } else {
      try {
        await InfraManager.getInstance().initialize();
        logger.info("InfraManager initialized");
      } catch (error) {
        logger.error("Failed to initialize InfraManager:", error);
        // Don't fail app startup if infra init fails
      }
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
        executeWorkflow: async ({ routineId, jobId, runAtMs }) => {
          if (!routineService) {
            throw new Error("Routine service has not finished starting.");
          }
          return routineService.runScheduledWorkflow(routineId, jobId, runAtMs);
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
              agentConfig: {
                ...preparedCouncilTask.agentConfig,
                ...(params.jobId ? { scheduledJobId: params.jobId } : {}),
              },
              source: "cron",
            });
            councilService?.bindRunTask(preparedCouncilTask.runId, task.id);
            return { id: task.id };
          }
          const allowUserInput = params.allowUserInput ?? false;
          const mergedAgentConfig = {
            ...(params.agentConfig ? params.agentConfig : {}),
            ...(params.modelKey ? { modelKey: params.modelKey } : {}),
            ...(params.jobId ? { scheduledJobId: params.jobId } : {}),
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
        sendTaskMessage: async (params) => {
          const task = taskRepo.findById(params.taskId);
          if (!task) {
            throw new Error(`Target task not found: ${params.taskId}`);
          }
          return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
            agentConfigOverride:
              params.agentConfig && Object.keys(params.agentConfig).length > 0
                ? {
                    ...params.agentConfig,
                    allowUserInput: params.allowUserInput ?? params.agentConfig.allowUserInput,
                  }
                : undefined,
          });
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
        findActiveTaskForJob: async (params) => {
          if (params.runMode !== "new_task") return null;
          const title = typeof params.taskTitle === "string" ? params.taskTitle.trim() : "";
          if (!title) return null;
          const activeStatuses = new Set([
            "queued",
            "planning",
            "executing",
            "interrupted",
            "paused",
            "blocked",
          ]);
          const tasks = taskRepo.findByWorkspace(params.workspaceId, 50, 0);
          const exactJobMatch = tasks.find(
            (task) =>
              task.source === "cron" &&
              task.agentConfig?.scheduledJobId === params.jobId &&
              activeStatuses.has(task.status),
          );
          if (exactJobMatch) {
            return { id: exactJobMatch.id, status: exactJobMatch.status };
          }
          if (!params.allowTitleFallback) return null;

          // Title fallback only exists for legacy tasks that predate scheduledJobId
          // tagging. If more than one untagged active cron task shares the title,
          // we cannot tell which job owns it — bail rather than risk linking a job
          // to another job's task.
          const titleMatches = tasks.filter(
            (task) =>
              task.source === "cron" &&
              !task.agentConfig?.scheduledJobId &&
              task.title === title &&
              activeStatuses.has(task.status),
          );
          if (titleMatches.length !== 1) return null;
          const match = titleMatches[0];
          return { id: match.id, status: match.status };
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
          debug: (msg, data) => logCron("debug", msg, data),
          info: (msg, data) => logCron("info", msg, data),
          warn: (msg, data) => logCron("warn", msg, data),
          error: (msg, data) => logCron("error", msg, data),
        },
      });
      setCronService(cronService);
      if (startupQuietMode) {
        logger.info("Cron Service initialized (quiet mode; not started)");
      } else {
        await cronService.start();
      }
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

    const initializeCustomSkillLoader = async (): Promise<void> => {
      const skillInitStartedAt = Date.now();
      const skillLoader = getCustomSkillLoader();
      await skillLoader.initialize();
      const skills = skillLoader.getLoadStats();
      logger.info(
        `Skills summary: total=${skills.total}, bundled=${skills.bundled}, external=${skills.external}, managed=${skills.managed}, workspace=${skills.workspace}, overrides=${skills.overridden}`,
      );
      logPhase("skills-init", skillInitStartedAt);
    };

    const initializePluginRegistry = async (): Promise<void> => {
      await initializeCustomSkillLoader();
      const pluginInitStartedAt = Date.now();
      const pluginRegistry = getPluginRegistry();
      await pluginRegistry.initialize();
      const plugins = pluginRegistry.getPlugins();
      const pluginStartupSummary = {
        loaded: plugins.length,
        enabled: plugins.filter((plugin: Any) => plugin.state === "enabled")
          .length,
      };
      logger.info(
        `Plugins summary: loaded=${pluginStartupSummary.loaded}, enabled=${pluginStartupSummary.enabled}`,
      );
      logger.info(`Plugin registry initialized (${plugins.length} plugins)`);
      logPhase("plugin-init", pluginInitStartedAt);
    };

    // Plugin discovery can involve filesystem and package metadata reads. Keep it
    // off the first-window path; handlers initialize it on demand if opened first.
    if (HEADLESS) {
      try {
        await initializePluginRegistry();
      } catch (error) {
        logger.error("Failed to initialize Plugin Registry:", error);
      }
    } else {
      deferStartupTask("skill-loader", initializeCustomSkillLoader);
      deferStartupTask("plugin-registry", initializePluginRegistry);
    }

    // Initialize channel gateway with agent daemon for task processing
    channelGateway = new ChannelGateway(dbManager.getDatabase(), {
      autoConnect: HEADLESS,
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
              ...options?.agentConfig,
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
        runWorkflowReflection: async ({ workspaceId }) => {
          const run = await subconsciousLoopService?.runFromHeartbeat(workspaceId);
          return run ? { id: run.id, outcome: run.outcome } : null;
        },
        runMemoryDreaming: async ({
          workspaceId,
          workspacePath,
          reason,
          signalCount,
          heartbeatRunId,
        }) => {
          const pressureInstructions = MemoryPressureService.buildCompactionInstructions(
            await MemoryPressureService.analyze(workspacePath),
          );
          const result = await new DreamingService(
            new DreamingRepository(dbManager.getDatabase()),
          ).run({
            workspaceId,
            workspacePath,
            triggerSource: "heartbeat",
            triggerHeartbeatRunId: heartbeatRunId,
            instructions: [
              `Heartbeat saw ${signalCount} memory signal(s): ${reason}`,
              pressureInstructions,
            ]
              .filter(Boolean)
              .join("\n\n"),
          });
          return {
            id: result.run.id,
            status: result.run.status,
            candidateCount: result.candidates.length,
          };
        },
        addNotification: async (params) => {
          const notificationService = getNotificationService();
          await notificationService?.add(params);
        },
        recordAutomationOutcome: async (outcome) =>
          automationOutcomeService?.record(outcome),
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
      if (startupQuietMode) {
        logger.info("HeartbeatService initialized (quiet mode; not started)");
      } else {
        await heartbeatService.start();
      }

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
      if (startupQuietMode) {
        logger.info("AutonomyEngine initialized (quiet mode; not started)");
      } else {
        await autonomyEngine.start();
        logger.info("AutonomyEngine initialized");
      }

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
        if (startupQuietMode) {
          logger.info("AwarenessService initialized (quiet mode; not started)");
        } else {
          await awarenessService.start();
          logger.info("AwarenessService initialized");
        }
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
          getSymphonyService: () => symphonyService,
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
        recordAutomationOutcome: async (outcome) =>
          automationOutcomeService?.record(outcome),
      });
      setStrategicPlannerService(strategicPlannerService);
      strategicPlannerService.start();
      logger.info("Strategic Planner initialized");
    } catch (error) {
      logger.error("Failed to initialize Strategic Planner:", error);
    }

    // Register Persona Template handlers; templates are loaded lazily when the
    // Digital Twins UI requests them.
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);
      const personaTemplateService = getPersonaTemplateService(agentRoleRepo);
      setupPersonaTemplateHandlers({ personaTemplateService });
      logger.debug("Persona Template handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Persona Template handlers:", error);
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
      const cpAllowedOrigins = getControlPlaneAllowedOriginsFromEnv();
      if (
        (typeof cpHost === "string" && cpHost.trim()) ||
        (typeof cpPort === "number" && Number.isFinite(cpPort)) ||
        typeof cpAllowedOrigins !== "undefined" ||
        process.env.COWORK_CONTROL_PLANE_TRUST_PROXY !== undefined
      ) {
        try {
          ControlPlaneSettingsManager.updateSettings({
            ...(typeof cpHost === "string" && cpHost.trim()
              ? { host: cpHost.trim() }
              : {}),
            ...(typeof cpPort === "number" && Number.isFinite(cpPort)
              ? { port: cpPort }
              : {}),
            ...(typeof cpAllowedOrigins !== "undefined"
              ? { allowedOrigins: cpAllowedOrigins }
              : {}),
            ...(process.env.COWORK_CONTROL_PLANE_TRUST_PROXY !== undefined
              ? { trustProxy: shouldTrustControlPlaneProxyFromEnv() }
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

    logStartupLane("blocking_startup", { event: "complete" });

    // Create window
    logStartupLane("first_window_startup", { event: "create_window_start" });
    createWindow();
    logStartupLane("first_window_startup", { event: "create_window_returned" });

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
        `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}, autoConnect=deferred`,
      );
      logPhase("channel-gateway-ui", channelInitStartedAt);
      if (startupQuietMode) {
        logger.info("Channels auto-connect skipped in quiet mode");
      } else {
        deferStartupTask("channel-auto-connect", async () => {
          await channelGateway.connectEnabledChannels({ timeoutMs: 10000 });
          const connectedStats = channelGateway.getStartupStats();
          logger.info(
            `Channels auto-connect complete: loaded=${connectedStats.loaded}, enabled=${connectedStats.enabled}, connected=${connectedStats.connected}`,
          );
          startXMentionBridge();
        });
      }
      // Initialize update manager with main window reference
      updateManager.setMainWindow(mainWindow);

      // Restore persisted canvas sessions after the first window is ready.
      if (!startupQuietMode) {
        deferStartupTask("canvas-session-restore", async () => {
          await CanvasManager.getInstance().restoreSessions();
        });
      }

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
        forceEnable: FORCE_ENABLE_CONTROL_PLANE || shouldAutoEnableDesktopControlPlane(),
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
          sendTaskMessage: async (params) => {
            const taskRepoForTrigger = new TaskRepository(db);
            const task = taskRepoForTrigger.findById(params.taskId);
            if (!task) {
              throw new Error(`Target task not found: ${params.taskId}`);
            }
            return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
              agentConfigOverride: params.agentConfig,
            });
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
          getActiveTaskCount: () => agentDaemon.getQueueStatus().runningTaskIds.length,
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
      const executeWorkflowAction = createRoutineWorkflowActionExecutor({
        createAgentTask: async (params) => {
          const task = await agentDaemon.createTask({
            title: params.title,
            prompt: params.prompt,
            workspaceId: params.workspaceId,
            source: "api",
          });
          return { id: task.id };
        },
        getTaskSnapshot: (taskId) => {
          const task = routineTaskRepo.findById(taskId);
          if (!task) return null;
          return {
            status: task.status,
            resultSummary: task.resultSummary,
            semanticSummary: task.semanticSummary,
            error: task.error,
          };
        },
        cancelAgentTask: (taskId) => agentDaemon.cancelTask(taskId),
      });
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
        sendTaskMessage: async (params) => {
          const task = routineTaskRepo.findById(params.taskId);
          if (!task) {
            throw new Error(`Target task not found: ${params.taskId}`);
          }
          return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
            agentConfigOverride: params.agentConfig,
          });
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
        executeWorkflowAction,
      });
      setupRoutineHandlers(routineService);
      routineService.startWorkflowRuntime();
      workflowStarterWatcher = new GoogleWorkspaceWorkflowStarterWatcher(db, routineService);
      workflowStarterWatcher.start();
      currentTriggerService.setFireInterceptor((trigger, event) =>
        routineService!.interceptManagedEventTrigger(trigger, event),
      );
      void routineService.reconcileStaleTimeoutRuns().catch((error) => {
        logger.debug("[Routines] Failed to reconcile stale timeout runs:", error);
      });
      const refreshRoutineRunsForTask = (payload: { taskId?: string }) => {
        const taskId = typeof payload?.taskId === "string" ? payload.taskId : "";
        if (!taskId) return;
        void routineService?.refreshRunsForTask(taskId).catch((error) => {
          logger.debug("[Routines] Failed to refresh routine task run:", error);
        });
      };
      agentDaemon.on("task_completed", refreshRoutineRunsForTask);
      agentDaemon.on("task_cancelled", refreshRoutineRunsForTask);
      agentDaemon.on("task_status", refreshRoutineRunsForTask);
      setHookAgentDispatchObserver((payload) => {
        routineService?.recordApiTriggerDispatch(payload);
      });
      setHookWorkflowDispatchObserver(async ({ routineId, payload, metadata }) => {
        if (!routineService) throw new Error("Routine service is not available");
        return routineService.runWebhookWorkflow(routineId, payload, metadata);
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
        log: (...args: unknown[]) => console.log(...args),
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
      const activeDailyBriefingService = dailyBriefingService;
      setupBriefingHandlers(dailyBriefingService, {
        onConfigSaved: async (workspaceId, config) => {
          await syncDailyBriefingCronJob(cronService, workspaceId, config);
        },
      });
      if (!startupQuietMode) {
        deferStartupTask("daily-briefing-schedule-sync", async () => {
          if (!cronService) return;
          const configuredRows = db
            .prepare("SELECT workspace_id FROM briefing_config")
            .all() as Array<{ workspace_id: string }>;
          const targetWorkspaceIds = new Set(
            configuredRows
              .map((row) => row.workspace_id)
              .filter((workspaceId) => typeof workspaceId === "string" && workspaceId.length > 0),
          );
          const jobs = await cronService.list({ includeDisabled: true });
          for (const job of jobs) {
            if (
              (job.name.startsWith("Daily Briefing:") ||
                (job.description || "").includes(DAILY_BRIEFING_MARKER)) &&
              job.workspaceId
            ) {
              targetWorkspaceIds.add(job.workspaceId);
            }
          }
          for (const workspaceId of targetWorkspaceIds) {
            await syncDailyBriefingCronJob(
              cronService,
              workspaceId,
              activeDailyBriefingService.getConfig(workspaceId),
            );
          }
        });
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
              let quotedAssistantMessage:
                | import("../shared/types").QuotedAssistantMessage
                | undefined;
              let options:
                | Pick<
                    import("../shared/types").TaskFollowUpInput,
                    "permissionMode" | "shellAccess" | "integrationMentions"
                  >
                | undefined;
              try {
                const sanitized = sanitizeTaskMessageParams(payload);
                taskId = sanitized.taskId;
                message = sanitized.message;
                images = sanitized.images;
                quotedAssistantMessage = sanitized.quotedAssistantMessage;
                options = {
                  ...(sanitized.permissionMode ? { permissionMode: sanitized.permissionMode } : {}),
                  ...(sanitized.shellAccess !== undefined ? { shellAccess: sanitized.shellAccess } : {}),
                  ...(sanitized.integrationMentions !== undefined
                    ? { integrationMentions: sanitized.integrationMentions }
                    : {}),
                };
              } catch (err) {
                throw new Error(
                  err instanceof Error
                    ? err.message
                    : "taskId and message are required.",
                );
              }
              return agentDaemon.sendMessage(taskId, message, images, quotedAssistantMessage, options);
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
    runDeferredStartupTasks();

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
    clearInterval(managedBriefingCleanupTimer);
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

    routineService?.stopWorkflowRuntime();
    workflowStarterWatcher?.stop();
    workflowStarterWatcher = null;

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
    if (symphonyService) {
      try {
        symphonyService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop Symphony service:", error);
      }
      symphonyService = null;
      setSymphonyService(null);
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

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_REGISTER, (_event, data: Any) => {
    if (
      !data ||
      typeof data.taskId !== "string" ||
      typeof data.webContentsId !== "number"
    ) {
      throw new Error("Invalid browser workbench registration");
    }
    getBrowserWorkbenchService().registerSession({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      webContentsId: data.webContentsId,
      url: typeof data.url === "string" ? data.url : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
    });
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_UNREGISTER, (_event, data: Any) => {
    if (!data || typeof data.taskId !== "string") return;
    getBrowserWorkbenchService().unregisterSession({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      webContentsId: typeof data.webContentsId === "number" ? data.webContentsId : undefined,
    });
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_STATUS, (_event, data: Any) => {
    if (!data || typeof data.taskId !== "string") return;
    getBrowserWorkbenchService().updateSessionStatus({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      webContentsId: typeof data.webContentsId === "number" ? data.webContentsId : undefined,
      url: typeof data.url === "string" ? data.url : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
    });
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_SCREENSHOT, async (_event, data: Any) => {
    if (
      !data ||
      typeof data.taskId !== "string" ||
      typeof data.workspacePath !== "string"
    ) {
      return { success: false, error: "Invalid browser screenshot request" };
    }
    const result = await getBrowserWorkbenchService().screenshot({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      workspacePath: data.workspacePath,
      filename: typeof data.filename === "string" ? data.filename : undefined,
      includeDataUrl: data.includeDataUrl === true,
      fullPage: data.fullPage === true,
    });
    if (!result) return { success: false, error: "No active browser workbench session" };
    return { success: true, ...result };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_INSPECT_POINT, async (_event, data: Any) => {
    if (
      !data ||
      typeof data.taskId !== "string" ||
      typeof data.x !== "number" ||
      typeof data.y !== "number"
    ) {
      return { success: false, error: "Invalid browser inspect request" };
    }
    const target = await getBrowserWorkbenchService().inspectPoint({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      x: data.x,
      y: data.y,
    });
    if (!target) return { success: false, error: "No inspectable element at that point" };
    return { success: true, target };
  });

  ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_RESOLVE_ANNOTATION_TARGETS, async (_event, data: Any) => {
    if (
      !data ||
      typeof data.taskId !== "string" ||
      !Array.isArray(data.targets)
    ) {
      return { success: false, error: "Invalid browser annotation target resolve request" };
    }
    const targets = await getBrowserWorkbenchService().resolveAnnotationTargets({
      taskId: data.taskId,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
      targets: data.targets.filter((target: Any) => target && typeof target === "object"),
    });
    return { success: true, targets };
  });

  const getAnnotationRepo = () => new AnnotationRepository(dbManager.getDatabase());
  const annotationSurfaceTypes = new Set(["browser", "diff", "file", "artifact", "message"]);
  const logAnnotationEvent = (type: string, annotation: Any, extra: Record<string, unknown> = {}) => {
    if (!annotation?.taskId) return;
    agentDaemon.logEvent(annotation.taskId, type, {
      annotationId: annotation.id,
      surfaceType: annotation.surfaceType,
      status: annotation.status,
      body: annotation.body,
      targetRef: annotation.targetRef,
      stylePatch: annotation.stylePatch,
      screenshotPath: annotation.screenshotPath,
      ...extra,
    });
  };

  ipcMain.handle(IPC_CHANNELS.ANNOTATION_CREATE, (_event, data: Any) => {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid annotation payload");
    }
    const taskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
    const body = typeof data.body === "string" ? data.body.trim() : "";
    const surfaceType = typeof data.surfaceType === "string" ? data.surfaceType.trim() : "";
    if (!taskId) throw new Error("Annotation taskId is required");
    if (!body) throw new Error("Annotation body is required");
    if (!annotationSurfaceTypes.has(surfaceType)) throw new Error("Annotation surfaceType is invalid");
    if (!data.targetRef || typeof data.targetRef !== "object") {
      throw new Error("Annotation targetRef is required");
    }

    const annotation = getAnnotationRepo().create({
      taskId,
      workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : undefined,
      surfaceType: surfaceType as Any,
      surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : undefined,
      body,
      targetRef: data.targetRef,
      stylePatch: data.stylePatch && typeof data.stylePatch === "object" ? data.stylePatch : undefined,
      artifactId: typeof data.artifactId === "string" ? data.artifactId : undefined,
      screenshotPath: typeof data.screenshotPath === "string" ? data.screenshotPath : undefined,
      createdBy: data.createdBy === "agent" || data.createdBy === "review" ? data.createdBy : "user",
    });
    logAnnotationEvent("annotation_created", annotation);
    return annotation;
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATION_LIST, (_event, query: Any) => {
    const normalized = query && typeof query === "object" ? query : {};
    return getAnnotationRepo().list({
      taskId: typeof normalized.taskId === "string" ? normalized.taskId : undefined,
      workspaceId: typeof normalized.workspaceId === "string" ? normalized.workspaceId : undefined,
      surfaceType: typeof normalized.surfaceType === "string" ? normalized.surfaceType : undefined,
      surfaceId: typeof normalized.surfaceId === "string" ? normalized.surfaceId : undefined,
      statuses: Array.isArray(normalized.statuses) ? normalized.statuses : undefined,
      limit: typeof normalized.limit === "number" ? normalized.limit : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATION_UPDATE, (_event, data: Any) => {
    const id = typeof data?.id === "string" ? data.id.trim() : "";
    if (!id) throw new Error("Annotation id is required");
    const patch = data?.patch && typeof data.patch === "object" ? data.patch : {};
    const annotation = getAnnotationRepo().update(id, patch);
    if (annotation) logAnnotationEvent("annotation_updated", annotation);
    return annotation || null;
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATION_RESOLVE, (_event, data: Any) => {
    const id = typeof data?.id === "string" ? data.id.trim() : "";
    if (!id) throw new Error("Annotation id is required");
    const annotation = getAnnotationRepo().update(id, {
      status: "resolved",
      resolvedByEventId: typeof data?.resolvedByEventId === "string" ? data.resolvedByEventId : undefined,
    });
    if (annotation) logAnnotationEvent("annotation_resolved", annotation);
    return annotation || null;
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATION_DISMISS, (_event, data: Any) => {
    const id = typeof data?.id === "string" ? data.id.trim() : "";
    if (!id) throw new Error("Annotation id is required");
    const annotation = getAnnotationRepo().update(id, { status: "dismissed" });
    if (annotation) logAnnotationEvent("annotation_dismissed", annotation);
    return annotation || null;
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
} // CLI direct-run guard
