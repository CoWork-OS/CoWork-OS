import type { BrowserWindow } from "electron";
import type { Message } from "discord.js";
import { ActivityRepository } from "../activity/ActivityRepository";
import type { AgentDaemon } from "../agent/daemon";
import {
  ChannelRepository,
  type Channel,
  WorkspaceRepository,
} from "../database/repositories";
import { SupervisorExchangeRepository } from "./SupervisorExchangeRepository";
import type {
  DiscordSupervisorConfig,
  ResolveSupervisorExchangeRequest,
  SupervisorExchange,
  SupervisorExchangeEvent,
  SupervisorExchangeListQuery,
  SupervisorProtocolIntent,
} from "../../shared/types";
import { IPC_CHANNELS } from "../../shared/types";
import type { IncomingMessage } from "../gateway/channels/types";
import { DiscordAdapter } from "../gateway/channels/discord";
import {
  formatPeerSupervisorMessage,
  getSupervisorMarker,
  parseSupervisorProtocolMessage,
  sanitizeForPrompt,
} from "./protocol";
import { createLogger } from "../utils/logger";

type PendingTaskContext = {
  exchangeId: string;
  adapter: DiscordAdapter;
  channel: Channel;
  peerUserId: string;
  responseMode: "worker" | "supervisor";
  replyToMessageId: string;
};

const logger = createLogger("DiscordSupervisor");
const MALFORMED_COOLDOWN_MS = 30_000;

function truncate(value: string, max = 700): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function buildTaskCompletionSummary(data: {
  resultSummary?: string;
  semanticSummary?: string;
  verificationVerdict?: string;
  verificationReport?: string;
  message?: string;
}): string {
  const resultSummary = typeof data.resultSummary === "string" ? data.resultSummary.trim() : "";
  const semanticSummary = typeof data.semanticSummary === "string" ? data.semanticSummary.trim() : "";
  const verificationVerdict =
    typeof data.verificationVerdict === "string" ? data.verificationVerdict.trim() : "";
  const verificationReport =
    typeof data.verificationReport === "string" ? data.verificationReport.trim() : "";
  const message = typeof data.message === "string" ? data.message.trim() : "";

  const summary = [resultSummary, semanticSummary].filter((value) => value.length > 0).join("\n\n");
  const verification =
    verificationVerdict || verificationReport
      ? [
          verificationVerdict ? `Verification: ${verificationVerdict}` : "",
          verificationReport || "",
        ]
          .filter((value) => value.length > 0)
          .join("\n")
      : "";
  return [summary, verification, message].filter((value) => value.length > 0).join("\n\n");
}

function stripProtocolEnvelope(text: string): string {
  return text
    .replace(/<@!?\d+>\s*/g, "")
    .replace(/\[(CW_[A-Z_]+)\]\s*/g, "")
    .replace(/\[CW_EXCHANGE:[0-9a-fA-F-]{36}\]\s*/g, "")
    .trim();
}

function buildWorkerPrompt(peerUserId: string, incomingText: string, exchangeId: string): string {
  return [
    "You are the worker side of the CoWork Discord supervisor protocol.",
    "",
    "Rules:",
    `- Reply with exactly one Discord message mentioning <@${peerUserId}>.`,
    `- The message must contain exactly one marker: ${getSupervisorMarker("review_request")}.`,
    `- Include this exact exchange token once: [CW_EXCHANGE:${exchangeId}].`,
    "- Do not use any other supervisor marker.",
    "- Keep the message concise and operational.",
    "- Do not add code fences, prose before the marker, or multiple messages.",
    "",
    "Incoming request:",
    sanitizeForPrompt(incomingText),
    "",
    "Return only the final Discord message.",
  ].join("\n");
}

