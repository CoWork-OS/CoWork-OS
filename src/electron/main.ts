import {
  parseCliApprovalResponse as getCliApprovalResponseArgv,
  respondToCliApprovalResponse,
  type CliApprovalResponse,
} from "./agent/approval-cli";
import { BotNotificationService } from "./notifications/BotNotificationService";
import { BotNotificationRuntime } from "./notifications/BotNotificationRuntime";
import { BotWorkControlRecovery } from "./automation/BotWorkControlRecovery";
import { prepareResponsibilitySchedule } from "./automation/responsibility-signals";
import { BotResponsibilityRepository } from "./automation/BotResponsibilityRepository";
import { SchedulerOwnership } from "./automation/SchedulerOwnership";
import {
  connectorTriggerEvents,
  connectorTriggerSubscription,
} from "./automation/connector-trigger-events";
import { createHeadlessBotAutomation } from "./automation/headless-bot-services";
import { AutomationRuntime, setAutomationRuntime } from "./automation/AutomationRuntime";
import { PersistentDispatchBudget } from "./automation/PersistentDispatchBudget";
import { setBackgroundDispatchBudget } from "./agents/BackgroundDispatchBudget";
import {
  CoreEvalCaseRepository,
  CoreFailureClusterRepository,
  CoreFailureRecordRepository,
  CoreHarnessExperimentRepository,
  CoreLearningsRepository,
  CoreMemoryCandidateRepository,
  CoreMemoryCleanupRepository,
  CoreMemoryDistillRunRepository,
  CoreMemoryScopeStateRepository,
  CoreRegressionGateRepository,
  CoreTraceRepository,
} from "./core/core-repository-facades";
import {
  AgentRoleRepository,
  AutomationProfileRepository,
  MentionRepository,
  TaskSubscriptionRepository,
  WorkingStateRepository,
} from "./agents/agent-repository-facades";
import { ChannelRepository, ChannelUserRepository } from "./database/repository-facades";
import {
  AnnotationRepository,
  ChannelMessageRepository,
  TaskEventReplayRepository,
  TaskRepository,
  WorkspaceRepository,
} from "./database/repository-facades";
import path from "path";
import os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { createHash, randomUUID } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  session,
  shell,
  nativeTheme,
  Menu,
  nativeImage,
  screen,
  safeStorage,
  webContents,
  type BrowserWindowConstructorOptions,
} from "electron";
import mime from "mime-types";
import { attachImageContextMenu } from "./utils/image-context-menu";
import { closeWindowsForShutdown, installGracefulShutdown } from "./utils/graceful-shutdown";
import { DatabaseManager } from "./database/schema";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "./database/SecureSettingsRepository";
import { resetUnreadableSettings } from "./utils/secure-settings-recovery";
import {
  setupIpcHandlers,
  getHooksServer,
  getNotificationService,
  setHeartbeatWakeSubmitter,
  setHookAgentDispatchObserver,
  setHookWorkflowDispatchObserver,
  setHookTriggerEmitter,
  waitForComposerDraftWrites,
} from "./ipc/handlers";
import { setupMissionControlHandlers } from "./ipc/mission-control-handlers";
import { setupPluginPackHandlers } from "./ipc/plugin-pack-handlers";
import { setupPluginDistributionHandlers } from "./ipc/plugin-distribution-handlers";
import { setupAdminPolicyHandlers } from "./ipc/admin-policy-handlers";
import { setupAgentSecurityHandlers } from "./ipc/agent-security-handlers";
import { NumbatService } from "./security/numbat";
import { setupWorktreeHandlers } from "./ipc/worktree-handlers";

import { UsageInsightsProjector } from "./reports/UsageInsightsProjector";
import { describeCronRunStatus } from "../shared/cron-outcomes";
import { PulseService } from "./telemetry/pulse-service";
import {
  HeartbeatService,
  HeartbeatServiceDeps,
  setHeartbeatService,
} from "./agents/HeartbeatService";
import { setHeartbeatSignalEmitter } from "./agents/heartbeat-signal-bus";

import { ActivityRepository } from "./activity/activity-repository-facades";

import type { KitWriterOwnership } from "./agents/kit-writer-ownership";
import { createKitWriterOwnership } from "./agents/kit-writers";

import { AutomationRunOutcomeRepository } from "./automation/automation-outcome-repository-facades";
import { AutomationOutcomeService } from "./automation/AutomationOutcomeService";
import { RecurringApprovalService } from "./security/recurring-approval-repository-facades";
import { ProactiveSuggestionsService } from "./agent/ProactiveSuggestionsService";
import { AgentDaemon } from "./agent/daemon";
import { approvalPromptsDisabled } from "./agent/approval-policy";

import { CoreMemoryCandidateService } from "./core/CoreMemoryCandidateService";

import { CoreMemoryDistiller } from "./core/CoreMemoryDistiller";

import { CoreEvalCaseService } from "./core/CoreEvalCaseService";

import { CoreFailureClusterService } from "./core/CoreFailureClusterService";
import { CoreFailureMiningService } from "./core/CoreFailureMiningService";

import { CoreHarnessExperimentRunner } from "./core/CoreHarnessExperimentRunner";
import { CoreHarnessExperimentService } from "./core/CoreHarnessExperimentService";
import { CoreLearningPipelineService } from "./core/CoreLearningPipelineService";

import { CoreLearningsService } from "./core/CoreLearningsService";

import { CoreRegressionGateService } from "./core/CoreRegressionGateService";
import { CoreMemoryScopeResolver } from "./core/CoreMemoryScopeResolver";

import { CoreTraceService } from "./core/CoreTraceService";
// Runtime wiring keeps the host stores: its service callbacks are synchronous (storage slice C).
import { TaskEventRepository, TaskStore, WorkspaceStore } from "./database/repositories";
import { LLMProviderFactory } from "./agent/llm";
import { ModelMetadataRefresher } from "./agent/llm/model-metadata-refresh";
import { SearchProviderFactory } from "./agent/search";
import { ChannelGateway } from "./gateway";
import { formatChatTranscriptForPrompt, prefetchTranscriptUsers } from "./gateway/chat-transcript";
import { updateManager } from "./updater";
import { importProcessEnvToSettings, migrateEnvToSettings } from "./utils/env-migration";
import {
  TEMP_WORKSPACE_ID,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  IPC_CHANNELS,
  isTempWorkspaceId,
} from "../shared/types";
import type { Task, TaskStatus } from "../shared/types";
import { isAutomatedTaskLike } from "../shared/automated-task-detection";
import { shouldUseNativeWindowFrame } from "../shared/native-window-frame";
import { GuardrailManager } from "./guardrails/guardrail-manager";
import { AppearanceManager } from "./settings/appearance-manager";
import { MemoryFeaturesManager } from "./settings/memory-features-manager";
import { PersonalityManager } from "./settings/personality-manager";
import { MCPClientManager } from "./mcp/client/MCPClientManager";
import { MCPEventService } from "./mcp/events/MCPEventService";
import { trayManager } from "./tray";
import {
  CRON_ACTIVE_TASK_STATUSES,
  CronService,
  setCronService,
  getCronStorePath,
  type CronEvent,
} from "./cron";
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
import { DurableContextService } from "./memory/DurableContextService";
import { BoxBrainService } from "./memory/BoxBrainService";
import { MemoryRetentionService } from "./memory/MemoryRetentionService";
import { CuratedMemoryService } from "./memory/CuratedMemoryService";
import { startMemoryEngine } from "./memory/memory-engine-bootstrap";
import { startMemoryRepo, stopMemoryRepo } from "./memory/repo/memory-repo-bootstrap";
import { getMemoryRepoDreamer } from "./memory/repo/MemoryRepoDreamer";
import { MemoryWriter } from "./memory/MemoryWriter";
import { MemoryWriteGate } from "./memory/MemoryWriteGate";
import { createCommitmentExpiryService } from "./memory/memory-review-wiring";
import { loadPolicies } from "./admin/policies";
import {
  assertWorkspaceFilesystemAccess,
  evaluateWorkspaceFilesystemAccess,
} from "./security/access-profile-paths";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "./security/access-profile-resolver";
import { PermissionSettingsManager } from "./security/permission-settings-manager";
import { openExternalIfSafe } from "./security/safe-external-url";
import { MCPRegistryManager } from "./mcp/registry/MCPRegistryManager";
import {
  ChronicleCaptureService,
  ChronicleMemoryService,
  ChronicleSettingsManager,
} from "./chronicle";
import { revealWindow } from "./utils/window-visibility";
import { StartupActionGate } from "./utils/startup-action-gate";
import { KnowledgeGraphService } from "./knowledge-graph/KnowledgeGraphService";
import { MailboxAutomationHub } from "./mailbox/MailboxAutomationHub";
import { MailboxAutomationRegistry } from "./mailbox/MailboxAutomationRegistry";
import { MailboxForwardingService } from "./mailbox/MailboxForwardingService";
import { getMailboxServiceInstance, MailboxService } from "./mailbox/MailboxService";
import { setMailboxForwardingServiceInstance } from "./mailbox/mailbox-forwarding-singleton";
import {
  ControlPlaneSettingsManager,
  setupControlPlaneHandlers,
  shutdownControlPlane,
  startControlPlaneFromSettings,
  getControlPlaneServer,
} from "./control-plane";
import { createWebHostIdentity } from "../host/web/host-identity";
import { createBrowserHostApplication } from "../host/services/browser-host-application";
import { isBrowserWebEnabled, webDeploymentFromEnv } from "../host/services/browser-web-config";
import type { WebApplication } from "../host/web/WebApplication";
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
import { getActiveProfileId, getUserDataDir, hasNonDefaultProfile } from "./utils/user-data-dir";
import type { AccessProfileId } from "../shared/access-profiles";
// Live Canvas feature
import { registerCanvasScheme, registerCanvasProtocol, CanvasManager } from "./canvas";
import { setupCanvasHandlers, cleanupCanvasHandlers } from "./ipc/canvas-handlers";
import { setupQAHandlers } from "./ipc/qa-handlers";
import { getBrowserWorkbenchService } from "./browser/browser-workbench-service";
import { getLocalPreviewProcessService } from "./preview/LocalPreviewProcessService";
import { getBrowserSessionManager } from "./browser/browser-session-manager";
import { attachBrowserGuest } from "./browser/browser-guest-attach";
import { applyBrowserUserAgent } from "./browser/browser-user-agent";
import { BrowserDownloadManager } from "./browser/browser-download-manager";
import {
  createBrowserHistoryRecorder,
  registerBrowserPlatformIpc,
} from "./browser/browser-platform-ipc";
import { BrowserSettingsManager } from "./settings/browser-settings-manager";
import { browserProfileKeyFromPartition } from "../shared/browser-profile";
import { matchBrowserShortcut } from "../shared/browser-shortcuts";
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
import { syncDailyBriefingCronJob, DAILY_BRIEFING_MARKER } from "./briefing/briefing-scheduler";
import {
  readWorkspaceOpenLoops,
  readWorkspacePriorities,
} from "./briefing/workspace-briefing-context";
import { setupBriefingHandlers } from "./ipc/briefing-handlers";
import { setupMeetingArtifactHandlers } from "./ipc/meeting-artifacts-handlers";
import { MeetingArtifactsService } from "./meetings/meeting-artifacts-service";
import { setupImprovementHandlers, setupSubconsciousHandlers } from "./ipc/subconscious-handlers";
import { FileHubService } from "./file-hub/FileHubService";
import { setupFileHubHandlers } from "./ipc/file-hub-handlers";
import { HooksSettingsManager } from "./hooks/settings";
import { WebAccessServer } from "./web-server/WebAccessServer";
import { DEFAULT_WEB_ACCESS_CONFIG, type WebAccessConfig } from "./web-server/types";
import { setupWebAccessHandlers } from "./ipc/web-access-handlers";
import {
  ManagedAccountManager,
  type ManagedAccountStatus,
} from "./accounts/managed-account-manager";
import {
  getDesktopLocationService,
  registerLocationProbeScheme,
} from "./location/DesktopLocationService";
import { AmbientMonitoringService } from "./monitoring/AmbientMonitoringService";
import { AwarenessService } from "./awareness/AwarenessService";
import { SubconsciousLoopService } from "./subconscious/SubconsciousLoopService";
import { ManagedSessionService } from "./managed/ManagedSessionService";
import { WorkContextService } from "./workspaces/workspaces-repository-facades";
import { createLogger } from "./utils/logger";
import { startHostPerfMonitor, type HostPerfMonitorHandle } from "./utils/host-perf-monitor";
import {
  MigrationLockTimeoutError,
  UnsupportedSchemaVersionError,
} from "./database/profile-lifecycle";
import {
  getDatabaseClient,
  startDatabaseWorker,
  startReportingReader,
  stopDatabaseWorker,
} from "./database/async/runtime";
import {
  registerMediaProtocol,
  registerMediaScheme,
  registerWebPreviewProtocol,
  registerWebPreviewScheme,
} from "./media";
import { rememberApprovedImportFiles } from "./security/file-import-approvals";
import { healMovedDesktopWorkspacePaths } from "./utils/workspace-path-healer";
import {
  APP_DISPLAY_NAME,
  MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG,
  applyApplicationIdentity,
  getDesktopIconImage,
  getDesktopIconPath,
} from "./branding";
import { primeMacSafeStorageContext } from "./utils/mac-safe-storage-bootstrap";
import { getSafeStorage } from "./utils/safe-storage";
import {
  keepDirectRunAliveWithoutWindows,
  stripInjectedSystemCaOption,
} from "./utils/direct-run-lifecycle";
import {
  runMacSafeStorageMigrationWorker,
  migrateLegacyMacSafeStorageChannels,
  migrateLegacyMacSafeStorageSettings,
} from "./utils/mac-safe-storage-migration";

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let browserWebApplication: WebApplication | null = null;
let browserPairingControlPlane: ReturnType<typeof getControlPlaneServer> = null;
let webAccessServerRef: WebAccessServer | null = null;

