import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS, HeartbeatConfig } from "../../shared/types";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import {
  TaskSubscriptionRepository,
  SubscriptionReason,
} from "../agents/TaskSubscriptionRepository";
import { StandupReportService } from "../reports/StandupReportService";
import { HeartbeatService } from "../agents/HeartbeatService";
import { rateLimiter } from "../utils/rate-limiter";
import { validateInput, UUIDSchema } from "../utils/validation";
import { createLogger } from "../utils/logger";

const logger = createLogger("MissionControl");

// Get main window for event broadcasting
let mainWindowGetter: (() => BrowserWindow | null) | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindowGetter?.() ?? null;
}

/**
 * Rate limit check helper
 */
function checkRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    throw new Error(`Rate limit exceeded for ${channel}`);
  }
}

/**
 * Dependencies for Mission Control handlers
 */
export interface MissionControlDeps {
  agentRoleRepo: AgentRoleRepository;
  taskSubscriptionRepo: TaskSubscriptionRepository;
  standupService: StandupReportService;
  heartbeatService: HeartbeatService;
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Set up Mission Control IPC handlers
 */
export function setupMissionControlHandlers(deps: MissionControlDeps): void {
  mainWindowGetter = deps.getMainWindow;

  const { agentRoleRepo, taskSubscriptionRepo, standupService, heartbeatService } = deps;

  // ============ Heartbeat Handlers ============

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_CONFIG, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    const role = agentRoleRepo.findById(validated);
    if (!role) {
      throw new Error("Agent role not found");
    }
    return {
      heartbeatEnabled: role.heartbeatEnabled,
      heartbeatIntervalMinutes: role.heartbeatIntervalMinutes,
      heartbeatStaggerOffset: role.heartbeatStaggerOffset,
      lastHeartbeatAt: role.lastHeartbeatAt,
      heartbeatStatus: role.heartbeatStatus,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG,
    async (_, agentRoleId: string, config: HeartbeatConfig) => {
      checkRateLimit(IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG);
      const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const result = agentRoleRepo.updateHeartbeatConfig(validated, config);
      if (result) {
        heartbeatService.updateAgentConfig(validated, config);
        getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, {
          type: "config_updated",
          agentRoleId: validated,
          config,
        });
      }
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_TRIGGER, async (_, agentRoleId: string) => {
    checkRateLimit(IPC_CHANNELS.HEARTBEAT_TRIGGER);
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    const result = await heartbeatService.triggerHeartbeat(validated);
    getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, {
      type: "triggered",
      agentRoleId: validated,
      result,
    });
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_STATUS, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    return heartbeatService.getStatus(validated);
  });

  ipcMain.handle(IPC_CHANNELS.HEARTBEAT_GET_ALL_STATUS, async () => {
    return heartbeatService.getAllStatus();
  });

  // Forward heartbeat events to renderer
  heartbeatService.on("heartbeat", (event) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.HEARTBEAT_EVENT, event);
  });

  // ============ Task Subscription Handlers ============

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_LIST, async (_, taskId: string) => {
    const validated = validateInput(UUIDSchema, taskId, "task ID");
    return taskSubscriptionRepo.getSubscribers(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_ADD,
    async (_, taskId: string, agentRoleId: string, reason: SubscriptionReason) => {
      checkRateLimit(IPC_CHANNELS.SUBSCRIPTION_ADD);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedAgentRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const subscription = taskSubscriptionRepo.subscribe(
        validatedTaskId,
        validatedAgentRoleId,
        reason,
      );
      getMainWindow()?.webContents.send(IPC_CHANNELS.SUBSCRIPTION_EVENT, {
        type: "added",
        subscription,
      });
      return subscription;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_REMOVE,
    async (_, taskId: string, agentRoleId: string) => {
      checkRateLimit(IPC_CHANNELS.SUBSCRIPTION_REMOVE);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedAgentRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      const success = taskSubscriptionRepo.unsubscribe(validatedTaskId, validatedAgentRoleId);
      if (success) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.SUBSCRIPTION_EVENT, {
          type: "removed",
          taskId: validatedTaskId,
          agentRoleId: validatedAgentRoleId,
        });
      }
      return { success };
    },
  );

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_GET_SUBSCRIBERS, async (_, taskId: string) => {
    const validated = validateInput(UUIDSchema, taskId, "task ID");
    return taskSubscriptionRepo.getSubscribers(validated);
  });

  ipcMain.handle(IPC_CHANNELS.SUBSCRIPTION_GET_FOR_AGENT, async (_, agentRoleId: string) => {
    const validated = validateInput(UUIDSchema, agentRoleId, "agent role ID");
    return taskSubscriptionRepo.getSubscriptionsForAgent(validated);
  });

  // ============ Standup Report Handlers ============

  ipcMain.handle(IPC_CHANNELS.STANDUP_GENERATE, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.STANDUP_GENERATE);
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.generateReport(validated);
  });

  ipcMain.handle(IPC_CHANNELS.STANDUP_GET_LATEST, async (_, workspaceId: string) => {
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.getLatest(validated);
  });

  ipcMain.handle(IPC_CHANNELS.STANDUP_LIST, async (_, workspaceId: string, limit?: number) => {
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return standupService.list({ workspaceId: validated, limit });
  });

  ipcMain.handle(
    IPC_CHANNELS.STANDUP_DELIVER,
    async (_, reportId: string, channelType: string, channelId: string) => {
      checkRateLimit(IPC_CHANNELS.STANDUP_DELIVER);
      const validatedReportId = validateInput(UUIDSchema, reportId, "report ID");
      const report = standupService.findById(validatedReportId);
      if (!report) {
        throw new Error("Standup report not found");
      }
      await standupService.deliverReport(report, { channelType, channelId });
      return { success: true };
    },
  );

  logger.debug("Handlers initialized");
}