function buildSupervisorPrompt(
  peerUserId: string,
  incomingText: string,
  exchange: SupervisorExchange,
): string {
  const evidence = (exchange.evidenceRefs || [])
    .map((ref, index) => `${index + 1}. channel=${ref.channelId} message=${ref.messageId}${ref.summary ? ` — ${ref.summary}` : ""}`)
    .join("\n");

  return [
    "You are the supervisor side of the CoWork Discord supervisor protocol.",
    "",
    "Rules:",
    `- If the worker output looks clean, reply with exactly one Discord message mentioning <@${peerUserId}> and marker ${getSupervisorMarker("ack")}.`,
    `- Include this exact exchange token once: [CW_EXCHANGE:${exchange.id}].`,
    `- If human judgment is required, reply with exactly one message that starts with ${getSupervisorMarker("escalation_notice")}.`,
    "- Do not use any other supervisor marker.",
    "- Do not generate the primary work product yourself.",
    "- No code fences. No extra explanation outside the final message.",
    "",
    evidence ? `Evidence refs:\n${evidence}\n` : "",
    "Worker review message:",
    sanitizeForPrompt(incomingText),
    "",
    "Return only the final Discord message.",
  ].join("\n");
}

export class DiscordSupervisorService {
  private exchangeRepo;
  private workspaceRepo;
  private channelRepo;
  private activityRepo;
  private activeDiscordAdapter: DiscordAdapter | null = null;
  private pendingTasks = new Map<string, PendingTaskContext>();
  private latestTaskMessages = new Map<string, string>();
  private malformedCooldown = new Map<string, number>();

  constructor(
    private db: import("better-sqlite3").Database,
    private agentDaemon: AgentDaemon,
    private getMainWindow: () => BrowserWindow | null,
    private getDiscordAdapter?: () => DiscordAdapter | undefined,
  ) {
    this.exchangeRepo = new SupervisorExchangeRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.channelRepo = new ChannelRepository(db);
    this.activityRepo = new ActivityRepository(db);
    this.agentDaemon.on("assistant_message", (data: { taskId: string; message?: string }) => {
      if (!this.pendingTasks.has(data.taskId)) return;
      const text = typeof data.message === "string" ? data.message.trim() : "";
      if (text) this.latestTaskMessages.set(data.taskId, text);
    });
    this.agentDaemon.on(
      "task_completed",
      async (data: {
        taskId: string;
        resultSummary?: string;
        semanticSummary?: string;
        verificationVerdict?: string;
        verificationReport?: string;
        message?: string;
      }) => {
        await this.handleTaskCompleted(data);
      },
    );
    this.agentDaemon.on("error", async (data: { taskId?: string; error?: string; message?: string }) => {
      if (!data?.taskId) return;
      await this.handleTaskFailed(data.taskId, data.error || data.message || "Unknown error");
    });
  }

  listExchanges(query: SupervisorExchangeListQuery) {
    return this.exchangeRepo.list(query);
  }

  async resolveExchange(request: ResolveSupervisorExchangeRequest): Promise<SupervisorExchange> {
    const existing = this.exchangeRepo.findById(request.id);
    if (!existing) {
      throw new Error("Supervisor exchange not found");
    }
    if (existing.status !== "escalated") {
      throw new Error("Only escalated supervisor exchanges can be resolved");
    }

    const mirrorTarget = request.mirrorToDiscord ? this.getDiscordMirrorTarget(existing) : undefined;
    const next = this.exchangeRepo.update(existing.id, {
      status: "closed",
      humanResolution: request.resolution.trim(),
      terminalReason: existing.terminalReason || "human_resolved",
      closedAt: Date.now(),
    });
    if (!next) {
      throw new Error("Failed to update supervisor exchange");
    }

    this.emitSupervisorEvent("resolved", next);
    this.createActivity(next, "Supervisor exchange resolved", request.resolution.trim(), {
      exchangeId: next.id,
      exchangeStatus: next.status,
    });

    if (request.mirrorToDiscord) {
      await this.mirrorResolutionToDiscord(next, mirrorTarget);
    }

    return next;
  }