async function attachBrowserWebApplication(webAccessServer?: WebAccessServer): Promise<void> {
  if (!isBrowserWebEnabled()) return;
  try {
    if (!browserWebApplication) {
      const identity = await createWebHostIdentity({
        userDataDir: getUserDataDir(),
        profileId: getActiveProfileId(),
        runtime: "electron",
        appVersion: app.getVersion(),
      });
      browserWebApplication = createBrowserHostApplication({
        db: dbManager.getDatabase(),
        webDirectory: path.join(app.getAppPath(), "dist", "web"),
        deployment: webDeploymentFromEnv(),
        identity,
        taskCommands: agentDaemon,
        agentDaemon,
        channelGateway,
        notificationService: getNotificationService() ?? undefined,
        getRoutineService: () => routineService,
        getEventTriggerService: () => eventTriggerService,
        getHeartbeatService: () => heartbeatService,
      });
    }

    const controlPlane = getControlPlaneServer();
    if (controlPlane?.isRunning && controlPlane !== browserPairingControlPlane) {
      await controlPlane.setWebApplication(browserWebApplication);
      controlPlane.registerMethod("web.pair", async (client) => {
        if (!client.hasScope("admin")) throw new Error("Admin scope is required.");
        return browserWebApplication!.createPairingCode("control-plane");
      });
      browserPairingControlPlane = controlPlane;
    }
    if (webAccessServer) await webAccessServer.setWebApplication(browserWebApplication);
  } catch (error) {
    console.error("[BrowserWeb] Failed to attach browser application:", error);
  }
}
/** Whether the database worker settled every accepted operation at shutdown (DB6). */
let databaseWorkerDrained = true;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;
const automationRuntime = new AutomationRuntime(isHeadlessMode() ? "electron_headless" : "desktop");
let headlessBotAutomation: ReturnType<typeof createHeadlessBotAutomation> | null = null;
let cronService: CronService | null = null;
let pulseService: PulseService | null = null;
let hostPerfMonitor: HostPerfMonitorHandle | null = null;
let dailyBriefingService: DailyBriefingService | null = null;
let ambientMonitoringService: AmbientMonitoringService | null = null;
let mailboxForwardingService: MailboxForwardingService | null = null;
let heartbeatService: HeartbeatService | null = null;
let awarenessService: AwarenessService | null = null;
let subconsciousLoopService: SubconsciousLoopService | null = null;
// CrossSignal, Feedback and Lore: run only while this process owns the kit-writer lease.
let kitWriterOwnership: KitWriterOwnership | null = null;
let strategicPlannerService: StrategicPlannerService | null = null;
let automationOutcomeService: AutomationOutcomeService | null = null;
let recurringApprovalService: RecurringApprovalService | null = null;
let eventTriggerService: EventTriggerService | null = null;
let mcpEventService: MCPEventService | null = null;
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
let memoryRetentionService: MemoryRetentionService | null = null;
/** Stops the memory engine's deferred jobs (lane migration, read-side syncs). */
let stopMemoryEngine: (() => void) | null = null;
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
const managedBriefingCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - MANAGED_BRIEFING_TTL_MS;
    for (const [key, value] of managedBriefingRuns) {
      if (value.generatedAt < cutoff) managedBriefingRuns.delete(key);
    }
  },
  60 * 60 * 1000,
);

const HEADLESS = isHeadlessMode();
// Worker threads do not inherit argv; the env flag keeps their headless policy aligned.
if (HEADLESS) process.env.COWORK_HEADLESS = "1";
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

/** One unit (DB6); runs before core automation profiles are ensured. */
async function normalizeTemplatedRoleCoreBoundary(): Promise<void> {
  try {
    const { roleCount, changes } = await new AgentRoleRepository(
      dbManager.getDatabase(),
    ).detachTemplatedRolesFromCoreAutomation(Date.now());
    if (changes > 0) {
      logger.info("Detached templated agent roles from core automation", { roleCount, changes });
    }
  } catch (error) {
    logger.error("Failed to detach templated agent roles from core automation:", error);
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
      role.pulseEveryMinutes ||
      role.heartbeatIntervalMinutes ||
      (role.autonomyLevel === "lead" ? 20 : 30),
    staggerOffsetMinutes: role.heartbeatStaggerOffset || 0,
    dispatchCooldownMinutes:
      role.dispatchCooldownMinutes || (role.autonomyLevel === "lead" ? 90 : 120),
    maxDispatchesPerDay: role.maxDispatchesPerDay || (role.autonomyLevel === "lead" ? 6 : 4),
    profile: role.heartbeatProfile || (role.autonomyLevel === "lead" ? "dispatcher" : "observer"),
    activeHours: role.activeHours,
  };
}

async function ensureCoreAutomationProfiles(): Promise<void> {
  const db = dbManager.getDatabase();
  const agentRoleRepo = new AgentRoleRepository(db);
  const automationProfileRepo = new AutomationProfileRepository(db);

  const addedAgents = await agentRoleRepo.syncNewDefaults();
  if (addedAgents.length > 0) {
    logger.info(`Added ${addedAgents.length} new default agent(s)`);
  }

  const eligibleRoles = (await agentRoleRepo.findAll(false)).filter(
    (role) =>
      role.roleKind !== "persona_template" &&
      (role.roleKind === "system" || role.roleKind === "custom"),
  );
  if (!eligibleRoles.length) {
    return;
  }

  const existingProfiles = new Map(
    (await automationProfileRepo.listAll()).map((profile) => [profile.agentRoleId, profile]),
  );

  let createdCount = 0;
  for (const role of eligibleRoles) {
    if (existingProfiles.has(role.id)) {
      continue;
    }
    const seeded = buildDefaultAutomationProfile(role);
    const created = await automationProfileRepo.create({
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

  const totalProfiles = await automationProfileRepo.listAll();
  const enabledProfiles = totalProfiles.filter((profile) => profile.enabled);
  logger.info("Core automation profiles ready", {
    eligibleRoleCount: eligibleRoles.length,
    profileCount: totalProfiles.length,
    enabledProfileCount: enabledProfiles.length,
    createdCount,
    enabledRoles: await Promise.all(
      enabledProfiles
        .slice(0, 10)
        .map(
          async (profile) =>
            (await agentRoleRepo.findById(profile.agentRoleId))?.name || profile.agentRoleId,
        ),
    ),
  });
}

const BROWSER_WORKBENCH_PARTITION_PREFIX = "persist:cowork-browser-";
/** Sessions of in-app browser partitions (-> partition), prepared before their first guest attaches. */
const browserWorkbenchSessions = new WeakMap<object, string>();
let browserDownloadManager: BrowserDownloadManager | null = null;

function getBrowserDownloadManager(): BrowserDownloadManager {
  if (!browserDownloadManager) {
    browserDownloadManager = new BrowserDownloadManager({
      service: getBrowserWorkbenchService(),
      manager: getBrowserSessionManager(),
      loadSettings: () => BrowserSettingsManager.loadSettings(),
      resolveWorkspace: (taskId) => agentDaemon?.getEffectiveWorkspaceForTask(taskId) || null,
      assertWorkspaceWrite: (workspace, relativePath) =>
        assertWorkspaceFilesystemAccess(
          { path: workspace.path, permissions: workspace.permissions },
          relativePath,
          "write",
          "browser download",
        ),
      requestApproval: (taskId, description, details) =>
        agentDaemon
          ? agentDaemon.requestApproval(taskId, "browser", description, details, {
              allowAutoApprove: false,
            })
          : Promise.resolve(false),
      systemDownloadsDir: () => app.getPath("downloads"),
      openPath: (filePath) => shell.openPath(filePath),
      showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    });
  }
  return browserDownloadManager;
}

/**
 * Network guards, user agent and site-permission handlers for an in-app browser
 * partition. Runs in will-attach-webview, before the guest exists, so nothing
 * on the partition can load or be granted anything first.
 */
function prepareBrowserWorkbenchPartition(partition: string): void {
  const browserSession = session.fromPartition(partition);
  getBrowserSessionManager().prepareSessionNetworkGuards(browserSession);
  applyBrowserUserAgent(
    browserSession,
    BrowserSettingsManager.loadSettings().chromeCompatibleUserAgent,
  );
  getBrowserWorkbenchService().getPermissionManager().attach(browserSession, partition);
  getBrowserDownloadManager().attach(browserSession);
  browserWorkbenchSessions.set(browserSession, partition);
}

app.on("web-contents-created", (_event, contents) => {
  attachImageContextMenu(contents, clipboard);
  contents.on("did-attach-webview", (_event, guest) => {
    CanvasManager.getInstance().attachWebviewNetworkGuards(guest);
    const browserPartition = browserWorkbenchSessions.get(guest.session);
    if (browserPartition) {
      const profileKey = browserProfileKeyFromPartition(browserPartition) || "default";
      // Pages may open windows (allowpopups is kept for these partitions), so the
      // handler must exist before the guest loads anything past about:blank.
      attachBrowserGuest(guest, {
        service: getBrowserWorkbenchService(),
        manager: getBrowserSessionManager(),
        BrowserWindow,
        getParentWindow: () => mainWindow,
        Menu,
        writeClipboardText: (text) => {
          void clipboard.writeText(text);
        },
        openExternal: (url) => void openExternalIfSafe(url),
        recordHistory: createBrowserHistoryRecorder(() => dbManager.getDatabase(), profileKey),
        isDeveloperMode: () => BrowserSettingsManager.loadSettings().developerMode,
      });
    }
  });
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
    delete (webPreferences as Record<string, unknown>).preloadURL;
    delete (webPreferences as Record<string, unknown>).additionalArguments;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;

    const partition = String(params?.partition || webPreferences.partition || "");
    const isBrowserWorkbench = partition.startsWith(BROWSER_WORKBENCH_PARTITION_PREFIX);
    if (params) {
      delete (params as Record<string, unknown>).preload;
      delete (params as Record<string, unknown>).preloadURL;
      // In-app browser guests route window.open through attachBrowserGuest; every
      // other webview keeps popups disabled.
      if (!isBrowserWorkbench) delete (params as Record<string, unknown>).allowpopups;
    }

    const targetUrl = typeof params?.src === "string" ? params.src : "";
    if (isBrowserWorkbench) {
      try {
        prepareBrowserWorkbenchPartition(partition);
      } catch (error) {
        logger.warn("Blocked browser webview: partition guards could not be installed", error);
        event.preventDefault();
        return;
      }
    }
    if (isBrowserWorkbench && targetUrl !== "about:blank") {
      event.preventDefault();
      return;
    }
    try {
      CanvasManager.getInstance().prepareWebview(webPreferences, params);
    } catch {
      event.preventDefault();
      return;
    }
    const browserWorkbenchService = getBrowserWorkbenchService();
    if (
      !isAllowedWebviewUrl(targetUrl) &&
      !browserWorkbenchService.isAllowedLocalPreviewUrl(targetUrl)
    ) {
      logger.warn(`Blocked webview attachment for disallowed URL: ${targetUrl || "<empty>"}`);
      event.preventDefault();
    }
  });
});

/** True while keyboard focus is inside the browser workbench chrome (reported by the renderer). */
let browserWorkbenchChromeFocused = false;

/**
 * App-window input for the browser workbench: while its chrome has focus, the
 * browser shortcuts (Cmd+R, Cmd+W, Cmd+0 ...) run as browser commands instead of
 * the app menu's reload/close/zoom. Trackpad swipes and mouse back/forward
 * buttons go back and forward in the visible tab.
 */
function attachBrowserWorkbenchWindowInput(window: BrowserWindow): void {
  // A reload, crash or app switch must never leave app shortcuts captured.
  const releaseShortcuts = () => {
    browserWorkbenchChromeFocused = false;
  };
  window.on("blur", releaseShortcuts);
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) releaseShortcuts();
  });
  window.webContents.on("render-process-gone", releaseShortcuts);
  window.webContents.on("before-input-event", (event, input) => {
    if (!browserWorkbenchChromeFocused || input.type !== "keyDown") return;
    const command = matchBrowserShortcut(
      {
        key: input.key,
        code: input.code,
        ctrl: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
      },
      process.platform,
    );
    if (!command) return;
    event.preventDefault();
    getBrowserWorkbenchService().sendShortcut(undefined, command);
  });
  window.on("swipe", (_event, direction) => {
    if (direction === "left") getBrowserWorkbenchService().sendShortcut(undefined, "back", true);
    if (direction === "right")
      getBrowserWorkbenchService().sendShortcut(undefined, "forward", true);
  });
  window.on("app-command", (_event, command) => {
    if (command === "browser-backward") {
      getBrowserWorkbenchService().sendShortcut(undefined, "back", true);
    } else if (command === "browser-forward") {
      getBrowserWorkbenchService().sendShortcut(undefined, "forward", true);
    }
  });
}

/** Tab ids arrive from the renderer: accept short plain tokens only. */
function readBrowserTabId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,120}$/.test(trimmed) ? trimmed : undefined;
}

const submitHeartbeatSignalForAll = async (input: {
  text?: string;
  mode?: "now" | "next-heartbeat";
  source?: "hook" | "cron" | "api" | "manual";
  workspaceId?: string;
  category?: string;
}): Promise<void> => {
  await heartbeatService?.submitWakeForAll(input);
};

function getDevServerUrl(): string {
  const configured = String(process.env.COWORK_DEV_SERVER_URL || "").trim();
  if (configured.length > 0) {
    return configured;
  }

  const port = String(process.env.COWORK_DEV_SERVER_PORT || "5173").trim() || "5173";
  return `http://127.0.0.1:${port}`;
}

/**
 * Ask the user to approve the launch command of an MCP server that came from
 * the remote registry, showing the exact command and arguments.
 *
 * Installing such an entry spawns whatever command the registry response
 * supplied, in the main process's environment — so this is a code-execution
 * decision. It is also reachable without any UI, via the agent's
 * `integration_setup` tool, which prompt injection can trigger; routing both
 * paths through this dialog is the point.
 */
function installMcpInstallConfirmationHandler(): void {
  MCPRegistryManager.setInstallConfirmationHandler(async (request) => {
    const lines = [
      `Publisher: ${request.publisher || "unknown"}`,
      `Transport: ${request.transport}`,
    ];
    if (request.command) {
      lines.push("", "Command that will run:", `  ${request.command} ${request.args.join(" ")}`);
    }
    if (request.url) {
      lines.push("", `Endpoint: ${request.url}`);
    }
    if (request.envKeys.length > 0) {
      lines.push("", `Environment variables set: ${request.envKeys.join(", ")}`);
    }
    lines.push(
      "",
      "This command comes from the online MCP registry, not from CoWork OS, and will run with the same privileges as the app.",
    );

    const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Cancel", "Install and run"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm MCP server installation",
      message: `Install "${request.name}" from the online registry?`,
      detail: lines.join("\n"),
      noLink: true,
    };

    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  });
}

/**
 * True when `url` belongs to the app's own renderer bundle or dev server.
 *
 * Compares parsed origins and requires a path-separator boundary rather than a
 * bare string prefix: `startsWith("http://localhost:5173")` also matches
 * `http://localhost:5173.attacker.tld`, and a `file://.../renderer` prefix also
 * matches a sibling `.../renderer-evil/` directory.
 *
 * The file: branch converts via `fileURLToPath`, not
 * `path.resolve(decodeURIComponent(pathname))`. On Windows a file URL's
 * pathname is `/C:/…`, which `path.win32.resolve` treats as drive-less and
 * prefixes with the cwd's drive (`C:\C:\…`) — so the app's own page would fail
 * containment and `will-navigate` would push it out to the system browser.
 */
function isAppOwnedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (process.env.NODE_ENV === "development") {
    try {
      return parsed.origin === new URL(getDevServerUrl()).origin;
    } catch {
      return false;
    }
  }

  if (parsed.protocol !== "file:") return false;
  let target: string;
  try {
    target = path.resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const rendererRoot = path.resolve(__dirname, "../../renderer");
  const relative = path.relative(rendererRoot, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    const horizontalOverlap = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const verticalOverlap = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
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
    Math.round(isFinitePositiveNumber(saved?.width) ? saved.width : MAIN_WINDOW_DEFAULT_WIDTH),
  );
  const height = Math.max(
    MAIN_WINDOW_MIN_HEIGHT,
    Math.round(isFinitePositiveNumber(saved?.height) ? saved.height : MAIN_WINDOW_DEFAULT_HEIGHT),
  );
  const x = typeof saved?.x === "number" ? Math.round(saved.x) : undefined;
  const y = typeof saved?.y === "number" ? Math.round(saved.y) : undefined;

  if (x !== undefined && y !== undefined && isWindowBoundsOnScreen({ x, y, width, height })) {
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
  if (window.isDestroyed() || (window.isMinimized() && options.allowMinimized !== true)) {
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
    lastNormalBounds = writeMainWindowState(window, { allowMinimized: true }) ?? lastNormalBounds;
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
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "CoWork OS on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/CoWork-OS/CoWork-OS");
          },
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

function logCron(level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown): void {
  if (data === undefined) {
    cronLogger[level](msg);
    return;
  }
  cronLogger[level](msg, data);
}

const RESETTABLE_SECURE_SETTINGS_CATEGORIES: SettingsCategory[] = [
  "subconscious-migration-v1",
  "awareness-state",
  "webaccess",
  // PACT business grants and pending sign-ins can be re-consented; the runtime marks grants whose
  // tokens are gone as invalid. Signer configuration (pact:signer) is never reset silently.
  "pact:grants",
  "pact:authorization",
];

const ACCEPT_NEW_KEYCHAIN_KEY_ENV = "COWORK_ACCEPT_NEW_KEYCHAIN_KEY";
let keychainIdentityMismatch = false;

/** Returns true when secure-settings writes are refused because the keychain key changed. */
function verifySecureSettingsKeychainIdentity(): boolean {
  const repository = SecureSettingsRepository.getInstance();
  const status = repository.verifyKeychainIdentity();
  if (status !== "mismatch") return false;

  if (process.env[ACCEPT_NEW_KEYCHAIN_KEY_ENV] === "1") {
    const archived = repository.adoptCurrentKeychainIdentity();
    logger.warn("Adopted the current OS keychain key; unreadable settings were archived.", {
      archived,
    });
    return false;
  }
  logger.error(
    `The OS keychain key differs from the one that encrypted existing settings. Settings changes will not be saved until the original keychain access is restored, or relaunch with ${ACCEPT_NEW_KEYCHAIN_KEY_ENV}=1 to archive unreadable settings and continue with the current key.`,
  );
  return true;
}

async function notifyKeychainIdentityMismatch(): Promise<void> {
  if (!keychainIdentityMismatch) return;
  try {
    await getNotificationService()?.add({
      type: "error",
      title: "Settings can't be saved",
      message:
        "CoWork OS can't use the Keychain key that encrypted your settings, so changes won't be saved to avoid losing them. Allow CoWork OS access to \"CoWork OS Safe Storage\" in Keychain Access and relaunch. To start over with the current key, relaunch with COWORK_ACCEPT_NEW_KEYCHAIN_KEY=1; unreadable settings are archived, not deleted.",
    });
  } catch (error) {
    logger.warn("Could not show the keychain mismatch notification:", error);
  }
}

function healResettableSecureSettings(): void {
  if (!SecureSettingsRepository.isInitialized()) {
    return;
  }

  const repository = SecureSettingsRepository.getInstance();
  const recovery = resetUnreadableSettings(repository, RESETTABLE_SECURE_SETTINGS_CATEGORIES);
  for (const category of recovery.resetCategories) {
    logger.warn(
      `Reset secure settings category ${category} after a verified checksum mismatch; defaults will be recreated.`,
    );
  }
  for (const { category, status } of recovery.preservedCategories) {
    logger.error(
      `Preserved secure settings category ${category} (${status}); encrypted data was not deleted and must be recovered before replacement.`,
    );
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
let pendingBotDeeplink: { botId: string; conversationId?: string } | null = null;

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

function parseBotDeeplink(value: string): { botId: string; conversationId?: string } | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== `${TASK_DEEPLINK_PROTOCOL}:` || parsed.hostname !== "bots") {
      return null;
    }
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const botId = parts[0] || "";
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) return null;
    if (parts.length === 1) return { botId };
    if (parts.length !== 3 || parts[1] !== "conversations") return null;
    const conversationId = parts[2];
    if (!TASK_DEEPLINK_UUID_RE.test(conversationId)) return null;
    return { botId, conversationId };
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

function extractBotDeeplinkArg(argv: string[]): { botId: string; conversationId?: string } | null {
  for (const arg of argv) {
    const parsed = parseBotDeeplink(arg);
    if (parsed) return parsed;
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
    logger.warn(
      `Failed to register ${TASK_DEEPLINK_PROTOCOL}:// deeplink handler: ${toErrorMessage(error)}`,
    );
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
      logger.warn(`Suppressed transient unhandledRejection: ${toErrorMessage(reason)}`);
      return;
    }
    logger.error("unhandledRejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    if (isTransientMainProcessError(error)) {
      logger.warn(`Suppressed transient uncaughtException: ${toErrorMessage(error)}`);
      return;
    }
    logger.error("uncaughtException:", error);
  });
}

function isEnvFlagEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function isBackgroundAutostartDisabled(): boolean {
  return /^(0|false|no|off)$/i.test(String(process.env.COWORK_BACKGROUND_AUTOSTART || "").trim());
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
registerWebPreviewScheme();
registerLocationProbeScheme();
registerTaskDeeplinkProtocol();

applyApplicationIdentity();
const isMacSafeStorageMigrationWorker = process.argv.includes(
  MAC_SAFE_STORAGE_MIGRATION_WORKER_FLAG,
);
if (!isMacSafeStorageMigrationWorker) {
  applyStableUserDataPath();
}

const CLI_DIRECT_RUN_FLAG = "--cowork-cli-direct-run";
const DEV_SINGLE_INSTANCE_EXIT_CODE = 73;

function isCliDirectRunMode(): boolean {
  return process.argv.includes(CLI_DIRECT_RUN_FLAG);
}

function getCliDirectRunArgv(): string[] {
  const index = process.argv.indexOf(CLI_DIRECT_RUN_FLAG);
  return index >= 0 ? process.argv.slice(index + 1) : [];
}

async function handleCliApprovalResponse(request: CliApprovalResponse): Promise<void> {
  if (!agentDaemon) {
    logger.warn("CLI approval response received before agent daemon was ready");
    return;
  }
  const result = await respondToCliApprovalResponse(agentDaemon, request);
  logger.info(
    `CLI approval response ${request.approved ? "approved" : "rejected"} ${request.approvalId}: ${result}`,
  );
}

async function runCliDirectMode(): Promise<void> {
  try {
    process.env.COWORK_HEADLESS = "1";
    stripInjectedSystemCaOption(process.env);
    keepDirectRunAliveWithoutWindows(app);
    await app.whenReady();
    // Headless CLI runs should not appear as a second app in the Dock.
    app.dock?.hide();
    if (await primeMacSafeStorageContext()) {
      logger.info("Initialized macOS Keychain context before loading secure settings.");
    }
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

async function runMacSafeStorageMigrationWorkerMode(): Promise<void> {
  try {
    // Destroying the bootstrap window must not trigger Electron's default quit
    // before stdin has been read and the result written.
    keepDirectRunAliveWithoutWindows(app);
    await app.whenReady();
    app.dock?.hide();
    await primeMacSafeStorageContext();
    let pendingResult = "";
    await runMacSafeStorageMigrationWorker({
      platform: process.platform,
      safeStorage,
      readInput: async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf8");
      },
      writeResult: (result) => {
        pendingResult = result;
      },
    });
    // Pipe writes are asynchronous on macOS; wait for the flush before quitting
    // so large results are not truncated.
    await new Promise<void>((resolve) => process.stdout.write(pendingResult, () => resolve()));
    app.quit();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`[SafeStorageMigration] Worker failed: ${message}\n`);
    app.exit(1);
  }
}

if (isMacSafeStorageMigrationWorker) {
  void runMacSafeStorageMigrationWorkerMode();
} else if (isCliDirectRunMode()) {
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
    const startupActionGate = new StartupActionGate();

    function ensureMainWindowVisible(): void {
      if (!revealWindow(mainWindow)) createWindow();
    }

    function flushPendingTaskDeeplink(): void {
      const taskId = pendingTaskDeeplinkId;
      if (!taskId || !mainWindow || mainWindow.isDestroyed()) return;
      pendingTaskDeeplinkId = null;
      mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_TASK, taskId);
    }

    function flushPendingBotDeeplink(): void {
      const route = pendingBotDeeplink;
      if (!route || !mainWindow || mainWindow.isDestroyed()) return;
      pendingBotDeeplink = null;
      mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE_TO_BOT_CONVERSATION, route);
    }

    function openTaskDeeplink(taskId: string): void {
      if (HEADLESS) return;
      pendingTaskDeeplinkId = taskId;
      if (!revealWindow(mainWindow)) {
        startupActionGate.runWhenReady(ensureMainWindowVisible);
        return;
      }
      if (mainWindow?.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once("did-finish-load", flushPendingTaskDeeplink);
        return;
      }
      flushPendingTaskDeeplink();
    }

    function openBotDeeplink(route: { botId: string; conversationId?: string }): void {
      if (HEADLESS) return;
      pendingBotDeeplink = route;
      if (!revealWindow(mainWindow)) {
        startupActionGate.runWhenReady(ensureMainWindowVisible);
        return;
      }
      if (mainWindow?.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once("did-finish-load", flushPendingBotDeeplink);
        return;
      }
      flushPendingBotDeeplink();
    }

    app.on("open-url", (event, url) => {
      event.preventDefault();
      const taskId = parseTaskDeeplink(url);
      if (taskId) {
        openTaskDeeplink(taskId);
        return;
      }
      const botRoute = parseBotDeeplink(url);
      if (botRoute) {
        openBotDeeplink(botRoute);
      }
    });
    pendingTaskDeeplinkId = extractTaskDeeplinkArg(process.argv);
    pendingBotDeeplink = extractBotDeeplinkArg(process.argv);

    app.on("second-instance", (_event, argv) => {
      if (HEADLESS) return;
      const approvalResponse = getCliApprovalResponseArgv(argv);
      if (approvalResponse) {
        startupActionGate.runWhenReady(() => {
          void handleCliApprovalResponse(approvalResponse);
        });
        return;
      }
      const taskId = extractTaskDeeplinkArg(argv);
      if (taskId) {
        openTaskDeeplink(taskId);
        return;
      }
      const botRoute = extractBotDeeplinkArg(argv);
      if (botRoute) {
        openBotDeeplink(botRoute);
        return;
      }
      // Focus the existing window instead of starting a second instance.
      if (revealWindow(mainWindow)) {
        return;
      }
      // During startup, wait for IPC registration before creating a renderer.
      // After startup, recreate a closed window as usual.
      startupActionGate.runWhenReady(ensureMainWindowVisible);
    });

    const startupApprovalResponse = getCliApprovalResponseArgv(process.argv);
    if (startupApprovalResponse) {
      logger.warn(
        "CLI approval response requested, but no existing CoWork OS instance accepted it",
      );
      app.exit(1);
    }

    function createWindow() {
      const isMac = process.platform === "darwin";
      const usesNativeWindowFrame = shouldUseNativeWindowFrame({
        platform: process.platform,
        wslDistroName: process.env.WSL_DISTRO_NAME,
        osRelease: os.release(),
      });
      let useMacVibrancy = isMac && !nativeTheme.prefersReducedTransparency;
      const {
        isMaximized: shouldStartMaximized,
        isFullScreen: shouldStartFullScreen,
        ...initialWindowBounds
      } = getInitialMainWindowBounds();
      const hideMainWindowForAcceptance = process.env.COWORK_TEST_HIDE_MAIN_WINDOW === "1";
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
          mode === "light" || (mode === "system" && nativeTheme.shouldUseDarkColors === false);
        if (isLight) windowBgColor = "#f0f0f2";
      } catch {
        // Fallback to dark if settings aren't available yet
      }

      mainWindow = new BrowserWindow({
        show: !hideMainWindowForAcceptance,
        ...initialWindowBounds,
        minWidth: MAIN_WINDOW_MIN_WIDTH,
        minHeight: MAIN_WINDOW_MIN_HEIGHT,
        center: initialWindowBounds.x === undefined || initialWindowBounds.y === undefined,
        icon: getDesktopIconPath(),
        ...(usesNativeWindowFrame ? {} : { titleBarStyle: isMac ? "hiddenInset" : "hidden" }),
        ...(usesNativeWindowFrame ? { frame: true } : {}),
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

      if (hideMainWindowForAcceptance) app.dock?.hide();

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
          void mainWindow.loadURL(getDevServerUrl());
          if (!hideMainWindowForAcceptance) mainWindow.webContents.openDevTools();
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
          void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        } else {
          void mainWindow.loadFile(rendererIndex);
        }
      };

      // Load the app
      loadMainWindowContent();

      mainWindow.on("closed", () => {
        getBrowserWorkbenchService().setMainWindow(null);
        mainWindow = null;
      });
      getBrowserWorkbenchService().setMainWindow(mainWindow);
      attachBrowserWorkbenchWindowInput(mainWindow);

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
        flushPendingBotDeeplink();
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
        // Scheme-checked: renderer content includes unsanitized .docx hyperlink
        // targets (mammoth does no href validation), so an unfiltered
        // openExternal here would launch smb://, file://, or any registered
        // protocol handler on one click.
        void openExternalIfSafe(url);
        return { action: "deny" };
      });

      mainWindow.webContents.on("will-navigate", (event, url) => {
        // Allow navigation to the app itself (dev server or file://), block external URLs
        if (!isAppOwnedUrl(url)) {
          event.preventDefault();
          void openExternalIfSafe(url);
        }
      });
    }

    void app.whenReady().then(async () => {
      if (await primeMacSafeStorageContext()) {
        logger.info("Initialized macOS Keychain context before loading secure settings.");
      }
      getDesktopLocationService().installPermissionHandlers();
      installMcpInstallConfirmationHandler();
      const startupStartedAt = Date.now();
      startupLaneStartedAt = startupStartedAt;
      logStartupLane("blocking_startup", { event: "start" });
      const logPhase = (name: string, phaseStartedAt: number): void => {
        logger.debug(`Startup phase "${name}" completed in ${Date.now() - phaseStartedAt} ms`);
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
          const timer = setTimeout(
            () => {
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
            },
            250 + index * 50,
          );
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
        const appRoot = pathToFileURL(path.join(__dirname, "../../renderer")).toString();
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
                  "frame-src 'self' cowork-preview:; " + // HTML artifact previews run in their own origin with their own CSP (web-preview-protocol.ts)
                  "frame-ancestors 'none'; " + // Prevent embedding in iframes
                  "form-action 'self';", // Restrict form submissions
              ],
            },
          });
        });
      }

      // Initialize database first - required for SecureSettingsRepository
      const coreInitStartedAt = Date.now();
      try {
        // Schema initialization runs in a bootstrap worker (DB6).
        dbManager = await DatabaseManager.open();
        setBackgroundDispatchBudget(
          new PersistentDispatchBudget(dbManager.getDatabase(), {
            getSchedulerFence: () => automationRuntime.captureFence(),
          }),
        );
        automationRuntime.attachOwnership(new SchedulerOwnership(dbManager.getDatabase()));
        setAutomationRuntime(automationRuntime);
      } catch (error) {
        // DB6: a profile this build must not open (a newer schema, or another process
        // stuck preparing it) fails clearly instead of leaving the app without a window.
        if (
          error instanceof UnsupportedSchemaVersionError ||
          error instanceof MigrationLockTimeoutError
        ) {
          dialog.showErrorBox("CoWork OS cannot open this profile", error.message);
          app.exit(1);
          return;
        }
        throw error;
      }
      dbManager.beginRun("desktop");
      logStartupLane("blocking_startup", { event: "database_manager_ready" });
      // Database worker (async SQLite plan, DB2); starts after schema setup. Awaited so
      // each domain's backend is chosen once for the run (DB7): a worker that fails to
      // start leaves the whole run on the host backend.
      logStartupLane("blocking_startup", { event: "database_worker_start" });
      await startDatabaseWorker({ dbPath: dbManager.getDatabasePath(), runtime: "desktop" });
      logStartupLane("blocking_startup", { event: "database_worker_ready" });
      // Reporting reader (DB4); report-style reads only, so it may become ready later.
      const reportingReader = startReportingReader({
        dbPath: dbManager.getDatabasePath(),
        runtime: "desktop",
      });
      logStartupLane("blocking_startup", { event: "reporting_reader_start_requested" });
      hostPerfMonitor = startHostPerfMonitor({ runtime: "desktop" });
      automationOutcomeService = new AutomationOutcomeService({
        repo: new AutomationRunOutcomeRepository(dbManager.getDatabase()),
        notify: async (params) => {
          const notificationService = getNotificationService();
          await notificationService?.add(params);
        },
      });
      const usageInsightsProjector = UsageInsightsProjector.initialize(dbManager.getDatabase());
      usageInsightsProjector.attachDatabaseWorkers(
        Promise.all([getDatabaseClient(), reportingReader]).then(([writer, reader]) =>
          writer && reader ? { writer, reader } : null,
        ),
      );
      usageInsightsProjector.warm();
      logStartupLane("blocking_startup", { event: "usage_insights_warm_requested" });
      // DB4: maintenance chunks run in the database worker when this run uses it.
      const runDatabaseMaintenance = async () =>
        dbManager.runPostStartupMaintenance({ client: await getDatabaseClient() });
      if (startupQuietMode) {
        logStartupLane("blocking_startup", { event: "database_maintenance_start" });
        await runDatabaseMaintenance();
        logStartupLane("blocking_startup", { event: "database_maintenance_complete" });
      } else {
        deferStartupTask("database-maintenance", runDatabaseMaintenance);
      }
      const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
      const runTempWorkspacePrune = async () => {
        try {
          await pruneTempWorkspaces({
            db: dbManager.getDatabase(),
            tempWorkspaceRoot,
            protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
          });
        } catch (error) {
          logger.warn("Failed to prune temp workspaces:", error);
        }
      };
      logStartupLane("blocking_startup", { event: "temp_workspace_prune_start" });
      await runTempWorkspacePrune();
      logStartupLane("blocking_startup", { event: "temp_workspace_prune_complete" });
      tempWorkspacePruneTimer = setInterval(
        // The prune reports its own failures.
        () => void runTempWorkspacePrune(),
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
      logStartupLane("blocking_startup", { event: "secure_settings_ready" });
      if (process.platform === "darwin") {
        await migrateLegacyMacSafeStorageSettings({
          platform: process.platform,
          database: dbManager.getDatabase(),
          repository: SecureSettingsRepository.getInstance(),
          executable: process.execPath,
          appPath: app.getAppPath(),
          logger,
        });
        await migrateLegacyMacSafeStorageChannels({
          platform: process.platform,
          database: dbManager.getDatabase(),
          safeStorage: getSafeStorage(),
          executable: process.execPath,
          appPath: app.getAppPath(),
          logger,
        });
      }
      keychainIdentityMismatch = verifySecureSettingsKeychainIdentity();
      // One lifecycle-owned instance serves the timer and the Settings IPC, so a
      // user decision and an in-flight delivery share one fence and one shutdown.
      // Opt-in telemetry must never block startup; Settings then reports it unavailable.
      try {
        pulseService = new PulseService(dbManager.getDatabase(), {
          version: app.getVersion(),
          runtime: "desktop",
        });
        pulseService.start();
      } catch (error) {
        pulseService = null;
        logger.warn("CoWork Pulse could not start; reporting stays paused this session.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      healResettableSecureSettings();
      {
        const workspaceRepo = new WorkspaceStore(dbManager.getDatabase());
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
      await normalizeTemplatedRoleCoreBoundary();
      await ensureCoreAutomationProfiles();
      // Shared with the memory repo startup below (workspace paths and names; recent tasks
      // for dreaming).
      let hostWorkspaceRepository: WorkspaceRepository | null = null;
      let hostTaskRepository: TaskRepository | null = null;
      let hostTaskEventReplayRepository: TaskEventReplayRepository | null = null;
      try {
        const db = dbManager.getDatabase();
        hostWorkspaceRepository = new WorkspaceRepository(db);
        hostTaskRepository = new TaskRepository(db);
        hostTaskEventReplayRepository = new TaskEventReplayRepository(db);
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
          hostWorkspaceRepository,
          coreMemoryScopeResolver,
        );
        coreFailureMiningService = new CoreFailureMiningService(
          coreTraceRepo,
          coreFailureRecordRepo,
        );
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
      new ModelMetadataRefresher(
        () => LLMProviderFactory.loadSettings().modelMetadataAutoRefresh === true,
      ).start();
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
          logger.warn("Failed to import credentials from process.env:", importResult.error);
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
            llmSettings?.bedrock?.profile ||
            Object.values(llmSettings?.customProviders || {}).some(
              (provider) =>
                typeof provider?.apiKey === "string" && provider.apiKey.trim().length > 0,
            )
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
        const configuredMemoryReviewMode = String(
          process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE || "",
        )
          .trim()
          .toLowerCase();
        if (
          approvalPromptsDisabled() &&
          (!configuredMemoryReviewMode || configuredMemoryReviewMode === "off")
        ) {
          const rejected = await MemoryWriteGate.rejectAllPending({
            reviewedBy: "system:no-prompt-migration",
            resolution:
              "Rejected by the no-prompt memory-write migration; stale queued data was not replayed.",
          });
          if (rejected > 0) {
            logger.info(`Cleared ${rejected} stale pending memory write(s) during startup.`);
          }
        }
        // Quiet mode starts no background jobs: no periodic cleanup or deferred archive cleanup.
        MemoryService.initialize(dbManager, { backgroundJobs: !startupQuietMode });
        CuratedMemoryService.initialize(dbManager);
        // Memory engine (docs/memory-engine.md): memory_items is the only store of facts
        // about the user. The retired legacy lanes are copied in once, awaited here, before
        // queue recovery and IPC can read memory.
        const memoryStatements = MemoryService.getStatements();
        if (memoryStatements) {
          // Stopped (and its queued writes flushed) by the "memory engine" shutdown step.
          stopMemoryEngine = await startMemoryEngine(memoryStatements, {
            getWorkspacePolicy: (workspaceId) => MemoryService.getSettings(workspaceId),
          });
        }
        // Memory repo (docs/memory-repo-phase1-design.md): off unless enabled in settings;
        // stopped by the "memory repo" shutdown step.
        const memoryRepoWorkspaces = hostWorkspaceRepository;
        void startMemoryRepo({
          runtime: "desktop",
          readOnly: startupQuietMode,
          getWorkspacePolicy: (workspaceId) => MemoryService.getSettings(workspaceId),
          listWorkspacePaths: async () =>
            memoryRepoWorkspaces ? (await memoryRepoWorkspaces.findAll()).map((w) => w.path) : [],
          workspaceName: async (id) =>
            memoryRepoWorkspaces ? ((await memoryRepoWorkspaces.findById(id))?.name ?? null) : null,
          findTasksCreatedBetween: async (params) =>
            hostTaskRepository ? hostTaskRepository.findByCreatedAtRange(params) : [],
          findTaskEvents: async (taskId, types, maxEvents) =>
            hostTaskEventReplayRepository
              ? hostTaskEventReplayRepository.findByTaskIdAndTypes(taskId, types, maxEvents)
              : [],
          // A dream that left changes for review tells the user; the click opens Memory > Review.
          notifyDreamReview: (record) => {
            void getNotificationService()
              ?.add({
                id: `memory-dream-review:${record.id}`,
                type: "info",
                title:
                  record.reviewCount === 1
                    ? "Memory: 1 change to review"
                    : `Memory: ${record.reviewCount} changes to review`,
                message:
                  record.summary.trim() ||
                  "Dreaming suggested changes to your memory folder. Accept or reject them in Settings > Memory > Review.",
                openTarget: "memory_review",
              })
              .catch((error) =>
                logger.warn("Could not post the dream review notification:", error),
              );
          },
        });

        // Initialize FTS worker thread for off-main-thread memory search
        const { FtsWorkerClient } = await import("./database/FtsWorkerClient");
        const ftsWorkerClient = new FtsWorkerClient(dbManager.getDatabasePath());
        MemoryService.initFtsWorker(ftsWorkerClient);
        app.on("will-quit", () => ftsWorkerClient.destroy());

        logger.info("Memory Service initialized");
      } catch (error) {
        logger.error("Failed to initialize Memory Service:", error);
        // Don't fail app startup if memory init fails
      }

      try {
        BoxBrainService.initialize(dbManager.getDatabase());
        logger.info("Box Brain Service initialized");
      } catch (error) {
        logger.error("Failed to initialize Box Brain Service:", error);
        // Box Brain is optional and must not block app startup.
      }

      // Daily retention for background-loop history (LIFE-3). The first run is deferred
      // well past startup; quiet mode starts no background jobs.
      if (startupQuietMode) {
        logger.info("Memory retention not started (quiet mode)");
      } else {
        memoryRetentionService = new MemoryRetentionService();
        memoryRetentionService.start();
      }

      try {
        const meetingArtifacts = MeetingArtifactsService.initialize(
          path.join(getUserDataDir(), "meeting-artifacts"),
        );
        setupMeetingArtifactHandlers(meetingArtifacts);
        logger.info("Meeting artifacts service initialized");
      } catch (error) {
        // Meeting capture is optional and must not block app startup.
        logger.error("Failed to initialize meeting artifacts service:", error);
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
      const numbatService = NumbatService.initialize(dbManager.getDatabase());
      recurringApprovalService = new RecurringApprovalService(dbManager.getDatabase());
      agentDaemon = new AgentDaemon(dbManager, { recurringApprovalService });
      automationRuntime.registerRecovery(
        new BotWorkControlRecovery(
          dbManager.getDatabase(),
          agentDaemon,
          automationRuntime,
          new BotNotificationRuntime(
            dbManager.getDatabase(),
            automationRuntime,
            () => getNotificationService(),
            !HEADLESS,
          ),
        ),
      );
      numbatService.attachTaskEventEmitter((taskId, type, payload) => {
        agentDaemon?.logEvent(taskId, type, payload);
      });
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
          process.env.COWORK_BOOTSTRAP_WORKSPACE_PATH || getArgValue("--bootstrap-workspace");
        if (
          bootstrapPathRaw &&
          typeof bootstrapPathRaw === "string" &&
          bootstrapPathRaw.trim().length > 0
        ) {
          const raw = bootstrapPathRaw.trim();
          const homeDir = process.env.HOME || process.env.USERPROFILE;
          const expanded = raw.startsWith("~/") && homeDir ? path.join(homeDir, raw.slice(2)) : raw;
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
            logger.info(`Bootstrapped workspace: ${ws.id} (${ws.name}) at ${ws.path}`);
          } else {
            logger.info(
              `Bootstrap workspace exists: ${existing.id} (${existing.name}) at ${existing.path}`,
            );
          }
        }
      } catch (error) {
        logger.warn("Failed to bootstrap workspace:", error);
      }

      // Workspace kit writers (cross-agent signals, feedback, lore; best-effort). Only the
      // process that owns the profile's kit-writer lease runs them; the desktop app takes
      // the lease over from a node daemon on the same profile. Quiet mode starts no
      // background writers: the next normal start rebuilds the files from the database.
      if (startupQuietMode) {
        logger.info("Kit writers not started (quiet mode)");
      } else {
        try {
          kitWriterOwnership = createKitWriterOwnership({
            db: dbManager.getDatabase(),
            agentDaemon,
            runtime: "desktop",
          });
          const owned = await kitWriterOwnership.start();
          logger.info(
            owned
              ? "Kit writers started"
              : "Kit writers waiting for the kit-writer lease (another process owns it)",
          );
        } catch (error) {
          logger.error("Failed to start the kit writers:", error);
        }
      }

      try {
        subconsciousLoopService = new SubconsciousLoopService(dbManager.getDatabase(), {
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
                console.error("[Main] Failed to add subconscious notification:", error);
              }
            } else {
              try {
                trayManager.showNotification(title, message, taskId);
              } catch (error) {
                console.error("[Main] Failed to show subconscious desktop notification:", error);
              }
            }
          },
          isUserFocused: () =>
            BrowserWindow.getAllWindows().some(
              (window) => !window.isDestroyed() && window.isFocused(),
            ),
          getTriggerService: () => eventTriggerService,
          getGlobalRoot: () => getUserDataDir(),
          automationProfileRepo: new AutomationProfileRepository(dbManager.getDatabase()),
          coreTraceService: coreTraceService || undefined,
          coreMemoryCandidateService: coreMemoryCandidateService || undefined,
          coreMemoryDistiller: coreMemoryDistiller || undefined,
          coreLearningPipelineService: coreLearningPipelineService || undefined,
        });
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
        try {
          await mcpClientManager.initialize();
          const mcpStartupSummary = mcpClientManager.getStartupStats();
          logger.info(
            `MCP summary: enabled=${mcpStartupSummary.enabled}, attempted=${mcpStartupSummary.attempted}, connected=${mcpStartupSummary.connected}, failed=${mcpStartupSummary.failed}`,
          );
          logger.info("MCP Client Manager initialized");
          logPhase("mcp-init", mcpInitStartedAt);
        } finally {
          try {
            BoxBrainService.getInstance().start();
            logger.info("Box Brain background sync started");
          } catch (error) {
            logger.warn("Failed to start Box Brain background sync:", error);
          }
        }
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

      // Initialize Cron Service for scheduled task execution
      try {
        const db = dbManager.getDatabase();
        const taskRepo = new TaskStore(db);
        const taskEventRepo = new TaskEventRepository(db);
        const channelRepo = new ChannelRepository(db);
        const channelUserRepo = new ChannelUserRepository(db);
        const channelMessageRepo = new ChannelMessageRepository(db);
        const workspaceRepo = new WorkspaceStore(db);
        const userDataDir = getUserDataDir();

        const ensureManagedWorkspaceForCronJob = async (
          job: { id: string; name: string },
          nowMs: number,
        ) => {
          const managedPath = buildManagedScheduledWorkspacePath(userDataDir, job.name, job.id);
          await fs.mkdir(managedPath, { recursive: true });

          let workspace = workspaceRepo.findByPath(managedPath);
          if (!workspace) {
            workspace = agentDaemon.createWorkspace(`Scheduled: ${job.name}`.trim(), managedPath);
          } else {
            workspaceRepo.updateLastUsedAt(workspace.id, nowMs);
          }

          return workspace;
        };

        // Cron events arrive through a void callback; this handler's rejections reach the
        // process-level unhandledRejection logger, as they did when it was inline.
        const forwardCronEvent = async (evt: CronEvent): Promise<void> => {
          // Forward cron events to renderer
          if (mainWindow?.webContents) {
            mainWindow.webContents.send("cron:event", evt);
          }
          console.log("[Cron] Event:", evt.action, evt.jobId);
          try {
            await MailboxAutomationRegistry.recordCronEvent(evt);
          } catch (error) {
            logger.debug("[MailboxAutomationRegistry] Failed to record cron event:", error);
          }
          try {
            await routineService?.recordScheduledEvent(evt);
          } catch (error) {
            logger.debug("[Routines] Failed to record cron routine run:", error);
          }

          // Show desktop notification when scheduled task finishes
          if (evt.action === "finished") {
            const statusLabel = describeCronRunStatus(evt.status);
            const statusEmoji = statusLabel.emoji;
            const statusText = statusLabel.short;

            // Add in-app notification
            const notificationService = getNotificationService();
            if (notificationService) {
              try {
                // Get job name for the notification
                const job = cronService ? await cronService.get(evt.jobId) : null;
                const jobName = job?.name || "Scheduled Task";
                const task = evt.taskId ? taskRepo.findById(evt.taskId) : null;
                if (
                  task?.assignedAgentRoleId &&
                  (
                    await new BotNotificationService(dbManager.getDatabase()).get({
                      workspaceId: task.workspaceId,
                      agentRoleId: task.assignedAgentRoleId,
                    })
                  ).enabled
                )
                  return;
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
                          evt.status === "needs_user_action" ||
                          evt.status === "cancelled" ||
                          evt.status === "skipped" ||
                          evt.status === "unknown"
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
        };

        cronService = new CronService({
          beforeExecuteJob: async (job) => {
            await automationRuntime.assertOwnership();
            await new BotResponsibilityRepository(db).assertCronJobMayExecute(job.id);
            return prepareResponsibilitySchedule(db, job, {
              settings: PermissionSettingsManager.loadSettings(),
              adminPolicies: loadPolicies(),
            });
          },
          beforeDeliverJob: async (jobId) => {
            await automationRuntime.assertOwnership();
            await new BotResponsibilityRepository(db).assertCronJobMayDeliver(jobId);
          },
          cronEnabled: true,
          runnerKind: "desktop",
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

            const managedWorkspace = isManagedScheduledWorkspacePath(workspace.path, userDataDir);
            if (phase === "run" && managedWorkspace) {
              let runDirectory: ReturnType<typeof createScheduledRunDirectory> | null = null;
              try {
                // Managed scheduled workspaces are app-owned, so restore a removed root.
                await fs.mkdir(workspace.path, { recursive: true });
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
          executeWorkflow: async ({ routineId, jobId, runAtMs, agentConfig }) => {
            await automationRuntime.assertOwnership();
            if (!routineService) {
              throw new Error("Routine service has not finished starting.");
            }
            return routineService.runScheduledWorkflow(routineId, jobId, runAtMs, agentConfig);
          },
          createTask: async (params) => {
            await automationRuntime.assertOwnership();
            const schedulerFence = automationRuntime.captureFence();
            const isManagedBriefing =
              params.title.startsWith("Daily Briefing:") ||
              params.prompt.includes(DAILY_BRIEFING_MARKER);
            if (isManagedBriefing && dailyBriefingService) {
              const briefing = await dailyBriefingService.generateBriefing(params.workspaceId);
              const text = dailyBriefingService.renderBriefingAsText(briefing);
              const syntheticTaskId = `briefing:${randomUUID()}`;
              managedBriefingRuns.set(syntheticTaskId, {
                text,
                delivered: briefing.delivered,
                generatedAt: briefing.generatedAt,
              });
              return { id: syntheticTaskId };
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
              ...(params.assignedAgentRoleId
                ? { taskOverrides: { assignedAgentRoleId: params.assignedAgentRoleId } }
                : {}),
              agentConfig: { ...mergedAgentConfig, backgroundSchedulerFence: schedulerFence },
              source: "cron",
            });
            return { id: task.id };
          },
          sendTaskMessage: async (params) => {
            await automationRuntime.assertOwnership();
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
            const template = typeof job?.taskPrompt === "string" ? job.taskPrompt : "";
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

            const channel = await channelRepo.findByType(channelType);
            if (!channel) return {};

            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            const sinceMs = Math.max(
              0,
              Number.isFinite(prevRunAtMs) ? prevRunAtMs! : runAtMs - sevenDaysMs,
            );

            // Fetch a bounded window; formatting further caps message count/size.
            const raw = await channelMessageRepo.findByChatId(channel.id, chatId, 500);
            const lookupUser = await prefetchTranscriptUsers(raw, (id) =>
              channelUserRepo.findById(id),
            );

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
              chat_messages: rendered.usedCount > 0 ? rendered.transcript : "[no messages found]",
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
          findTaskForRun: async ({ workspaceId, jobId, runAtMs }) =>
            taskRepo.findByScheduledRun(workspaceId, jobId, runAtMs),
          findActiveTaskForJob: async (params) => {
            if (params.runMode !== "new_task") return null;
            const title = typeof params.taskTitle === "string" ? params.taskTitle.trim() : "";
            if (!title) return null;
            // The scheduler's own definition: a match it would reject must not hide an
            // executing task listed after it.
            const activeStatuses = CRON_ACTIVE_TASK_STATUSES;
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
            await automationRuntime.assertOwnership();
            if (!channelGateway) {
              throw new Error("Cannot deliver to channel - gateway not initialized");
            }

            const resultAvailable =
              typeof params.resultText === "string" && params.resultText.trim().length > 0;
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
            const statusLabel = describeCronRunStatus(params.status);
            const statusEmoji = statusLabel.emoji;
            let message: string;

            if (hasFullResult) {
              // Full result mode — send the complete task output
              message = `**${params.jobName}**\n\n${params.resultText!.trim()}`;
            } else if (params.summaryOnly && resultAvailable) {
              // Summary-only mode but result exists — include a truncated preview
              const preview = params.resultText!.trim();
              const truncated = preview.length > 500 ? `${preview.slice(0, 500)}…` : preview;
              message = `${statusEmoji} **${params.jobName}**\n\n${truncated}`;
            } else {
              // No result text or error/timeout — generic status message
              let msg = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

              msg += `${statusLabel.sentence}\n`;

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
                const ch = await channelGateway.getChannel(params.channelDbId);
                if (ch) {
                  resolvedType = ch.type;
                }
              }

              // Send the message via the gateway
              await channelGateway.sendMessage(resolvedType as Any, params.channelId, message, {
                parseMode: "markdown",
                idempotencyKey: params.idempotencyKey,
              });
              console.log(`[Cron] Delivered to ${resolvedType}:${params.channelId}`);
            } catch (err) {
              console.error(
                `[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`,
                err,
              );
              throw err;
            }
          },
          onEvent: (evt) => {
            void forwardCronEvent(evt);
          },
          log: {
            debug: (msg, data) => logCron("debug", msg, data),
            info: (msg, data) => logCron("info", msg, data),
            warn: (msg, data) => logCron("warn", msg, data),
            error: (msg, data) => logCron("error", msg, data),
          },
        });
        setCronService(cronService);
        automationRuntime.register(
          "cron",
          cronService,
          startupQuietMode ? "Quiet startup" : undefined,
        );
        if (startupQuietMode) {
          logger.info("Cron Service initialized (quiet mode; not started)");
        } else {
          await automationRuntime.start("cron");
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
          enabled: plugins.filter((plugin: Any) => plugin.state === "enabled").length,
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
        getPulseService: () => pulseService,
        getDailyBriefingService: () => dailyBriefingService,
      });
      if (subconsciousLoopService) {
        setupSubconsciousHandlers(subconsciousLoopService);
        setupImprovementHandlers(subconsciousLoopService);
      }
      void notifyKeychainIdentityMismatch();
      // Initialize heartbeat and Mission Control services
      try {
        const db = dbManager.getDatabase();
        const agentRoleRepo = new AgentRoleRepository(db);

        const mentionRepo = new MentionRepository(db);
        const activityRepo = new ActivityRepository(db);
        const workingStateRepo = new WorkingStateRepository(db);

        // Create repositories for heartbeat service
        const taskRepo = new TaskStore(db);
        const workspaceRepo = new WorkspaceStore(db);

        const resolveDefaultWorkspace = ():
          | ReturnType<typeof workspaceRepo.findById>
          | undefined => {
          const workspaces = workspaceRepo.findAll();
          return (
            workspaces.find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ??
            workspaces[0]
          );
        };

        const hasActiveForegroundTask = (workspaceId?: string): boolean => {
          const activeTasks = taskRepo.findByStatus(Array.from(ACTIVE_FOREGROUND_TASK_STATUSES));
          return activeTasks.some((task) => {
            if (workspaceId && task.workspaceId !== workspaceId) return false;
            return isForegroundUserTask(task);
          });
        };

        // Commitment expiry on the Heartbeat pulse; one instance keeps the daily cooldown.
        const commitmentExpiry = createCommitmentExpiryService(db, {
          listWorkspaceIds: () =>
            workspaceRepo
              .findAll()
              .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id))
              .map((workspace) => workspace.id),
        });

        // Initialize HeartbeatService with dependencies
        const heartbeatDeps: HeartbeatServiceDeps = {
          db,
          agentRoleRepo,
          mentionRepo,
          activityRepo,
          workingStateRepo,
          createTask: async (workspaceId, prompt, title, _agentRoleId, options) => {
            const task = await agentDaemon.createTask({
              title,
              prompt,
              workspaceId,
              agentConfig: {
                allowUserInput: false,
                ...options?.agentConfig,
              },
              ...(options?.source ? { source: options.source } : {}),
              ...(options?.taskOverrides ? { taskOverrides: options.taskOverrides } : {}),
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
            // Every non-terminal TaskStatus counts as assigned work, except "paused": a paused
            // task waits on the user, so the agent cannot advance it and every pulse would
            // re-dispatch for it until the user returns (or forever, if they never do).
            const activeStatuses: TaskStatus[] = [
              "pending",
              "queued",
              "planning",
              "executing",
              "blocked",
            ];
            const tasks = workspaceId
              ? taskRepo
                  .findByWorkspace(workspaceId)
                  .filter((task) => activeStatuses.includes(task.status))
              : taskRepo.findByStatus(activeStatuses);
            // Tasks Heartbeat dispatched itself are tracked by the in-flight
            // dispatch guard; counting them as pending work would make the
            // agent review its own output on every pulse.
            return tasks.filter(
              (t: { assignedAgentRoleId?: string; heartbeatRunId?: string }) =>
                t.assignedAgentRoleId === agentRoleId && !t.heartbeatRunId,
            );
          },
          getTaskStatus: (taskId) => taskRepo.findById(taskId)?.status,
          getDefaultWorkspaceId: () => {
            const fallbackTemp = workspaceRepo
              .findAll()
              .find((workspace) => workspace.isTemp || isTempWorkspaceId(workspace.id));
            return resolveDefaultWorkspace()?.id ?? fallbackTemp?.id ?? TEMP_WORKSPACE_ID;
          },
          getDefaultWorkspacePath: () => {
            const fallbackTempPath = workspaceRepo
              .findAll()
              .find((workspace) => workspace.isTemp || isTempWorkspaceId(workspace.id))?.path;
            return resolveDefaultWorkspace()?.path || fallbackTempPath;
          },
          getWorkspacePath: (workspaceId: string) => {
            const workspace = workspaceRepo.findById(workspaceId);
            return workspace?.path;
          },
          getWorkspaceMemoryReadGuard: (workspaceId: string) => {
            const workspace = workspaceRepo.findById(workspaceId);
            if (!workspace) return () => false;

            try {
              const profile = resolveEffectiveAccessProfile({
                workspace,
                settings: PermissionSettingsManager.loadSettings(),
                adminPolicies: loadPolicies(),
              });
              const effectiveWorkspace = applyAccessProfileToWorkspace(workspace, profile);
              return (candidatePath: string) => {
                try {
                  return (
                    evaluateWorkspaceFilesystemAccess(effectiveWorkspace, candidatePath, "read")
                      .decision === "allow"
                  );
                } catch {
                  return false;
                }
              };
            } catch {
              // Background memory maintenance must fail closed if settings or
              // profile resolution is unavailable during startup/migration.
              return () => false;
            }
          },
          hasActiveForegroundTask,
          recordActivity: ({ workspaceId, agentRoleId, title, description, metadata }) => {
            void activityRepo
              .create({
                workspaceId,
                agentRoleId,
                actorType: "system",
                activityType: "info",
                title,
                description,
                metadata,
              })
              .catch((error: unknown) => logger.warn("Failed to record activity:", error));
          },
          listWorkspaceContexts: () =>
            workspaceRepo
              .findAll()
              .filter(
                (workspace) =>
                  workspace.path && !workspace.isTemp && !isTempWorkspaceId(workspace.id),
              )
              .map((workspace) => ({
                workspaceId: workspace.id,
                workspacePath: workspace.path,
              })),
          getMemoryFeaturesSettings: () => MemoryFeaturesManager.loadSettings(),
          getAwarenessSummary: (workspaceId?: string) =>
            awarenessService?.getSummary(workspaceId) || null,
          listActiveSuggestions: (workspaceId: string) =>
            ProactiveSuggestionsService.listActive(workspaceId, {
              includeDeferred: true,
              recordSurface: false,
            }),
          createCompanionSuggestion: (workspaceId, suggestion) =>
            ProactiveSuggestionsService.createCompanionSuggestion(workspaceId, suggestion),
          runWorkflowReflection: async ({ workspaceId }) => {
            const run = await subconsciousLoopService?.runFromHeartbeat(workspaceId);
            return run ? { id: run.id, outcome: run.outcome } : null;
          },
          runCommitmentExpiry: async () => {
            const result = await commitmentExpiry.sweep();
            return typeof result === "string" ? null : { expired: result.expired };
          },
          runMemoryRepoDream: () => getMemoryRepoDreamer()?.run("daily") ?? Promise.resolve(null),
          addNotification: async (params) => {
            const notificationService = getNotificationService();
            await notificationService?.add(params);
          },
          recordAutomationOutcome: async (outcome) => automationOutcomeService?.record(outcome),
          automationProfileRepo: new AutomationProfileRepository(dbManager.getDatabase()),
          coreTraceService: coreTraceService || undefined,
          coreMemoryCandidateService: coreMemoryCandidateService || undefined,
          coreMemoryDistiller: coreMemoryDistiller || undefined,
          coreLearningPipelineService: coreLearningPipelineService || undefined,
        };

        heartbeatService = new HeartbeatService(heartbeatDeps);
        setHeartbeatService(heartbeatService);
        automationRuntime.register(
          "heartbeat",
          heartbeatService,
          startupQuietMode ? "Quiet startup" : undefined,
        );
        setHeartbeatSignalEmitter(
          async (input) => (await heartbeatService?.submitSignalForAll(input)) ?? [],
        );
        if (startupQuietMode) {
          logger.info("HeartbeatService initialized (quiet mode; not started)");
        } else {
          await automationRuntime.start("heartbeat");
        }

        setHeartbeatWakeSubmitter(async ({ text, mode }) => {
          await submitHeartbeatSignalForAll({ text, mode, source: "hook" });
        });

        // Initialize AwarenessService after Heartbeat so its debounced wakes reach the pulse.
        // Awareness is a signal producer only.
        try {
          awarenessService = AwarenessService.initialize({
            getDefaultWorkspaceId: () => {
              try {
                const workspaceRepo = new WorkspaceStore(dbManager.getDatabase());
                const workspaces = workspaceRepo.findAll();
                return (
                  workspaces.find(
                    (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
                  )?.id || workspaces[0]?.id
                );
              } catch {
                return undefined;
              }
            },
            onWakeHeartbeats: ({ text, mode, category, workspaceId }) => {
              void submitHeartbeatSignalForAll({
                text,
                mode,
                source: "hook",
                category,
                workspaceId,
              }).catch((error) => {
                logger.warn("Failed to wake heartbeats:", error);
              });
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
          logger.error("Mission Control handlers skipped: core automation services unavailable");
        } else {
          const db = dbManager.getDatabase();
          const agentRoleRepo = new AgentRoleRepository(db);
          const taskSubscriptionRepo = new TaskSubscriptionRepository(db);

          setupMissionControlHandlers({
            db,
            agentRoleRepo,
            taskSubscriptionRepo,
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
            automationOutcomeService,
          });

          logger.info("Mission Control services initialized");
        }
      } catch (error) {
        logger.error("Failed to initialize Mission Control:", error);
        // Don't fail app startup if Mission Control init fails
      }

      try {
        const db = dbManager.getDatabase();
        // One-time duplicate cleanup (memory audit DATA-3/LOOP-10); marker-guarded, so later
        // boots return immediately. It must finish before the first distill pass so that
        // legacy accepted candidates are marked applied rather than written again.
        let coreMemoryCleanupDone: Promise<void> | null = null;
        const runCoreMemoryCleanup = (): Promise<void> => {
          coreMemoryCleanupDone ??= (async () => {
            try {
              const result = await new CoreMemoryCleanupRepository(db).run(Date.now());
              if (result.ran || result.retiredProposalsDismissed > 0) {
                logger.info("Core memory duplicate cleanup completed", result);
              }
            } catch (error) {
              logger.warn("Core memory duplicate cleanup failed:", error);
            }
          })();
          return coreMemoryCleanupDone;
        };
        if (coreMemoryDistiller && !startupQuietMode) {
          const automationProfileRepo = new AutomationProfileRepository(db);
          let coreDistillRunning = false;
          const runCoreDistill = async () => {
            if (coreDistillRunning) return;
            coreDistillRunning = true;
            try {
              await runCoreMemoryCleanup();
              for (const profile of await automationProfileRepo.listEnabled()) {
                try {
                  await coreMemoryDistiller?.runOffline({ profileId: profile.id });
                } catch (error) {
                  logger.warn("Core memory distillation failed for profile:", {
                    profileId: profile.id,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            } finally {
              coreDistillRunning = false;
            }
          };
          deferStartupTask("core-memory-distill", runCoreDistill);
          coreMemoryDistillTimer = setInterval(
            () => {
              void runCoreDistill();
            },
            6 * 60 * 60 * 1000,
          );
          coreMemoryDistillTimer.unref();
        } else {
          if (coreMemoryDistiller) {
            logger.info("Core memory distillation not scheduled (quiet mode)");
          }
          deferStartupTask("core-memory-cleanup", runCoreMemoryCleanup);
        }
      } catch (error) {
        logger.error("Failed to schedule core memory distillation:", error);
      }

      try {
        strategicPlannerService = new StrategicPlannerService({
          db: dbManager.getDatabase(),
          agentDaemon,
          log: (...args) => logger.info(...args),
          recordAutomationOutcome: async (outcome) => automationOutcomeService?.record(outcome),
        });
        setStrategicPlannerService(strategicPlannerService);
        automationRuntime.register("strategic_planner", strategicPlannerService);
        await automationRuntime.start("strategic_planner");
        logger.info("Strategic Planner initialized");
      } catch (error) {
        logger.error("Failed to initialize Strategic Planner:", error);
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
        setupAgentSecurityHandlers();
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
        const cpHost = process.env.COWORK_CONTROL_PLANE_HOST || getArgValue("--control-plane-host");
        const cpPortRaw =
          process.env.COWORK_CONTROL_PLANE_PORT || getArgValue("--control-plane-port");
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
              ...(typeof cpHost === "string" && cpHost.trim() ? { host: cpHost.trim() } : {}),
              ...(typeof cpPort === "number" && Number.isFinite(cpPort) ? { port: cpPort } : {}),
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
          const channelStats = await channelGateway.getStartupStats();
          logger.info(
            `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}`,
          );
          logPhase("channel-gateway-headless", channelInitStartedAt);
        } catch (error) {
          logger.error("Failed to initialize Channel Gateway (headless):", error);
          // Don't fail app startup if gateway init fails
        }

        try {
          headlessBotAutomation = createHeadlessBotAutomation({
            db: dbManager.getDatabase(),
            runtime: automationRuntime,
            agentDaemon,
            channelGateway,
            getCronService: () => cronService,
            heartbeat: heartbeatService,
            mcpClientManager: MCPClientManager.getInstance(),
            log: (...args) => logger.warn("[BotAutomation]", ...args),
          });
          eventTriggerService = headlessBotAutomation.triggers;
          routineService = headlessBotAutomation.routines;
          if (!startupQuietMode) await headlessBotAutomation.start();
        } catch (error) {
          logger.error("Headless bot automation failed to initialize:", error);
        }

        // Start Control Plane if enabled (or force-enabled via flag/env)
        const cp = await startControlPlaneFromSettings({
          deps: {
            agentDaemon,
            dbManager,
            channelGateway,
            getRoutineService: () => routineService,
          },
          forceEnable: FORCE_ENABLE_CONTROL_PLANE,
          onEvent: (event) => {
            try {
              const action = typeof event?.action === "string" ? event.action : "event";
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

        await attachBrowserWebApplication();

        logger.info(`Startup complete in ${Date.now() - startupStartedAt} ms`);
        return;
      }

      // Register canvas:// protocol handler (must be after app.ready)
      registerCanvasProtocol();
      registerMediaProtocol();
      registerWebPreviewProtocol();

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
        startupActionGate.open();
        CanvasManager.getInstance().setMainWindow(mainWindow);

        // Initialize Git Worktree handlers
        setupWorktreeHandlers(agentDaemon);

        const channelInitStartedAt = Date.now();
        await channelGateway.initialize(mainWindow);
        const channelStats = await channelGateway.getStartupStats();
        logger.info(
          `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}, autoConnect=deferred`,
        );
        logPhase("channel-gateway-ui", channelInitStartedAt);
        if (startupQuietMode) {
          logger.info("Channels auto-connect skipped in quiet mode");
        } else {
          deferStartupTask("channel-auto-connect", async () => {
            await channelGateway.connectEnabledChannels({ timeoutMs: 10000 });
            const connectedStats = await channelGateway.getStartupStats();
            logger.info(
              `Channels auto-connect complete: loaded=${connectedStats.loaded}, enabled=${connectedStats.enabled}, connected=${connectedStats.connected}`,
            );
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
          deps: {
            agentDaemon,
            dbManager,
            channelGateway,
            getRoutineService: () => routineService,
          },
          forceEnable: FORCE_ENABLE_CONTROL_PLANE || shouldAutoEnableDesktopControlPlane(),
        });

        // ── Gap features: triggers, briefing, file hub, web access ───────
        const db = dbManager.getDatabase();
        const workspaceRepo = new WorkspaceStore(db);
        const activityRepo = new ActivityRepository(db);
        const resolveDefaultWorkspace = ():
          | ReturnType<typeof workspaceRepo.findById>
          | undefined => {
          const workspaces = workspaceRepo.findAll();
          return (
            workspaces.find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ??
            workspaces[0]
          );
        };
        // Event Triggers
        eventTriggerService = new EventTriggerService(
          {
            getResponsibilityAccess: () => ({
              settings: PermissionSettingsManager.loadSettings(),
              adminPolicies: loadPolicies(),
            }),
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
                agentConfig: {
                  ...params.agentConfig,
                  backgroundSchedulerFence: automationRuntime.captureFence(),
                },
                source: "hook",
              });
              return { id: task.id };
            },
            sendTaskMessage: async (params) => {
              await automationRuntime.assertOwnership();
              const taskRepoForTrigger = new TaskStore(db);
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
              idempotencyKey?: string;
            }) => {
              await automationRuntime.assertOwnership();
              const messageId = await channelGateway.sendMessage?.(
                params.channelType as Any,
                params.channelId,
                params.text,
                { idempotencyKey: params.idempotencyKey },
              );
              if (!messageId) throw new Error("Channel gateway did not return a message receipt");
              return { messageId };
            },
            wakeAgent: async (agentRoleId: string) => {
              if (!heartbeatService) throw new Error("Heartbeat service is unavailable");
              const result = await heartbeatService.triggerHeartbeat(agentRoleId);
              if (result.status === "error")
                throw new Error(result.error || "Agent wake was not accepted");
            },
            getDefaultWorkspaceId: () => "",
            getActiveTaskCount: () => agentDaemon.getQueueStatus().runningTaskIds.length,
            log: (...args: unknown[]) => console.log("[EventTriggers]", ...args),
            onTriggerFired: async (payload) => {
              await MailboxAutomationRegistry.recordTriggerFire(payload).catch((error) => {
                logger.warn("[EventTriggers] Could not record mailbox trigger fire:", error);
              });
              await routineService?.recordEventTriggerFire(payload).catch((error) => {
                logger.warn("[EventTriggers] Could not record routine trigger fire:", error);
              });
            },
          },
          db,
        );
        const currentTriggerService = eventTriggerService;
        const mcpClientManager = MCPClientManager.getInstance();
        const syncMcpTriggerSubscriptions = async (): Promise<void> => {
          const subscriptions = currentTriggerService
            .listTriggers()
            .map(connectorTriggerSubscription)
            .filter((value): value is NonNullable<typeof value> => Boolean(value));
          await mcpClientManager.syncTriggerResourceSubscriptions(subscriptions);
          await mcpEventService?.sync();
        };
        mailboxForwardingService = new MailboxForwardingService({
          db,
          log: (...args: unknown[]) => logger.debug("[MailboxForwardingService]", ...args),
        });
        setMailboxForwardingServiceInstance(mailboxForwardingService);
        MailboxAutomationRegistry.configure({
          db,
          triggerService: currentTriggerService,
          resolveDefaultWorkspaceId: () => resolveDefaultWorkspace()?.id,
          log: (...args: unknown[]) => logger.debug("[MailboxAutomationRegistry]", ...args),
          onMutation: () => {
            void mailboxForwardingService?.refresh();
          },
        });
        mailboxForwardingService.start();
        automationRuntime.register("event_triggers", currentTriggerService);
        await automationRuntime.start("event_triggers");
        mcpEventService = new MCPEventService(db, mcpClientManager, currentTriggerService);
        await mcpEventService.start().catch((error) => {
          logger.warn("MCP Events service could not start:", error);
        });
        mcpClientManager.on("event", (event: { type: string }) => {
          if (event.type === "server_connected") void mcpEventService?.sync();
        });
        setHookTriggerEmitter((event) => {
          void currentTriggerService
            .evaluateEvent(event)
            .catch((error) => logger.warn("[EventTriggers] Hook event was not persisted:", error));
        });
        mcpClientManager.on("connector_event", (event) => {
          for (const triggerEvent of connectorTriggerEvents(event)) {
            void currentTriggerService
              .evaluateEvent(triggerEvent)
              .catch((error) => logger.warn("Connector trigger event failed:", error));
          }
        });
        void syncMcpTriggerSubscriptions();
        setupTriggerHandlers(currentTriggerService, syncMcpTriggerSubscriptions, mcpEventService);
        const managedSessionService = new ManagedSessionService(db, agentDaemon, {
          workContextService: new WorkContextService(db),
        });
        const routineTaskRepo = new TaskStore(db);
        const executeWorkflowAction = createRoutineWorkflowActionExecutor({
          createAgentTask: async (params) => {
            const task = await agentDaemon.createTask({
              title: params.title,
              prompt: params.prompt,
              workspaceId: params.workspaceId,
              agentConfig: {
                backgroundSchedulerFence: automationRuntime.captureFence(),
                ...(params.accessProfileId ? { accessProfileId: params.accessProfileId } : {}),
              },
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
              ...(params.assignedAgentRoleId
                ? { taskOverrides: { assignedAgentRoleId: params.assignedAgentRoleId } }
                : {}),
              agentConfig: {
                ...params.agentConfig,
                backgroundSchedulerFence: automationRuntime.captureFence(),
              },
              source: params.source,
            });
            return { id: task.id };
          },
          createTaskIdempotent: async (params) => {
            await automationRuntime.assertOwnership();
            const admitted = await agentDaemon.createTaskIdempotent({
              ...params,
              taskOverrides: params.assignedAgentRoleId
                ? { assignedAgentRoleId: params.assignedAgentRoleId }
                : undefined,
              agentConfig: {
                ...params.agentConfig,
                backgroundSchedulerFence: automationRuntime.captureFence(),
              },
            });
            return { id: admitted.task.id };
          },
          sendTaskMessage: async (params) => {
            await automationRuntime.assertOwnership();
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
              ? (await managedSessionService.getAgent(params.agentId))?.agent
              : (await managedSessionService.listAgents({ limit: 1 }))[0];
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
            const session = await managedSessionService.getSession(sessionId);
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
              resultSummary: task.resultSummary || undefined,
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
        automationRuntime.register("routines", {
          start: () => routineService!.startWorkflowRuntime(),
          stop: () => routineService!.stopWorkflowRuntime(),
        });
        await automationRuntime.start("routines");
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
          void routineService?.recordApiTriggerDispatch(payload).catch((error) => {
            logger.warn("Failed to record a routine API dispatch:", error);
          });
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
          log: (...args: unknown[]) => logger.debug("[MailboxAutomationHub]", ...args),
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
                  !isManagedScheduledWorkspacePath(workspace.path, getUserDataDir()),
              )
              .map((workspace) => ({
                workspaceId: workspace.id,
                workspacePath: workspace.path,
                name: workspace.name,
              })),
          getDefaultWorkspaceId: () => resolveDefaultWorkspace()?.id ?? TEMP_WORKSPACE_ID,
          recordActivity: ({ workspaceId, activityType, title, description, metadata }) => {
            void activityRepo
              .create({
                workspaceId,
                actorType: "system",
                activityType,
                title,
                description,
                metadata,
              })
              .catch((error: unknown) => logger.warn("Failed to record activity:", error));
          },
          emitTrigger: (event) => {
            void currentTriggerService.evaluateEvent(event);
          },
          wakeHeartbeats: ({ text, mode, workspaceId, category }) => {
            void submitHeartbeatSignalForAll({
              text,
              mode,
              source: "hook",
              workspaceId,
              category,
            }).catch((error) => {
              logger.warn("Failed to wake heartbeats:", error);
            });
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
                const taskRepo = new TaskStore(db);
                return (taskRepo.findByWorkspace(_workspaceId, 200) || []).filter(
                  (task) => typeof task.createdAt === "number" && task.createdAt >= _sinceMs,
                );
              } catch {
                return [];
              }
            },
            // Async (DB4): searches in the FTS worker when it runs. A failure skips the
            // briefing section with a logged error instead of showing no memories.
            // The briefing can reach a channel: only this workspace's non-private,
            // non-suppressed rows (SEC-14).
            searchMemory: async (workspaceId, query, limit) =>
              (await MemoryService.searchForBriefingAsync(workspaceId, query, limit)).map(
                (memory) => ({
                  summary: memory.snippet,
                  content: memory.snippet,
                  snippet: memory.snippet,
                  type: memory.type,
                }),
              ),
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
            const configuredWorkspaceIds = dailyBriefingService
              ? await dailyBriefingService.configuredWorkspaceIds()
              : [];
            const targetWorkspaceIds = new Set(
              configuredWorkspaceIds.filter(
                (workspaceId) => typeof workspaceId === "string" && workspaceId.length > 0,
              ),
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
                await activeDailyBriefingService.getConfig(workspaceId),
              );
            }
          });
        }

        // File Hub
        const fileHubService = new FileHubService(
          {
            getWorkspacePath: (wsId) => {
              try {
                const wsRepo = new WorkspaceStore(db);
                const ws =
                  (wsId ? wsRepo.findById(wsId) : null) ||
                  wsRepo
                    .findAll()
                    .find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ||
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
                  .filter((origin): origin is string => typeof origin === "string")
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
            console.warn("[WebAccess] Failed to load settings; using defaults:", error);
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

        const webAccessTaskRepo = new TaskStore(db);
        const webAccessWorkspaceRepo = new WorkspaceStore(db);

        const getDefaultWebWorkspaceId = (): string => {
          const firstWorkspace = webAccessWorkspaceRepo
            .findAll()
            .find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
          return firstWorkspace?.id || "";
        };

        const initialWebAccessSettings = loadWebAccessSettings();
        const webAccessServer = new WebAccessServer(initialWebAccessSettings, {
          handleIpcInvoke: async (channel: string, ...args: Any[]) => {
            switch (channel) {
              case "task:list":
                return webAccessTaskRepo.findAll();
              case "task:create": {
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
                if (!prompt) {
                  throw new Error("Task prompt is required.");
                }
                const workspaceId =
                  typeof payload.workspaceId === "string" && payload.workspaceId.trim().length > 0
                    ? payload.workspaceId.trim()
                    : getDefaultWebWorkspaceId();
                if (!workspaceId) {
                  throw new Error("No workspace available for task creation.");
                }
                const title =
                  typeof payload.title === "string" && payload.title.trim().length > 0
                    ? payload.title.trim()
                    : "Web Access Task";
                const accessProfileId =
                  typeof payload.accessProfileId === "string" && payload.accessProfileId.trim()
                    ? (payload.accessProfileId.trim() as AccessProfileId)
                    : undefined;
                return agentDaemon.createTask({
                  title,
                  prompt,
                  workspaceId,
                  ...(accessProfileId ? { agentConfig: { accessProfileId } } : {}),
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
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                let taskId: string;
                let message: string;
                let images: import("../shared/types").ImageAttachment[] | undefined;
                let quotedAssistantMessage:
                  | import("../shared/types").QuotedAssistantMessage
                  | undefined;
                let options:
                  | Pick<
                      import("../shared/types").TaskFollowUpInput,
                      | "permissionMode"
                      | "shellAccess"
                      | "accessProfileId"
                      | "integrationMentions"
                      | "expectedTurnId"
                    >
                  | undefined;
                try {
                  const sanitized = sanitizeTaskMessageParams(payload);
                  taskId = sanitized.taskId;
                  message = sanitized.message;
                  images = sanitized.images;
                  quotedAssistantMessage = sanitized.quotedAssistantMessage;
                  options = {
                    ...(sanitized.expectedTurnId
                      ? { expectedTurnId: sanitized.expectedTurnId }
                      : {}),
                    ...(sanitized.permissionMode
                      ? { permissionMode: sanitized.permissionMode }
                      : {}),
                    ...(sanitized.shellAccess !== undefined
                      ? { shellAccess: sanitized.shellAccess }
                      : {}),
                    ...(sanitized.accessProfileId
                      ? { accessProfileId: sanitized.accessProfileId }
                      : {}),
                    ...(sanitized.integrationMentions !== undefined
                      ? { integrationMentions: sanitized.integrationMentions }
                      : {}),
                  };
                } catch (err) {
                  throw new Error(
                    err instanceof Error ? err.message : "taskId and message are required.",
                  );
                }
                return agentDaemon.sendMessage(
                  taskId,
                  message,
                  images,
                  quotedAssistantMessage,
                  options,
                );
              }
              case "task:events": {
                const taskId = typeof args[0] === "string" ? args[0].trim() : "";
                if (!taskId) {
                  throw new Error("Task ID is required.");
                }
                const events = agentDaemon.getTaskEvents(taskId);
                const maxEvents = 600;
                return events.length > maxEvents ? events.slice(-maxEvents) : events;
              }
              case "workspace:list":
                return webAccessWorkspaceRepo
                  .findAll()
                  .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
              case "account:list": {
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                const status =
                  typeof payload.status === "string" ? payload.status.trim() : undefined;
                const accounts = ManagedAccountManager.list({
                  provider: typeof payload.provider === "string" ? payload.provider : undefined,
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
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                const accountId =
                  typeof payload.accountId === "string" ? payload.accountId.trim() : "";
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
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                const account = ManagedAccountManager.upsert(payload);
                return {
                  account: ManagedAccountManager.toPublicView(account, false),
                };
              }
              case "account:remove": {
                const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
                const accountId =
                  typeof payload.accountId === "string" ? payload.accountId.trim() : "";
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
                const workspaceId = typeof args[0] === "string" ? args[0].trim() : "";
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
        webAccessServerRef = webAccessServer;
        const normalizedWebAccessSettings = webAccessServer.getConfig();
        if (
          JSON.stringify(initialWebAccessSettings) !== JSON.stringify(normalizedWebAccessSettings)
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
          createPairingCode: isBrowserWebEnabled()
            ? () => {
                if (!browserWebApplication) throw new Error("Browser application is unavailable.");
                return browserWebApplication.createPairingCode("web-access");
              }
            : undefined,
        });
        await attachBrowserWebApplication(webAccessServer);

        // Hook triggers into gateway message events
        channelGateway.onEvent((event) => {
          if (event.type === "message:received" && event.data) {
            const channelType = event.channel || "";
            const chatId = (event.data.chatId as string) || "";
            const messageId = (event.data.messageId as string) || "";
            const channelDbId = (event.data.channelId as string) || "";
            const identityParts = [channelType, channelDbId, chatId, messageId];
            const eventId = identityParts.every((part) => part.length > 0 && part.length <= 1024)
              ? `gateway-message-v1:${createHash("sha256")
                  .update(JSON.stringify(["gateway-message-v1", ...identityParts]))
                  .digest("hex")}`
              : undefined;
            void eventTriggerService
              ?.evaluateEvent({
                source: "channel_message",
                ...(eventId ? { eventId } : {}),
                fields: {
                  channelType,
                  channelInstanceId: channelDbId,
                  chatId,
                  text: (event.data.text as string) || "",
                  senderName: (event.data.senderName as string) || "",
                },
                timestamp: event.timestamp.getTime(),
              })
              .catch((error) =>
                logger.warn("[EventTriggers] Gateway event was not persisted:", error),
              );
          }
        });

        // Initialize system tray (macOS menu bar / Windows system tray)
        if (process.platform === "darwin" || process.platform === "win32") {
          await trayManager.initialize(mainWindow, channelGateway, dbManager, agentDaemon);
        }

        // Show migration notification after window is ready
        if (migrationResult.migrated && migrationResult.migratedKeys.length > 0) {
          mainWindow.webContents.once("did-finish-load", () => {
            void dialog.showMessageBox(mainWindow!, {
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

    installGracefulShutdown(
      app,
      [
        { name: "security monitor", run: () => NumbatService.getInstance()?.shutdown() },
        {
          name: "cleanup timers",
          run: () => {
            clearInterval(managedBriefingCleanupTimer);
            if (tempWorkspacePruneTimer) {
              clearInterval(tempWorkspacePruneTimer);
              tempWorkspacePruneTimer = null;
            }
            if (tempSandboxProfilePruneTimer) {
              clearInterval(tempSandboxProfilePruneTimer);
              tempSandboxProfilePruneTimer = null;
            }
            if (coreMemoryDistillTimer) {
              clearInterval(coreMemoryDistillTimer);
              coreMemoryDistillTimer = null;
            }
          },
        },
        { name: "tray", run: () => trayManager.destroy() },
        {
          // Closing the windows now lets the renderer save the open composer draft (it
          // saves on hide and unload) while storage is open. Left to the end of quit,
          // that save hit a closed database and the latest draft text was lost.
          name: "windows",
          run: async () => {
            await closeWindowsForShutdown(BrowserWindow.getAllWindows());
            await waitForComposerDraftWrites();
          },
        },
        {
          name: "workflow runtime",
          run: async () => {
            if (headlessBotAutomation) await headlessBotAutomation.stop();
            else await automationRuntime.stop("routines");
          },
        },
        {
          name: "workflow watcher",
          run: () => {
            workflowStarterWatcher?.stop();
            workflowStarterWatcher = null;
          },
        },
        {
          name: "cron",
          run: async () => {
            await automationRuntime.stop("cron");
            setCronService(null);
          },
        },
        {
          name: "ambient monitoring",
          run: async () => {
            await ambientMonitoringService?.stop();
            ambientMonitoringService = null;
          },
        },
        {
          name: "mailbox forwarding",
          run: () => {
            mailboxForwardingService?.stop();
            mailboxForwardingService = null;
            setMailboxForwardingServiceInstance(null);
          },
        },
        {
          name: "awareness",
          run: async () => {
            await awarenessService?.stop();
            awarenessService = null;
          },
        },
        {
          name: "strategic planner",
          run: async () => {
            await automationRuntime.stop("strategic_planner");
            strategicPlannerService = null;
            setStrategicPlannerService(null);
          },
        },
        {
          name: "subconscious loop",
          run: () => {
            subconsciousLoopService?.stop();
            subconsciousLoopService = null;
          },
        },
        { name: "canvas", run: () => cleanupCanvasHandlers() },
        {
          name: "web access",
          run: async () => {
            await webAccessServerRef?.stop();
            webAccessServerRef = null;
          },
        },
        { name: "control plane", run: () => shutdownControlPlane() },
        {
          name: "MCP Events",
          run: async () => {
            await mcpEventService?.stop();
            mcpEventService = null;
          },
        },
        {
          name: "event triggers",
          run: async () => {
            await automationRuntime.stop("event_triggers");
            eventTriggerService = null;
          },
        },
        { name: "channel gateway", run: () => channelGateway?.shutdown() },
        {
          name: "meeting artifacts",
          run: () => MeetingArtifactsService.getInstance()?.shutdown(),
        },
        { name: "mailbox", run: () => MailboxService.stopBackgroundServices() },
        { name: "box brain", run: () => BoxBrainService.getInstance().stop() },
        {
          name: "heartbeats",
          run: async () => {
            setHeartbeatSignalEmitter(null);
            await automationRuntime.stop("heartbeat");
            heartbeatService = null;
            setHeartbeatService(null);
          },
        },
        { name: "automation ownership", run: () => automationRuntime.shutdown() },
        // Keep lifecycle listeners, MCP, memory, and storage alive until tasks settle.
        { name: "agent daemon", run: () => agentDaemon?.shutdown() },
        {
          name: "task lifecycle sync",
          run: () => {
            detachTaskLifecycleSync?.();
            detachTaskLifecycleSync = null;
          },
        },
        {
          name: "usage insights",
          requiresQuiescence: true,
          run: () => UsageInsightsProjector.shutdown(),
        },
        // Lore, cross signals, feedback: flush and release the kit-writer lease.
        {
          name: "kit writers",
          run: async () => {
            await kitWriterOwnership?.stop();
            kitWriterOwnership = null;
          },
        },
        // Finish the memory repo write in progress (bounded) and stop its writer.
        {
          name: "memory repo",
          requiresQuiescence: true,
          run: () => stopMemoryRepo(),
        },
        {
          name: "MCP servers",
          requiresQuiescence: true,
          run: () => MCPClientManager.getInstance().shutdown(),
        },
        // Stop the deferred memory jobs and let queued memory_items writes land before the
        // database closes (as the node daemon does).
        {
          name: "memory engine",
          requiresQuiescence: true,
          run: async () => {
            memoryRetentionService?.stop();
            memoryRetentionService = null;
            stopMemoryEngine?.();
            stopMemoryEngine = null;
            await MemoryWriter.get()?.flush();
          },
        },
        // Conversation-index writes are batched (250 ms); write the queue before closing.
        {
          name: "conversation index",
          requiresQuiescence: true,
          run: () => DurableContextService.flushIndexQueue(),
        },
        // Let a running compression batch, markdown sync or cleanup finish first.
        {
          name: "memory",
          requiresQuiescence: true,
          run: async () => {
            await MemoryService.drain();
            MemoryService.shutdown();
          },
        },
        {
          name: "pulse",
          run: async () => {
            await pulseService?.shutdown();
            pulseService = null;
          },
        },
        { name: "local previews", run: () => getLocalPreviewProcessService().stopAll() },
        { name: "host perf monitor", run: () => hostPerfMonitor?.stop() },
        {
          name: "database worker",
          requiresQuiescence: true,
          run: async () => {
            databaseWorkerDrained = (await stopDatabaseWorker()).drained;
          },
        },
        {
          name: "database",
          requiresQuiescence: true,
          // A failed step or an undrained worker leaves this run marked incomplete, so
          // the next start reports it (DB6).
          run: ({ quiescent }) => dbManager?.close({ clean: quiescent && databaseWorkerDrained }),
        },
      ],
      (name, error) => console.error(`[Main] Failed to stop ${name}:`, error),
    );

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

    /** Set a workbench session's access policy from its task's effective access profile. */
    const applyBrowserWorkbenchAccessPolicy = async (
      taskId: string,
      sessionId: string,
    ): Promise<boolean> => {
      if (!agentDaemon) return false;
      const task = await agentDaemon.getTaskById(taskId);
      const workspace = task && agentDaemon.getWorkspaceById(task.workspaceId);
      if (!task || !workspace) return false;
      const effective = applyAccessProfileToWorkspace(
        workspace,
        resolveEffectiveAccessProfile({
          task,
          workspace,
          settings: PermissionSettingsManager.loadSettings(),
          adminPolicies: loadPolicies(),
        }),
      );
      getBrowserWorkbenchService().setAccessPolicy({
        taskId: task.id,
        sessionId,
        networkEnabled: effective.permissions.network === true,
        accessNetworkMode: effective.permissions.accessNetworkMode,
        profileDomainRules: effective.permissions.accessDomainRules,
      });
      return true;
    };
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_REGISTER, async (event, data: Any) => {
      if (!data || typeof data.taskId !== "string" || typeof data.webContentsId !== "number") {
        throw new Error("Invalid browser workbench registration");
      }
      // Only a browser-partition <webview> hosted by the calling window can be
      // registered; anything else (the app window itself, another guest) would
      // hand its debugger to browser tools.
      const guest = webContents.fromId(data.webContentsId);
      if (
        !guest ||
        guest.isDestroyed() ||
        guest.getType() !== "webview" ||
        guest.hostWebContents?.id !== event.sender.id ||
        !browserWorkbenchSessions.has(guest.session as object)
      ) {
        throw new Error("Invalid browser workbench registration");
      }
      if (!agentDaemon) throw new Error("Agent daemon is not ready");
      if (
        !(await applyBrowserWorkbenchAccessPolicy(
          data.taskId,
          typeof data.sessionId === "string" ? data.sessionId : "default",
        ))
      ) {
        throw new Error("Browser task workspace not found");
      }
      await getBrowserWorkbenchService().registerSession({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        tabId: readBrowserTabId(data.tabId),
        activate: data.activate === true,
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
        tabId: readBrowserTabId(data.tabId),
        webContentsId: typeof data.webContentsId === "number" ? data.webContentsId : undefined,
      });
      return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_STATUS, (_event, data: Any) => {
      if (!data || typeof data.taskId !== "string") return;
      getBrowserWorkbenchService().updateSessionStatus({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        tabId: readBrowserTabId(data.tabId),
        webContentsId: typeof data.webContentsId === "number" ? data.webContentsId : undefined,
        url: typeof data.url === "string" ? data.url : undefined,
        title: typeof data.title === "string" ? data.title : undefined,
      });
      return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_ACTIVATE, (_event, data: Any) => {
      const tabId = readBrowserTabId(data?.tabId);
      if (!data || typeof data.taskId !== "string" || !tabId) return { success: false };
      const success = getBrowserWorkbenchService().activateTab({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        tabId,
      });
      return { success };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_USER_NAVIGATE, async (_event, data: Any) => {
      const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "default";
      const invalid = {
        allowed: false,
        url: "",
        block: { reason: "policy", detail: "invalid_request" },
      };
      if (!data || typeof data.taskId !== "string" || typeof data.url !== "string") return invalid;
      // Allowances are scoped to a real task's session. The first tab may still be
      // registering when the user types, so the task's access policy is applied here
      // too (the same derivation registration uses).
      if (
        !getBrowserWorkbenchService().getSession(data.taskId, sessionId) &&
        !(await applyBrowserWorkbenchAccessPolicy(data.taskId, sessionId))
      ) {
        return invalid;
      }
      return getBrowserWorkbenchService().userNavigate({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        url: data.url.slice(0, 8192),
      });
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_RESPOND, (_event, data: Any) => {
      const response = data?.response;
      if (
        !data ||
        typeof data.requestId !== "string" ||
        (response !== "allow-once" &&
          response !== "allow-always" &&
          response !== "block" &&
          response !== "dismiss")
      ) {
        return { success: false };
      }
      return {
        success: getBrowserWorkbenchService().respondToPermission(data.requestId, response),
      };
    });
    registerBrowserPlatformIpc({
      ipcMain,
      getDatabase: () => dbManager.getDatabase(),
      service: getBrowserWorkbenchService(),
      downloads: getBrowserDownloadManager(),
      sessionFromPartition: (partition) => session.fromPartition(partition),
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_INSPECT_AREA, async (_event, data: Any) => {
      const rect = data?.rect;
      if (
        !data ||
        typeof data.taskId !== "string" ||
        !rect ||
        !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rect[key])))
      ) {
        return { success: false, error: "Invalid area" };
      }
      const area = await getBrowserWorkbenchService().inspectArea({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        rect,
      });
      return area ? { success: true, area } : { success: false, error: "Nothing to inspect" };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_STYLE_PREVIEW, async (_event, data: Any) => {
      if (
        !data ||
        typeof data.taskId !== "string" ||
        typeof data.selector !== "string" ||
        (data.action !== "apply" && data.action !== "revert")
      ) {
        return { success: false, error: "Invalid style preview" };
      }
      const styles =
        data.styles && typeof data.styles === "object" && !Array.isArray(data.styles)
          ? (data.styles as Record<string, string>)
          : undefined;
      const result = await getBrowserWorkbenchService().previewStyle({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        selector: data.selector,
        action: data.action,
        styles,
        text: typeof data.text === "string" ? data.text : undefined,
      });
      return result || { success: false, error: "No browser tab" };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_FOCUS, (_event, data: Any) => {
      browserWorkbenchChromeFocused = data?.focused === true;
      return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_DIAGNOSTICS_GET, async (_event, data: Any) => {
      const kind = data?.kind;
      if (
        !data ||
        typeof data.taskId !== "string" ||
        !["console", "network", "downloads", "storage"].includes(kind)
      ) {
        return { success: false, error: "Invalid diagnostics request" };
      }
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : "default";
      const tabId = readBrowserTabId(data.tabId);
      if (data.clear === true && (kind === "console" || kind === "network")) {
        getBrowserSessionManager().clearTabDiagnostics({
          taskId: data.taskId,
          sessionId,
          tabId,
          kind,
        });
      }
      try {
        const result = await getBrowserSessionManager().getTabDiagnostics({
          taskId: data.taskId,
          sessionId,
          tabId,
          kind,
        });
        return result || { success: false, error: "No browser tab" };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_TRACE, async (_event, data: Any) => {
      if (
        !data ||
        typeof data.taskId !== "string" ||
        (data.action !== "start" && data.action !== "stop")
      ) {
        return { success: false, error: "Invalid trace request" };
      }
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : "default";
      const tabId = readBrowserTabId(data.tabId);
      try {
        const manager = getBrowserSessionManager();
        const result =
          data.action === "start"
            ? await manager.traceStart(data.taskId, sessionId, tabId)
            : await manager.traceStop(data.taskId, sessionId, tabId);
        return result || { success: false, error: "No browser tab" };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_SNAPSHOT_GET, (_event, data: Any) => {
      if (!data || typeof data.taskId !== "string") return null;
      return getBrowserSessionManager().getSnapshotOverlay(
        data.taskId,
        typeof data.sessionId === "string" ? data.sessionId : "default",
        readBrowserTabId(data.tabId),
      );
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_LIST, (_event, data: Any) => {
      if (!data || typeof data.taskId !== "string") return [];
      return getBrowserWorkbenchService().listPendingPermissions(
        data.taskId,
        typeof data.sessionId === "string" ? data.sessionId : "default",
      );
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_WORKBENCH_SCREENSHOT, async (_event, data: Any) => {
      if (!data || typeof data.taskId !== "string" || typeof data.workspacePath !== "string") {
        return { success: false, error: "Invalid browser screenshot request" };
      }
      const effectiveWorkspace = agentDaemon.getEffectiveWorkspaceForTask(data.taskId);
      if (!effectiveWorkspace) {
        return { success: false, error: "Task workspace is unavailable" };
      }
      const result = await getBrowserWorkbenchService().screenshot({
        taskId: data.taskId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
        // The task's live workspace is authoritative. Never let renderer input
        // select an arbitrary directory for a screenshot write.
        workspacePath: effectiveWorkspace.path,
        workspacePermissions: effectiveWorkspace.permissions,
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

    ipcMain.handle(
      IPC_CHANNELS.BROWSER_WORKBENCH_RESOLVE_ANNOTATION_TARGETS,
      async (_event, data: Any) => {
        if (!data || typeof data.taskId !== "string" || !Array.isArray(data.targets)) {
          return { success: false, error: "Invalid browser annotation target resolve request" };
        }
        const targets = await getBrowserWorkbenchService().resolveAnnotationTargets({
          taskId: data.taskId,
          sessionId: typeof data.sessionId === "string" ? data.sessionId : "default",
          targets: data.targets.filter((target: Any) => target && typeof target === "object"),
        });
        return { success: true, targets };
      },
    );

    const getAnnotationRepo = () => new AnnotationRepository(dbManager.getDatabase());
    const annotationSurfaceTypes = new Set(["browser", "diff", "file", "artifact", "message"]);
    const logAnnotationEvent = (
      type: string,
      annotation: Any,
      extra: Record<string, unknown> = {},
    ) => {
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

    ipcMain.handle(IPC_CHANNELS.ANNOTATION_CREATE, async (_event, data: Any) => {
      if (!data || typeof data !== "object") {
        throw new Error("Invalid annotation payload");
      }
      const taskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
      const body = typeof data.body === "string" ? data.body.trim() : "";
      const surfaceType = typeof data.surfaceType === "string" ? data.surfaceType.trim() : "";
      if (!taskId) throw new Error("Annotation taskId is required");
      if (!body) throw new Error("Annotation body is required");
      if (!annotationSurfaceTypes.has(surfaceType))
        throw new Error("Annotation surfaceType is invalid");
      if (!data.targetRef || typeof data.targetRef !== "object") {
        throw new Error("Annotation targetRef is required");
      }

      const annotation = await getAnnotationRepo().create({
        taskId,
        workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : undefined,
        surfaceType: surfaceType as Any,
        surfaceId: typeof data.surfaceId === "string" ? data.surfaceId : undefined,
        body,
        targetRef: data.targetRef,
        stylePatch:
          data.stylePatch && typeof data.stylePatch === "object" ? data.stylePatch : undefined,
        artifactId: typeof data.artifactId === "string" ? data.artifactId : undefined,
        screenshotPath: typeof data.screenshotPath === "string" ? data.screenshotPath : undefined,
        createdBy:
          data.createdBy === "agent" || data.createdBy === "review" ? data.createdBy : "user",
      });
      logAnnotationEvent("annotation_created", annotation);
      return annotation;
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATION_LIST, async (_event, query: Any) => {
      const normalized = query && typeof query === "object" ? query : {};
      return await getAnnotationRepo().list({
        taskId: typeof normalized.taskId === "string" ? normalized.taskId : undefined,
        workspaceId:
          typeof normalized.workspaceId === "string" ? normalized.workspaceId : undefined,
        surfaceType:
          typeof normalized.surfaceType === "string" ? normalized.surfaceType : undefined,
        surfaceId: typeof normalized.surfaceId === "string" ? normalized.surfaceId : undefined,
        statuses: Array.isArray(normalized.statuses) ? normalized.statuses : undefined,
        limit: typeof normalized.limit === "number" ? normalized.limit : undefined,
      });
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATION_UPDATE, async (_event, data: Any) => {
      const id = typeof data?.id === "string" ? data.id.trim() : "";
      if (!id) throw new Error("Annotation id is required");
      const patch = data?.patch && typeof data.patch === "object" ? data.patch : {};
      const annotation = await getAnnotationRepo().update(id, patch);
      if (annotation) logAnnotationEvent("annotation_updated", annotation);
      return annotation || null;
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATION_RESOLVE, async (_event, data: Any) => {
      const id = typeof data?.id === "string" ? data.id.trim() : "";
      if (!id) throw new Error("Annotation id is required");
      const annotation = await getAnnotationRepo().update(id, {
        status: "resolved",
        resolvedByEventId:
          typeof data?.resolvedByEventId === "string" ? data.resolvedByEventId : undefined,
      });
      if (annotation) logAnnotationEvent("annotation_resolved", annotation);
      return annotation || null;
    });

    ipcMain.handle(IPC_CHANNELS.ANNOTATION_DISMISS, async (_event, data: Any) => {
      const id = typeof data?.id === "string" ? data.id.trim() : "";
      if (!id) throw new Error("Annotation id is required");
      const annotation = await getAnnotationRepo().update(id, { status: "dismissed" });
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
          return new WorkspaceStore(dbManager.getDatabase())
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
      ownerWindow?: BrowserWindow | null,
    ) => {
      const startedAt = Date.now();
      const parentWindow = ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : null;
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
        parentWindow: Boolean(parentWindow),
        properties: options.properties ?? [],
        title: options.title ?? null,
      });

      try {
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, options)
          : await dialog.showOpenDialog(options);
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
    ipcMain.handle(
      IPC_CHANNELS.DIALOG_SELECT_FOLDER,
      async (event, defaultPath?: string | null) => {
        const resolvedDefaultPath = await resolveDialogDefaultPath(defaultPath);
        const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
        const result = await showOpenDialogWithLogging(
          "folder",
          {
            // Allow creating folders directly from the native picker when supported.
            properties: ["openDirectory", "createDirectory"],
            title: "Select Workspace Folder",
            defaultPath: resolvedDefaultPath,
          },
          ownerWindow,
        );

        if (!result.canceled && result.filePaths.length > 0) {
          return result.filePaths[0];
        }
        return null;
      },
    );

    // OS-rendered preview (Quick Look on macOS, the shell thumbnail cache on Windows) so the
    // composer can show real thumbnails for images, PDFs, Office docs, etc. Unsupported on
    // Linux and for some file types; callers fall back to a file-type tile.
    const ATTACHMENT_THUMBNAIL_SIZE = { width: 192, height: 192 };
    const ATTACHMENT_THUMBNAIL_TIMEOUT_MS = 2000;
    const createAttachmentThumbnail = async (filePath: string): Promise<string | undefined> => {
      if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
      try {
        const image = await Promise.race([
          nativeImage.createThumbnailFromPath(filePath, ATTACHMENT_THUMBNAIL_SIZE),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), ATTACHMENT_THUMBNAIL_TIMEOUT_MS),
          ),
        ]);
        if (!image || image.isEmpty()) return undefined;
        return image.toDataURL();
      } catch {
        return undefined;
      }
    };

    // Handle file selection (attachments)
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILES, async (event, defaultPath?: string | null) => {
      const resolvedDefaultPath = await resolveDialogDefaultPath(defaultPath);
      const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const result = await showOpenDialogWithLogging(
        "files",
        {
          properties: ["openFile", "multiSelections"],
          title: "Select Files to Upload",
          defaultPath: resolvedDefaultPath,
        },
        ownerWindow,
      );

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
            const thumbnailDataUrl = await createAttachmentThumbnail(filePath);
            return {
              path: filePath,
              name: path.basename(filePath),
              size: stats.size,
              mimeType: (mime.lookup(filePath) || undefined) as string | undefined,
              ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
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
          thumbnailDataUrl?: string;
        } => Boolean(entry),
      );
      rememberApprovedImportFiles(validEntries.map((entry) => entry.path));
      return validEntries;
    });
  } // single-instance guard
} // CLI direct-run guard
