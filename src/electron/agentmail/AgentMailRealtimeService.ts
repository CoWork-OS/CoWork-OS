import Database from "better-sqlite3";
import WebSocket from "ws";
import { createLogger } from "../utils/logger";
import { AgentMailStatus } from "../../shared/types";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { AgentMailClient } from "./AgentMailClient";
import type { MailboxService } from "../mailbox/MailboxService";

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
  private subscribedInboxIds = new Set<string>();
  private runtimeState: RuntimeState = {
    realtimeConnected: false,
    connectionState: "disconnected",
    lastEventAt: undefined,
    error: undefined,
  };

  constructor(
    private readonly db: Database.Database,
    private readonly mailboxService: MailboxService,
  ) {}

  getRuntimeStatus(): RuntimeState {
    const row = this.db
      .prepare(
        `SELECT connection_state, last_event_at, last_error
         FROM agentmail_realtime_state
         WHERE id = 'global'`,
      )
      .get() as
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

  private persistRuntimeState(next: RuntimeState): void {
    this.runtimeState = next;
    this.db
      .prepare(
        `INSERT INTO agentmail_realtime_state
          (id, connection_state, last_event_at, last_error, subscribed_inboxes_json, updated_at)
         VALUES ('global', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           connection_state = excluded.connection_state,
           last_event_at = excluded.last_event_at,
           last_error = excluded.last_error,
           subscribed_inboxes_json = excluded.subscribed_inboxes_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.connectionState,
        next.lastEventAt || null,
        next.error || null,
        JSON.stringify(Array.from(this.subscribedInboxIds)),
        Date.now(),
      );
  }

  private loadSubscribedInboxIds(): string[] {
    const rows = this.db
      .prepare("SELECT inbox_id FROM agentmail_inboxes ORDER BY inbox_id")
      .all() as Array<{ inbox_id: string }>;
    return rows.map((row) => row.inbox_id);
  }

  start(): void {
    this.stopped = false;
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      this.stop();
      return;
    }
    this.connect();
  }

  stop(): void {
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
    this.persistRuntimeState({
      realtimeConnected: false,
      connectionState: "disconnected",
      lastEventAt: this.runtimeState.lastEventAt,
      error: undefined,
    });
  }

  refreshSubscriptions(): void {
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      this.stop();
      return;
    }

    const nextIds = this.loadSubscribedInboxIds();
    this.subscribedInboxIds = new Set(nextIds);

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscription(nextIds);
      return;
    }

    this.start();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.connect();
      }
    }, 5000);
  }

  private connect(): void {
    const settings = AgentMailSettingsManager.loadSettings();
    if (!settings.enabled || !settings.apiKey || !settings.realtimeEnabled) {
      this.stop();
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.subscribedInboxIds = new Set(this.loadSubscribedInboxIds());
    this.persistRuntimeState({
      realtimeConnected: false,
      connectionState: "connecting",
      lastEventAt: this.runtimeState.lastEventAt,
      error: undefined,
    });

    this.socket = new WebSocket(settings.websocketUrl || "wss://api.agentmail.to/v0/websocket", {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
    });

    this.socket.on("open", () => {
      this.persistRuntimeState({
        realtimeConnected: true,
        connectionState: "connected",
        lastEventAt: this.runtimeState.lastEventAt,
        error: undefined,
      });
      this.sendSubscription(Array.from(this.subscribedInboxIds));
    });

    this.socket.on("message", (raw) => {
      void this.handleMessage(raw.toString("utf8"));
    });

    this.socket.on("close", () => {
      this.socket = null;
      this.persistRuntimeState({
        realtimeConnected: false,
        connectionState: this.stopped ? "disconnected" : "error",
        lastEventAt: this.runtimeState.lastEventAt,
        error: this.stopped ? undefined : "AgentMail realtime connection closed.",
      });
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.socket.on("error", (error) => {
      logger.warn("AgentMail realtime socket error", error);
      this.persistRuntimeState({
        realtimeConnected: false,
        connectionState: "error",
        lastEventAt: this.runtimeState.lastEventAt,
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.persistRuntimeState({
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

    const inboxRow = this.db
      .prepare(
        `SELECT workspace_id, pod_id
         FROM agentmail_inboxes
         WHERE inbox_id = ?
         LIMIT 1`,
      )
      .get(inboxId) as { workspace_id: string; pod_id: string } | undefined;
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
      this.persistRuntimeState({
        realtimeConnected: true,
        connectionState: "connected",
        lastEventAt: Date.now(),
        error: undefined,
      });
    } catch (error) {
      logger.warn("Failed to hydrate AgentMail realtime event", error);
      this.persistRuntimeState({
        realtimeConnected: false,
        connectionState: "error",
        lastEventAt: this.runtimeState.lastEventAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