  async handleIncomingDiscordMessage(adapter: DiscordAdapter, message: IncomingMessage): Promise<void> {
    this.activeDiscordAdapter = adapter;
    const channel = this.channelRepo.findByType("discord");
    if (!channel) return;
    const config = this.getSupervisorConfig(channel);
    if (!config?.enabled) return;

    const raw = message.raw as Message | undefined;
    const authorUserId = raw?.author?.id || message.userId;
    if (!authorUserId || !(config.peerBotUserIds || []).includes(authorUserId)) {
      return;
    }

    const channelId = raw?.channelId || message.threadId || message.chatId;
    if (!channelId) return;

    if (channelId === config.coordinationChannelId) {
      await this.handleCoordinationMessage(adapter, channel, config, message, authorUserId, channelId);
      return;
    }

    if ((config.watchedChannelIds || []).includes(channelId)) {
      await this.handleWatchedOutput(adapter, channel, config, message, authorUserId, channelId);
    }
  }

  private getSupervisorConfig(channel: Channel): DiscordSupervisorConfig | null {
    const supervisor = (channel.config?.supervisor || null) as DiscordSupervisorConfig | null;
    if (!supervisor?.enabled || !supervisor.coordinationChannelId) return null;
    return {
      ...supervisor,
      watchedChannelIds: supervisor.watchedChannelIds || [],
      peerBotUserIds: supervisor.peerBotUserIds || [],
      strictMode: supervisor.strictMode !== false,
    };
  }

  private resolveWorkspaceId(channel: Channel): string | null {
    const configuredId =
      typeof channel.config?.defaultWorkspaceId === "string" ? channel.config.defaultWorkspaceId : null;
    if (configuredId && this.workspaceRepo.findById(configuredId)) {
      return configuredId;
    }
    return this.workspaceRepo.findAll()[0]?.id || null;
  }

  private async handleWatchedOutput(
    adapter: DiscordAdapter,
    channel: Channel,
    config: DiscordSupervisorConfig,
    message: IncomingMessage,
    peerUserId: string,
    sourceChannelId: string,
  ): Promise<void> {
    if (this.exchangeRepo.findBySourceMessageId(message.messageId)) {
      return;
    }
    const workspaceId = this.resolveWorkspaceId(channel);
    if (!workspaceId) return;

    const exchange = this.exchangeRepo.create({
      workspaceId,
      coordinationChannelId: config.coordinationChannelId!,
      sourceChannelId,
      sourceMessageId: message.messageId,
      sourcePeerUserId: peerUserId,
      workerAgentRoleId: config.workerAgentRoleId,
      supervisorAgentRoleId: config.supervisorAgentRoleId,
      escalationTarget: config.humanEscalationChannelId || config.humanEscalationUserId,
      evidenceRefs: [
        {
          channelId: sourceChannelId,
          messageId: message.messageId,
          summary: truncate(message.text, 220),
          capturedAt: Date.now(),
        },
      ],
    });

    this.emitSupervisorEvent("created", exchange);
    this.createActivity(exchange, "Supervisor exchange opened", truncate(message.text, 220), {
      exchangeId: exchange.id,
      exchangeStatus: exchange.status,
      sourceChannelId,
      sourceMessageId: message.messageId,
    });

    const outboundText = formatPeerSupervisorMessage(
      peerUserId,
      "status_request",
      `Review your latest output from <#${sourceChannelId}> and respond once with ${getSupervisorMarker("review_request")}. Keep the same CW_EXCHANGE token in your reply.`,
      { exchangeId: exchange.id },
    );
    const sentId = await adapter.sendMessage({
      chatId: config.coordinationChannelId!,
      text: outboundText,
      parseMode: "markdown",
    });

    this.exchangeRepo.addMessage({
      exchangeId: exchange.id,
      discordMessageId: sentId,
      channelId: config.coordinationChannelId!,
      authorUserId: undefined,
      actorKind: "supervisor",
      intent: "status_request",
      rawContent: outboundText,
    });
    const updated = this.exchangeRepo.update(exchange.id, {
      lastIntent: "status_request",
      turnCount: 1,
    });
    if (updated) {
      this.emitSupervisorEvent("updated", updated);
    }
  }

