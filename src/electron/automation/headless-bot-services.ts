import { setHeartbeatSignalEmitter } from "../agents/heartbeat-signal-bus";
import { createHash } from "crypto";
import { connectorTriggerEvents, connectorTriggerSubscription } from "./connector-trigger-events";
import type { MCPConnectorEvent } from "../mcp/client/MCPServerConnection";
import type Database from "better-sqlite3";
import type { AgentDaemon } from "../agent/daemon";
import type { ChannelGateway } from "../gateway";
import type { CronService } from "../cron";
import type { AutomationRuntime } from "../automation/AutomationRuntime";
import { HeartbeatService, setHeartbeatService } from "../agents/HeartbeatService";
import {
  AgentRoleRepository,
  MentionRepository,
  WorkingStateRepository,
} from "../agents/agent-repository-facades";
import { ActivityRepository } from "../activity/activity-repository-facades";
import { TaskRepository } from "../database/repository-facades";
import { EventTriggerService } from "../triggers/EventTriggerService";
import { RoutineService } from "../routines/service";
import { HooksSettingsManager } from "../hooks/settings";
import { createRoutineWorkflowActionExecutor } from "../routines/workflow/action-executor";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { loadPolicies } from "../admin/policies";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../security/access-profile-resolver";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import type { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPEventService } from "../mcp/events/MCPEventService";
import type { ChannelType } from "../gateway/channels/types";

