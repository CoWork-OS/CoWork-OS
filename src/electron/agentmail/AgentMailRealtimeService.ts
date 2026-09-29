import {
  bindStatementContext,
  detachedStatementContext,
} from "../database/statements/statement-burst";
import WebSocket from "ws";
import { createLogger } from "../utils/logger";
import { AgentMailStatus } from "../../shared/types";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { AgentMailClient } from "./AgentMailClient";
import type { MailboxService } from "../mailbox/MailboxService";
import type { MailboxStatementPort } from "../mailbox/mailbox-statement-port";

const logger = createLogger("AgentMailRealtimeService");

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type RuntimeState = Pick<
  AgentMailStatus,
  "realtimeConnected" | "connectionState" | "lastEventAt" | "error"
>;

export class AgentMailRealtimeService {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private subscribedInboxIds = new Set<string>();
  private runtimeState: RuntimeState = {
    realtimeConnected: false,
    connectionState: "disconnected",
    lastEventAt: undefined,
    error: undefined,
  };

  constructor(
    private readonly sql: MailboxStatementPort,
    private readonly mailboxService: MailboxService,
  ) {}

  async getRuntimeStatus(): Promise<RuntimeState> {
    const row = (await this.sql.get("agentmailRealtime_getRuntimeStatus_1", [])) as
      | {
          connection_state: AgentMailStatus["connectionState"];
          last_event_at: number | null;
          last_error: string | null;
        }
      | undefined;

    if (!row) {
      return this.runtimeState;
    }

    return {
      realtimeConnected: row.connection_state === "connected",
      connectionState: row.connection_state,
      lastEventAt: row.last_event_at || undefined,
      error: row.last_error || undefined,
    };
  }

  /** Updates the in-memory state at once; the stored row follows and never throws. */
  private async persistRuntimeState(next: RuntimeState): Promise<void> {
    this.runtimeState = next;
    try {
      await this.sql.run("agentmailRealtime_persistRuntimeState_1", [
        next.connectionState,
        next.lastEventAt || null,
        next.error || null,
        JSON.stringify(Array.from(this.subscribedInboxIds)),
        Date.now(),
      ]);
    } catch (error) {
      logger.warn("Could not store AgentMail realtime state", error);
    }
  }