  private async handleCoordinationMessage(
    adapter: DiscordAdapter,
    channel: Channel,
    config: DiscordSupervisorConfig,
    message: IncomingMessage,
    peerUserId: string,
    channelId: string,
  ): Promise<void> {
    const parsed = parseSupervisorProtocolMessage(message.text, config);
    if (!parsed) {
      this.recordMalformedMessage(peerUserId, channelId, message.text);
      return;
    }

    const exchangeByReply = message.replyTo
      ? this.exchangeRepo.findByDiscordMessageId(message.replyTo)
      : undefined;
    const exchangeByToken = parsed.exchangeId
      ? this.exchangeRepo.findById(parsed.exchangeId)
      : undefined;
    if (exchangeByReply && exchangeByToken && exchangeByReply.id !== exchangeByToken.id) {
      this.recordMalformedMessage(peerUserId, channelId, message.text);
      return;
    }

    let exchange = exchangeByReply || exchangeByToken;
    if (exchange) {
      if (
        exchange.status !== "open" ||
        exchange.coordinationChannelId !== channelId ||
        exchange.sourcePeerUserId !== peerUserId
      ) {
        this.recordMalformedMessage(peerUserId, channelId, message.text);
        return;
      }
    } else {
      const workspaceId = this.resolveWorkspaceId(channel);
      if (!workspaceId) return;

      const openCandidates = this.exchangeRepo
        .list({
          workspaceId,
          status: "open",
          limit: 50,
        })
        .filter(
          (item) => item.coordinationChannelId === channelId && item.sourcePeerUserId === peerUserId,
        );

      if (openCandidates.length === 1) {
        exchange = openCandidates[0];
      } else if (openCandidates.length > 1 || parsed.intent !== "status_request") {
        this.recordMalformedMessage(peerUserId, channelId, message.text);
        return;
      } else {
        exchange = this.exchangeRepo.create({
          workspaceId,
          coordinationChannelId: channelId,
          sourcePeerUserId: peerUserId,
          workerAgentRoleId: config.workerAgentRoleId,
          supervisorAgentRoleId: config.supervisorAgentRoleId,
          escalationTarget: config.humanEscalationChannelId || config.humanEscalationUserId,
        });
        this.emitSupervisorEvent("created", exchange);
      }
    }

    const storedMessage = this.exchangeRepo.addMessage({
      exchangeId: exchange.id,
      discordMessageId: message.messageId,
      channelId,
      authorUserId: peerUserId,
      actorKind: "peer",
      intent: parsed.intent,
      rawContent: message.text,
    });
    if (!storedMessage) return;

    const messageCount = this.exchangeRepo.listMessages(exchange.id).length;
    exchange = this.exchangeRepo.update(exchange.id, {
      lastIntent: parsed.intent,
      turnCount: messageCount,
    }) || exchange;
    this.emitSupervisorEvent("updated", exchange);

    if (messageCount > 3) {
      const closed = this.exchangeRepo.update(exchange.id, {
        status: "closed",
        terminalReason: "max_turns_exceeded",
        closedAt: Date.now(),
      });
      if (closed) {
        this.emitSupervisorEvent("updated", closed);
        this.createActivity(closed, "Supervisor exchange closed", "Maximum exchange depth reached.", {
          exchangeId: closed.id,
          exchangeStatus: closed.status,
        });
      }
      return;
    }

    if (parsed.intent === "ack") {
      const closed = this.exchangeRepo.update(exchange.id, {
        status: "acknowledged",
        terminalReason: "peer_acknowledged",
        closedAt: Date.now(),
      });
      if (closed) {
        this.emitSupervisorEvent("updated", closed);
        this.createActivity(closed, "Supervisor exchange acknowledged", stripProtocolEnvelope(message.text), {
          exchangeId: closed.id,
          exchangeStatus: closed.status,
        });
      }
      return;
    }

    if (parsed.intent === "escalation_notice") {
      const escalated = this.exchangeRepo.update(exchange.id, {
        status: "escalated",
        terminalReason: "peer_escalated",
        closedAt: Date.now(),
      });
      if (escalated) {
        this.emitSupervisorEvent("updated", escalated);
        this.createActivity(escalated, "Peer escalated supervisor exchange", stripProtocolEnvelope(message.text), {
          exchangeId: escalated.id,
          exchangeStatus: escalated.status,
        });
      }
      return;
    }

    if (parsed.intent === "status_request") {
      await this.startProtocolTask(adapter, channel, exchange, peerUserId, "worker", message.messageId);
      return;
    }

    if (parsed.intent === "review_request") {
      await this.startProtocolTask(adapter, channel, exchange, peerUserId, "supervisor", message.messageId);
    }
  }