/** Reuse the same repositories and engines in Node; desktop-only executors are absent. */
export function createHeadlessBotAutomation(input: {
  db: Database.Database;
  runtime: AutomationRuntime;
  agentDaemon: AgentDaemon;
  channelGateway: ChannelGateway;
  getCronService: () => CronService | null;
  heartbeat?: HeartbeatService | null;
  mcpClientManager?: MCPClientManager | null;
  log: (...args: unknown[]) => void;
}) {
  const { db, agentDaemon, runtime } = input;
  const tasks = new TaskRepository(db);
  const createTask = async (params: Parameters<AgentDaemon["createTask"]>[0]) => {
    const task = await agentDaemon.createTask({
      ...params,
      agentConfig: { ...params.agentConfig, backgroundSchedulerFence: runtime.captureFence() },
    });
    return { id: task.id };
  };
  const sendTaskMessage = async (params: {
    taskId: string;
    message: string;
    agentConfig?: import("../../shared/types").AgentConfig;
  }) => {
    await runtime.assertOwnership();
    if (!(await tasks.findById(params.taskId))) throw new Error("Target task not found");
    return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
      agentConfigOverride: params.agentConfig,
    });
  };
  const heartbeat =
    input.heartbeat ??
    new HeartbeatService({
      db,
      agentRoleRepo: new AgentRoleRepository(db),
      mentionRepo: new MentionRepository(db),
      workingStateRepo: new WorkingStateRepository(db),
      activityRepo: new ActivityRepository(db),
      createTask: (workspaceId, prompt, title, agentRoleId, options) =>
        agentDaemon.createTask({
          workspaceId,
          prompt,
          title,
          source: options?.source,
          agentConfig: options?.agentConfig,
          taskOverrides: {
            ...options?.taskOverrides,
            ...(agentRoleId ? { assignedAgentRoleId: agentRoleId } : {}),
          },
        }),
      getTasksForAgent: async (agentRoleId) =>
        (
          await tasks.findByStatus([
            "pending",
            "queued",
            "planning",
            "executing",
            "paused",
            "blocked",
            "interrupted",
          ])
        ).filter((task) => task.assignedAgentRoleId === agentRoleId && !task.heartbeatRunId),
      getTaskStatus: async (taskId) => (await tasks.findById(taskId))?.status,
      // No implicit workspace selection: pending work and scoped signals choose it.
      getDefaultWorkspaceId: () => undefined,
      getDefaultWorkspacePath: () => undefined,
      getWorkspacePath: (id) => agentDaemon.getWorkspaceById(id)?.path,
      getWorkspaceMemoryReadGuard: (id) => {
        try {
          const workspace = agentDaemon.getWorkspaceById(id);
          if (!workspace) return () => false;
          const profile = resolveEffectiveAccessProfile({
            workspace,
            settings: PermissionSettingsManager.loadSettings(),
            adminPolicies: loadPolicies(),
          });
          const effective = applyAccessProfileToWorkspace(workspace, profile);
          return (path) => {
            try {
              return (
                evaluateWorkspaceFilesystemAccess(effective, path, "read").decision === "allow"
              );
            } catch {
              return false;
            }
          };
        } catch {
          return () => false;
        }
      },
    });
  const triggers: EventTriggerService = new EventTriggerService(
    {
      getResponsibilityAccess: () => ({
        settings: PermissionSettingsManager.loadSettings(),
        adminPolicies: loadPolicies(),
      }),
      createTask: (params) => createTask({ ...params, source: "hook" }),
      sendTaskMessage,
      deliverToChannel: async (params) => {
        await runtime.assertOwnership();
        const messageId = await input.channelGateway.sendMessage(
          params.channelType as ChannelType,
          params.channelId,
          params.text,
          { idempotencyKey: params.idempotencyKey },
        );
        if (!messageId) throw new Error("Channel gateway did not return a message receipt");
        return { messageId };
      },
      wakeAgent: async (roleId) => {
        const result = await heartbeat.triggerHeartbeat(roleId);
        if (result.status === "error")
          throw new Error(result.error || "Agent wake was not accepted");
      },
      getDefaultWorkspaceId: () => "",
      getActiveTaskCount: () => agentDaemon.getQueueStatus().runningTaskIds.length,
      log: input.log,
      onTriggerFired: (payload) => routines.recordEventTriggerFire(payload).catch(input.log),
    },
    db,
  );
  const mcpEvents = input.mcpClientManager
    ? new MCPEventService(db, input.mcpClientManager, triggers)
    : null;
  const syncSubscriptions = async () => {
    await input.mcpClientManager?.syncTriggerResourceSubscriptions(
      triggers
        .listTriggers()
        .filter((trigger) => trigger.enabled)
        .map(connectorTriggerSubscription)
        .filter((subscription) => subscription !== null),
    );
    await mcpEvents?.sync();
  };
  const routines: RoutineService = new RoutineService({
    db,
    getCronService: input.getCronService,
    getEventTriggerService: () => triggers,
    loadHooksSettings: () => HooksSettingsManager.loadSettings(),
    saveHooksSettings: (settings) => HooksSettingsManager.saveSettings(settings),
    createTask: (params) =>
      createTask({
        ...params,
        taskOverrides: params.assignedAgentRoleId
          ? { assignedAgentRoleId: params.assignedAgentRoleId }
          : undefined,
      }),
    createTaskIdempotent: async (params) => {
      await runtime.assertOwnership();
      const admitted = await agentDaemon.createTaskIdempotent({
        ...params,
        taskOverrides: params.assignedAgentRoleId
          ? { assignedAgentRoleId: params.assignedAgentRoleId }
          : undefined,
        agentConfig: { ...params.agentConfig, backgroundSchedulerFence: runtime.captureFence() },
      });
      return { id: admitted.task.id };
    },
    sendTaskMessage,
    onTriggerMutation: syncSubscriptions,
    getTaskSnapshot: async (taskId) => (await tasks.findById(taskId)) ?? null,
    executeWorkflowAction: createRoutineWorkflowActionExecutor({
      createAgentTask: (params) =>
        createTask({
          title: params.title,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
          agentConfig: params.accessProfileId
            ? { accessProfileId: params.accessProfileId }
            : undefined,
        }),
      getTaskSnapshot: async (taskId) => (await tasks.findById(taskId)) ?? null,
      cancelAgentTask: (taskId) => agentDaemon.cancelTask(taskId),
    }),
  });
  triggers.setFireInterceptor((trigger, event) =>
    routines.interceptManagedEventTrigger(trigger, event),
  );
  runtime.register("heartbeat", heartbeat);
  runtime.register("event_triggers", triggers);
  runtime.register("routines", {
    start: () => routines.startWorkflowRuntime(),
    stop: () => routines.stopWorkflowRuntime(),
  });
  setHeartbeatService(heartbeat);
  let listening = true;
  input.channelGateway.onEvent((event) => {
    if (!listening || event.type !== "message:received" || !event.data) return;
    const channelType = event.channel || "";
    const chatId = String(event.data.chatId || "");
    const messageId = String(event.data.messageId || "");
    const channelDbId = String(event.data.channelId || "");
    const identityParts = [channelType, channelDbId, chatId, messageId];
    const eventId = identityParts.every((part) => part.length > 0 && part.length <= 1024)
      ? `gateway-message-v1:${createHash("sha256")
          .update(JSON.stringify(["gateway-message-v1", ...identityParts]))
          .digest("hex")}`
      : undefined;
    void triggers
      .evaluateEvent({
        source: "channel_message",
        ...(eventId ? { eventId } : {}),
        timestamp: event.timestamp.getTime(),
        fields: {
          channelType,
          channelInstanceId: channelDbId,
          chatId,
          text: String(event.data.text || ""),
          senderName: String(event.data.senderName || ""),
        },
      })
      .catch(input.log);
  });
  const onConnectorEvent = (event: MCPConnectorEvent) => {
    if (!listening) return;
    for (const triggerEvent of connectorTriggerEvents(event))
      void triggers.evaluateEvent(triggerEvent).catch(input.log);
  };
  return {
    heartbeat,
    triggers,
    routines,
    async start() {
      listening = true;
      input.mcpClientManager?.off("connector_event", onConnectorEvent);
      input.mcpClientManager?.on("connector_event", onConnectorEvent);
      setHeartbeatService(heartbeat);
      setHeartbeatSignalEmitter((input) => heartbeat.submitSignalForAll(input));
      // Recover routines before ingress starts draining the persistent trigger queue.
      await runtime.start("routines");
      await runtime.start("event_triggers");
      await mcpEvents?.start();
      await syncSubscriptions().catch(input.log);
      await runtime.start("heartbeat");
    },
    async stop() {
      listening = false;
      input.mcpClientManager?.off("connector_event", onConnectorEvent);
      await mcpEvents?.stop();
      const results = await Promise.allSettled([
        runtime.stop("event_triggers"),
        runtime.stop("heartbeat"),
        runtime.stop("routines"),
      ]);
      setHeartbeatService(null);
      setHeartbeatSignalEmitter(null);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(failures, "Headless bot automation shutdown failed");
    },
  };
}