  private async loadSubscribedInboxIds(): Promise<string[]> {
    const rows = (await this.sql.all("agentmailRealtime_loadSubscribedInboxIds_1", [])) as Array<{
      inbox_id: string;
    }>;
    return rows.map((row) => row.inbox_id);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      await this.stop();
      return;
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Best effort only.
      }
      this.socket = null;
    }
    this.subscribedInboxIds = new Set();
    await this.persistRuntimeState({
      realtimeConnected: false,
      connectionState: "disconnected",
      lastEventAt: this.runtimeState.lastEventAt,
      error: undefined,
    });
  }

  async refreshSubscriptions(): Promise<void> {
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      await this.stop();
      return;
    }

    const nextIds = await this.loadSubscribedInboxIds();
    this.subscribedInboxIds = new Set(nextIds);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscription(nextIds);
      return;
    }

    await this.start();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        void detachedStatementContext("AgentMailRealtime.reconnect", () => this.connect()).catch(
          (error) => logger.warn("AgentMail realtime reconnect failed", error),
        );
      }
    }, 5000);
  }

  /** One connection attempt at a time: its setup awaits the database before opening. */
  private connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.openConnection().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      await this.stop();
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.subscribedInboxIds = new Set(await this.loadSubscribedInboxIds());
    await this.persistRuntimeState({
      realtimeConnected: false,
      connectionState: "connecting",
      lastEventAt: this.runtimeState.lastEventAt,
      error: undefined,
    });

    // stop() may have run while the state was being stored.
    if (this.stopped) return;
    this.socket = new WebSocket(settings.websocketUrl || "wss://api.agentmail.to/v0/websocket", {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });

    // Socket events are operations of their own, not part of the connection attempt.
    // A socket event's work must not reject unhandled (for example under worker backpressure).
    const detached = (label: string, fn: () => Promise<unknown>): Promise<void> =>
      detachedStatementContext(`AgentMailRealtime.${label}`, fn).then(
        () => undefined,
        (error: unknown) => console.warn(`[AgentMailRealtime] ${label} handler failed:`, error),
      );

    this.socket.on("open", () => {
      void detached("open", () =>
        this.persistRuntimeState({
          realtimeConnected: true,
          connectionState: "connected",
          lastEventAt: this.runtimeState.lastEventAt,
          error: undefined,
        }),
      );
      this.sendSubscription(Array.from(this.subscribedInboxIds));
    });

    this.socket.on("message", (raw) => {
      void detached("message", () => this.handleMessage(raw.toString("utf8")));
    });

    this.socket.on("close", () => {
      this.socket = null;
      void detached("close", () =>
        this.persistRuntimeState({
          realtimeConnected: false,
          connectionState: this.stopped ? "disconnected" : "error",
          lastEventAt: this.runtimeState.lastEventAt,
          error: this.stopped ? undefined : "AgentMail realtime connection closed.",
        }),
      );
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.socket.on("error", (error) => {
      logger.warn("AgentMail realtime socket error", error);
      void detached("error", () =>
        this.persistRuntimeState({
          realtimeConnected: false,
          connectionState: "error",
          lastEventAt: this.runtimeState.lastEventAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  private sendSubscription(inboxIds: string[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        type: "subscribe",
        inboxIds,
        eventTypes: [
          "message.received",
          "message.received.spam",
          "message.received.blocked",
          "message.sent",
          "message.delivered",
          "message.bounced",
          "message.complained",
          "message.rejected",
        ],
      }),
    );
  }

  private async handleMessage(raw: string): Promise<void> {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      logger.warn("Ignoring malformed AgentMail realtime payload");
      return;
    }

    const type = asString(payload.type) || asString(payload.event_type) || asString(payload.event);
    if (!type) {
      return;
    }

    if (type === "subscribed") {
      await this.persistRuntimeState({
        realtimeConnected: true,
        connectionState: "connected",
        lastEventAt: this.runtimeState.lastEventAt,
        error: undefined,
      });
      return;
    }

    if (
      ![
        "message.received",
        "message.received.spam",
        "message.received.blocked",
        "message.sent",
        "message.delivered",
        "message.bounced",
        "message.complained",
        "message.rejected",
        "message_received",
        "message_received_spam",
        "message_received_blocked",
        "message_sent",
        "message_delivered",
        "message_bounced",
        "message_complained",
        "message_rejected",
      ].includes(type)
    ) {
      return;
    }

    const event = asObject(payload.data) || payload;
    const inboxId = asString(event.inbox_id);
    const threadId = asString(event.thread_id);

    if (!inboxId || !threadId) {
      return;
    }

    const inboxRow = (await this.sql.get("agentmailRealtime_handleMessage_1", [inboxId])) as
      | { workspace_id: string; pod_id: string }
      | undefined;
    if (!inboxRow) {
      return;
    }

    try {
      const client = new AgentMailClient(AgentMailSettingsManager.loadSettings());
      const thread = await client.getPodThread(inboxRow.pod_id, threadId);
      await this.mailboxService.ingestAgentMailThread(
        inboxRow.workspace_id,
        inboxRow.pod_id,
        thread,
      );
      await this.persistRuntimeState({
        realtimeConnected: true,
        connectionState: "connected",
        lastEventAt: Date.now(),
        error: undefined,
      });
    } catch (error) {
      logger.warn("Failed to hydrate AgentMail realtime event", error);
      await this.persistRuntimeState({
        realtimeConnected: false,
        connectionState: "error",
        lastEventAt: this.runtimeState.lastEventAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Each call is one mailbox operation for the statement burst gate (DB6).
bindStatementContext(AgentMailRealtimeService.prototype, "AgentMailRealtimeService");