  private async startProtocolTask(
    adapter: DiscordAdapter,
    channel: Channel,
    exchange: SupervisorExchange,
    peerUserId: string,
    responseMode: "worker" | "supervisor",
    replyToMessageId: string,
  ): Promise<void> {
    const workspaceId = exchange.workspaceId || this.resolveWorkspaceId(channel);
    if (!workspaceId) return;

    const roleId =
      responseMode === "worker" ? exchange.workerAgentRoleId : exchange.supervisorAgentRoleId;
    if (!roleId) {
      await this.handleTaskFailed(
        "",
        `Missing ${responseMode} agent role for Discord supervisor protocol.`,
        exchange,
        adapter,
      );
      return;
    }

    const messages = this.exchangeRepo.listMessages(exchange.id);
    const latestPeerMessage = [...messages].reverse().find((item) => item.actorKind === "peer");
    const sourceSummary = exchange.evidenceRefs?.[0]?.summary || "";
    const prompt =
      responseMode === "worker"
        ? buildWorkerPrompt(peerUserId, latestPeerMessage?.rawContent || sourceSummary, exchange.id)
        : buildSupervisorPrompt(peerUserId, latestPeerMessage?.rawContent || sourceSummary, exchange);

    const task = await this.agentDaemon.createTask({
      title:
        responseMode === "worker"
          ? "Discord supervisor worker response"
          : "Discord supervisor review",
      prompt,
      workspaceId,
      agentConfig: {
        allowUserInput: false,
        gatewayContext: "private",
      },
      taskOverrides: {
        assignedAgentRoleId: roleId,
      },
    });

    this.pendingTasks.set(task.id, {
      exchangeId: exchange.id,
      adapter,
      channel,
      peerUserId,
      responseMode,
      replyToMessageId,
    });

    const updated = this.exchangeRepo.update(exchange.id, { linkedTaskId: task.id });
    if (updated) {
      this.emitSupervisorEvent("updated", updated);
    }
  }

  private async handleTaskCompleted(data: {
    taskId: string;
    resultSummary?: string;
    semanticSummary?: string;
    verificationVerdict?: string;
    verificationReport?: string;
    message?: string;
  }): Promise<void> {
    const context = this.pendingTasks.get(data.taskId);
    if (!context) return;
    this.pendingTasks.delete(data.taskId);
    const exchange = this.exchangeRepo.findById(context.exchangeId);
    if (!exchange) return;

    const rawOutput = buildTaskCompletionSummary({
      resultSummary: this.latestTaskMessages.get(data.taskId) || data.resultSummary,
      semanticSummary: data.semanticSummary,
      verificationVerdict: data.verificationVerdict,
      verificationReport: data.verificationReport,
      message: data.message,
    });
    this.latestTaskMessages.delete(data.taskId);

    if (context.responseMode === "worker") {
      const parsed = parseSupervisorProtocolMessage(rawOutput, {
        peerBotUserIds: [context.peerUserId],
        strictMode: false,
      });
      const outboundText =
        formatPeerSupervisorMessage(
          context.peerUserId,
          "review_request",
          stripProtocolEnvelope(rawOutput) || "Status reviewed. Requesting supervisor review.",
          { exchangeId: exchange.id },
        );
      const sentId = await context.adapter.sendMessage({
        chatId: exchange.coordinationChannelId,
        text: outboundText,
        replyTo: context.replyToMessageId,
        parseMode: "markdown",
      });
      this.exchangeRepo.addMessage({
        exchangeId: exchange.id,
        discordMessageId: sentId,
        channelId: exchange.coordinationChannelId,
        actorKind: "worker",
        intent: "review_request",
        rawContent: outboundText,
      });
      const updated = this.exchangeRepo.update(exchange.id, {
        lastIntent: "review_request",
        turnCount: this.exchangeRepo.listMessages(exchange.id).length,
      });
      if (updated) {
        this.emitSupervisorEvent("updated", updated);
      }
      this.createActivity(exchange, "Worker responded to supervisor exchange", stripProtocolEnvelope(outboundText), {
        exchangeId: exchange.id,
        exchangeStatus: updated?.status || exchange.status,
        taskId: data.taskId,
      });
      return;
    }

    const parsed = parseSupervisorProtocolMessage(rawOutput, {
      peerBotUserIds: [context.peerUserId],
      strictMode: false,
    });
    if (parsed?.intent === "ack") {
      const outboundText = formatPeerSupervisorMessage(
        context.peerUserId,
        "ack",
        stripProtocolEnvelope(rawOutput),
        { exchangeId: exchange.id },
      );
      const sentId = await context.adapter.sendMessage({
        chatId: exchange.coordinationChannelId,
        text: outboundText,
        replyTo: context.replyToMessageId,
        parseMode: "markdown",
      });
      this.exchangeRepo.addMessage({
        exchangeId: exchange.id,
        discordMessageId: sentId,
        channelId: exchange.coordinationChannelId,
        actorKind: "supervisor",
        intent: "ack",
        rawContent: outboundText,
      });
      const closed = this.exchangeRepo.update(exchange.id, {
        status: "acknowledged",
        lastIntent: "ack",
        turnCount: this.exchangeRepo.listMessages(exchange.id).length,
        terminalReason: "supervisor_ack",
        closedAt: Date.now(),
      });
      if (closed) {
        this.emitSupervisorEvent("updated", closed);
        this.createActivity(closed, "Supervisor exchange acknowledged", stripProtocolEnvelope(outboundText), {
          exchangeId: closed.id,
          exchangeStatus: closed.status,
        });
      }
      return;
    }

    const escalationBody =
      stripProtocolEnvelope(rawOutput) || "Supervisor review required human judgment.";
    await this.sendHumanEscalation(context.adapter, context.channel, exchange, escalationBody);
  }

