import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type {
  SupervisorExchange,
  SupervisorExchangeMessage,
  Workspace,
} from "../../../shared/types";
import type { Channel } from "../../database/repositories";
import { DiscordSupervisorService } from "../DiscordSupervisorService";

class FakeAgentDaemon extends EventEmitter {
  async createTask(): Promise<{ id: string }> {
    return { id: "task-1" };
  }
}

function createWorkspace(id = "workspace-1"): Workspace {
  return {
    id,
    name: "Test",
    path: "/tmp/test",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    },
  };
}

function createDiscordChannel(): Channel {
  return {
    id: "channel-1",
    type: "discord",
    name: "Discord",
    enabled: true,
    config: {
      supervisor: {
        enabled: true,
        coordinationChannelId: "999",
        peerBotUserIds: ["111"],
        workerAgentRoleId: "550e8400-e29b-41d4-a716-446655440000",
        supervisorAgentRoleId: "550e8400-e29b-41d4-a716-446655440001",
        humanEscalationChannelId: "444",
      },
    },
    securityConfig: { mode: "pairing" },
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createExchange(overrides: Partial<SupervisorExchange> = {}): SupervisorExchange {
  const now = Date.now();
  return {
    id: overrides.id || `exchange-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: overrides.workspaceId || "workspace-1",
    coordinationChannelId: overrides.coordinationChannelId || "999",
    sourceChannelId: overrides.sourceChannelId,
    sourceMessageId: overrides.sourceMessageId,
    sourcePeerUserId: overrides.sourcePeerUserId || "111",
    workerAgentRoleId: overrides.workerAgentRoleId || "550e8400-e29b-41d4-a716-446655440000",
    supervisorAgentRoleId:
      overrides.supervisorAgentRoleId || "550e8400-e29b-41d4-a716-446655440001",
    linkedTaskId: overrides.linkedTaskId,
    escalationTarget: overrides.escalationTarget,
    status: overrides.status || "open",
    lastIntent: overrides.lastIntent,
    turnCount: overrides.turnCount ?? 0,
    terminalReason: overrides.terminalReason,
    evidenceRefs: overrides.evidenceRefs,
    humanResolution: overrides.humanResolution,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    closedAt: overrides.closedAt,
  };
}

function createService(overrides?: {
  workspace?: Workspace;
  channel?: Channel;
  exchanges?: SupervisorExchange[];
  messages?: SupervisorExchangeMessage[];
}) {
  const workspace = overrides?.workspace || createWorkspace();
  const channel = overrides?.channel || createDiscordChannel();
  const exchanges = new Map(
    (overrides?.exchanges || []).map((exchange) => [exchange.id, { ...exchange }]),
  );
  const messages = new Map(
    (overrides?.messages || []).map((message) => [message.id, { ...message }]),
  );
  const events: Array<{ channel: string; payload: unknown }> = [];

  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channelName: string, payload: unknown) => {
        events.push({ channel: channelName, payload });
      },
    },
  } as unknown as BrowserWindow;

  const service = new DiscordSupervisorService(
    {} as Any,
    new FakeAgentDaemon() as Any,
    () => mainWindow,
  );

  (service as Any).workspaceRepo = {
    findById: (id: string) => (id === workspace.id ? workspace : undefined),
    findAll: () => [workspace],
  };
  (service as Any).channelRepo = {
    findByType: (type: string) => (type === "discord" ? channel : undefined),
  };
  (service as Any).activityRepo = {
    create: (request: Record<string, unknown>) => ({
      id: `activity-${events.length + 1}`,
      ...request,
      isRead: false,
      isPinned: false,
      createdAt: Date.now(),
    }),
  };
  (service as Any).exchangeRepo = {
    create: (request: Partial<SupervisorExchange>) => {
      const exchange = createExchange(request);
      exchanges.set(exchange.id, exchange);
      return exchange;
    },
    update: (id: string, updates: Partial<SupervisorExchange>) => {
      const existing = exchanges.get(id);
      if (!existing) return undefined;
      const next = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      exchanges.set(id, next);
      return next;
    },
    findById: (id: string) => exchanges.get(id),
    findBySourceMessageId: (sourceMessageId: string) =>
      Array.from(exchanges.values()).find(
        (exchange) => exchange.sourceMessageId === sourceMessageId,
      ),
    findByDiscordMessageId: (discordMessageId: string) => {
      const message = Array.from(messages.values()).find(
        (entry) => entry.discordMessageId === discordMessageId,
      );
      return message ? exchanges.get(message.exchangeId) : undefined;
    },
    list: (query: { workspaceId: string; status?: string | string[]; limit?: number }) => {
      const requestedStatuses = Array.isArray(query.status)
        ? query.status
        : query.status
          ? [query.status]
          : null;
      const results = Array.from(exchanges.values()).filter((exchange) => {
        if (exchange.workspaceId !== query.workspaceId) return false;
        if (requestedStatuses && !requestedStatuses.includes(exchange.status)) return false;
        return true;
      });
      return query.limit ? results.slice(0, query.limit) : results;
    },
    addMessage: (request: Omit<SupervisorExchangeMessage, "id" | "createdAt">) => {
      const duplicate = Array.from(messages.values()).find(
        (message) => message.discordMessageId === request.discordMessageId,
      );
      if (duplicate) return null;
      const message = {
        id: `message-${messages.size + 1}`,
        createdAt: Date.now(),
        ...request,
      };
      messages.set(message.id, message);
      return message;
    },
    listMessages: (exchangeId: string) =>
      Array.from(messages.values()).filter((message) => message.exchangeId === exchangeId),
  };

  return {
    service,
    exchanges,
    messages,
    events,
  };
}

describe("DiscordSupervisorService", () => {
  it("ignores ambiguous unthreaded peer replies when multiple exchanges are open", async () => {
    const first = createExchange({ id: "exchange-1" });
    const second = createExchange({ id: "exchange-2" });
    const { service, exchanges } = createService({
      exchanges: [first, second],
    });

    await service.handleIncomingDiscordMessage({} as Any, {
      messageId: "peer-msg-1",
      channel: "discord",
      userId: "111",
      userName: "Peer",
      chatId: "999",
      text: "<@111> [CW_ACK]\nLooks good.",
      timestamp: new Date(),
      raw: {
        author: { id: "111" },
        channelId: "999",
      },
    });

    expect(exchanges.get(first.id)?.status).toBe("open");
    expect(exchanges.get(second.id)?.status).toBe("open");
  });

  it("only resolves escalated exchanges once", async () => {
    const exchange = createExchange({
      id: "exchange-1",
      status: "escalated",
    });
    const { service, exchanges } = createService({
      exchanges: [exchange],
    });

    await expect(
      service.resolveExchange({ id: exchange.id, resolution: "Handled by operator." }),
    ).resolves.toMatchObject({
      id: exchange.id,
      status: "closed",
      humanResolution: "Handled by operator.",
    });

    await expect(
      service.resolveExchange({ id: exchange.id, resolution: "Second resolution." }),
    ).rejects.toThrow("Only escalated supervisor exchanges can be resolved");

    expect(exchanges.get(exchange.id)?.status).toBe("closed");
  });

  it("rejects mirrored resolution requests when no Discord adapter is available", async () => {
    const exchange = createExchange({
      id: "exchange-1",
      status: "escalated",
    });
    const { service, exchanges } = createService({
      exchanges: [exchange],
    });

    await expect(
      service.resolveExchange({
        id: exchange.id,
        resolution: "Handled by operator.",
        mirrorToDiscord: true,
      }),
    ).rejects.toThrow(
      "Discord mirror delivery is unavailable because no Discord adapter is active",
    );

    expect(exchanges.get(exchange.id)?.status).toBe("escalated");
  });
});