  private async handleTaskFailed(
    taskId: string,
    error: string,
    existingExchange?: SupervisorExchange,
    existingAdapter?: DiscordAdapter,
  ): Promise<void> {
    const context = taskId ? this.pendingTasks.get(taskId) : undefined;
    if (taskId) {
      this.pendingTasks.delete(taskId);
      this.latestTaskMessages.delete(taskId);
    }
    const exchange =
      existingExchange || (context ? this.exchangeRepo.findById(context.exchangeId) : undefined);
    const adapter = existingAdapter || context?.adapter;
    const channel = context?.channel;
    if (!exchange || !adapter || !channel) return;

    await this.sendHumanEscalation(adapter, channel, exchange, `Protocol task failed: ${error}`);
  }

  private async sendHumanEscalation(
    adapter: DiscordAdapter,
    channel: Channel,
    exchange: SupervisorExchange,
    body: string,
  ): Promise<void> {
    const config = this.getSupervisorConfig(channel);
    if (!config) return;

    const messageText = `${getSupervisorMarker("escalation_notice")}\n${body.trim()}`;
    let targetChannelId = config.humanEscalationChannelId || exchange.coordinationChannelId;
    if (config.humanEscalationUserId) {
      try {
        const directMessageId = await adapter.sendDirectMessageToUser(
          config.humanEscalationUserId,
          messageText,
        );
        targetChannelId = `dm:${config.humanEscalationUserId}`;
        this.exchangeRepo.addMessage({
          exchangeId: exchange.id,
          discordMessageId: directMessageId,
          channelId: targetChannelId,
          actorKind: "human",
          intent: "escalation_notice",
          rawContent: messageText,
        });
      } catch (error) {
        logger.warn("Failed to DM escalation target, falling back to channel post", error);
        const fallbackText = `<@${config.humanEscalationUserId}> ${messageText}`;
        const fallbackId = await adapter.sendMessage({
          chatId: targetChannelId,
          text: fallbackText,
          parseMode: "markdown",
        });
        this.exchangeRepo.addMessage({
          exchangeId: exchange.id,
          discordMessageId: fallbackId,
          channelId: targetChannelId,
          actorKind: "human",
          intent: "escalation_notice",
          rawContent: fallbackText,
        });
      }
    } else {
      const sentId = await adapter.sendMessage({
        chatId: targetChannelId,
        text: messageText,
        parseMode: "markdown",
      });
      this.exchangeRepo.addMessage({
        exchangeId: exchange.id,
        discordMessageId: sentId,
        channelId: targetChannelId,
        actorKind: "human",
        intent: "escalation_notice",
        rawContent: messageText,
      });
    }

    const escalated = this.exchangeRepo.update(exchange.id, {
      status: "escalated",
      lastIntent: "escalation_notice",
      turnCount: this.exchangeRepo.listMessages(exchange.id).length,
      terminalReason: "human_escalation",
      closedAt: Date.now(),
      escalationTarget: config.humanEscalationChannelId || config.humanEscalationUserId,
    });
    if (escalated) {
      this.emitSupervisorEvent("updated", escalated);
      this.createActivity(escalated, "Supervisor exchange escalated", body, {
        exchangeId: escalated.id,
        exchangeStatus: escalated.status,
        escalationTarget: escalated.escalationTarget,
      });
    }
  }

  private requireDiscordMirrorAdapter(): DiscordAdapter {
    const adapter = this.activeDiscordAdapter || this.getDiscordAdapter?.();
    if (!adapter) {
      throw new Error("Discord mirror delivery is unavailable because no Discord adapter is active");
    }
    return adapter;
  }

  private getDiscordMirrorTarget(exchange: SupervisorExchange): {
    adapter: DiscordAdapter;
    targetChannelId: string;
    directUserId?: string;
  } {
    const adapter = this.requireDiscordMirrorAdapter();
    const channel = this.channelRepo.findByType("discord");
    if (!channel) {
      throw new Error("Discord channel not found for supervisor resolution mirroring");
    }
    const config = this.getSupervisorConfig(channel);
    if (!config) {
      throw new Error("Discord supervisor mode is not configured for resolution mirroring");
    }

    return {
      adapter,
      directUserId:
        config.humanEscalationUserId && !config.humanEscalationChannelId
          ? config.humanEscalationUserId
          : undefined,
      targetChannelId: config.humanEscalationChannelId || exchange.coordinationChannelId,
    };
  }

  private async mirrorResolutionToDiscord(
    exchange: SupervisorExchange,
    target = this.getDiscordMirrorTarget(exchange),
  ): Promise<void> {
    const resolutionText = `Supervisor resolution recorded:\n${exchange.humanResolution || "(no resolution text)"}`;
    if (target.directUserId) {
      await target.adapter.sendDirectMessageToUser(target.directUserId, resolutionText);
      return;
    }
    await target.adapter.sendMessage({
      chatId: target.targetChannelId,
      text: resolutionText,
      parseMode: "markdown",
    });
  }

  private createActivity(
    exchange: SupervisorExchange,
    title: string,
    description: string,
    metadata: Record<string, unknown>,
  ): void {
    const activity = this.activityRepo.create({
      workspaceId: exchange.workspaceId,
      taskId: exchange.linkedTaskId,
      agentRoleId: exchange.supervisorAgentRoleId || exchange.workerAgentRoleId,
      actorType: "agent",
      activityType: "supervisor_exchange",
      title,
      description,
      metadata,
    });
    this.emitActivityEvent(activity);
  }

  private emitActivityEvent(activity: import("../../shared/types").Activity): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "created", activity });
  }

  private emitSupervisorEvent(
    type: SupervisorExchangeEvent["type"],
    exchange: SupervisorExchange,
  ): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(IPC_CHANNELS.SUPERVISOR_EXCHANGE_EVENT, { type, exchange });
  }

  private recordMalformedMessage(peerUserId: string, channelId: string, text: string): void {
    const key = `${peerUserId}:${channelId}`;
    const now = Date.now();
    const existing = this.malformedCooldown.get(key) || 0;
    if (existing > now) return;
    this.malformedCooldown.set(key, now + MALFORMED_COOLDOWN_MS);
    logger.debug("Ignoring malformed supervisor protocol message", {
      peerUserId,
      channelId,
      preview: truncate(text, 140),
    });
  }
}
