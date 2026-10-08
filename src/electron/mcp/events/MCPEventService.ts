/**
 * MCP Events subscriptions owned by enabled CoWork event triggers.
 * Webhooks use Standard Webhooks verification; poll cursors advance only after
 * EventTriggerService has durably accepted each occurrence.
 */
import http from "node:http";
import { isIP } from "node:net";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { safeStorage } from "electron";
import type { MCPClientManager } from "../client/MCPClientManager";
import { MCPSettingsManager } from "../settings";
import type { EventTriggerService } from "../../triggers/EventTriggerService";
import type { EventTrigger } from "../../triggers/types";
import { readLimitedBody } from "../../gateway/channels/webhook-channel-utils";
import { createLogger } from "../../utils/logger";
import { serviceStatements } from "../../database/service-statements";
import { MCP_EVENT_SCHEMA, type SubscriptionRow } from "./mcp-event-sql";

const log = createLogger("MCPEventService");
const MAX_BODY_BYTES = 256 * 1024;
const MIN_POLL_MS = 1000;
const DEFAULT_POLL_MS = 30_000;
const MAX_POLL_MS = 15 * 60_000;
const DEFAULT_PORT = 8766;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export class MCPEventService {
  private static active: MCPEventService | null = null;
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private running = false;
  private heldServers = new Map<string, string>();

  constructor(
    private readonly db: Any,
    private readonly client: MCPClientManager,
    private readonly triggers: EventTriggerService,
    private readonly port = Number(process.env.COWORK_MCP_EVENTS_PORT) || DEFAULT_PORT,
  ) {
    this.db.exec(MCP_EVENT_SCHEMA);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    MCPEventService.active = this;
    this.server = http.createServer((req, res) => {
      void this.receive(req, res).catch((error) => {
        log.warn("MCP event callback failed:", error);
        if (!res.headersSent) this.reply(res, 503, { error: "Event not accepted" });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, "127.0.0.1", resolve);
      });
    } catch (error) {
      log.warn("MCP webhook receiver unavailable; poll subscriptions remain available:", error);
      this.server = null;
    }
    await this.sync();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (MCPEventService.active === this) MCPEventService.active = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.reconciling?.catch(() => undefined);
    await Promise.all([...this.heldServers.keys()].map((id) => this.releaseServer(id)));
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async status(): Promise<
    Array<{ triggerId: string; status: string; error?: string; refreshBefore?: number }>
  > {
    const rows = await serviceStatements(this.db).unit("mcpEvent_list", []);
    return rows.map((row) => ({
      triggerId: row.trigger_id,
      status: row.status,
      ...(row.last_error ? { error: row.last_error } : {}),
      ...(row.refresh_before ? { refreshBefore: row.refresh_before } : {}),
    }));
  }

  receiverPort(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  static getActive(): MCPEventService | null {
    return MCPEventService.active;
  }

  async listAvailable(serverId: string) {
    return this.client.listServerEvents(serverId);
  }

  async listOwned(workspaceId: string) {
    const statuses = await this.status();
    return this.triggers
      .listTriggers(workspaceId)
      .filter((trigger) => trigger.source === "mcp_event")
      .map((trigger) => ({
        id: trigger.id,
        name: trigger.name,
        enabled: trigger.enabled,
        event: trigger.action.config.mcpEvent,
        status: statuses.find((row) => row.triggerId === trigger.id),
      }));
  }

  async createFromTask(input: {
    serverId: string;
    eventName: string;
    arguments?: Record<string, unknown>;
    instructions: string;
    title?: string;
    delivery?: "webhook" | "poll";
    callbackUrl?: string;
    workspaceId: string;
    taskId: string;
    target?: "current_task" | "new_task";
  }) {
    if (!input.instructions?.trim() || !input.eventName?.trim() || !input.serverId?.trim()) {
      throw new Error("Server, event, and response instructions are required");
    }
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) {
      throw new Error("Subscription arguments must be an object");
    }
    const definition = (await this.listAvailable(input.serverId)).find(
      (event) => event.name === input.eventName,
    );
    if (!definition) throw new Error("The connected MCP server does not advertise this event");
    const callbackUrl = input.callbackUrl || process.env.COWORK_MCP_EVENTS_PUBLIC_URL;
    const delivery =
      input.delivery ||
      (callbackUrl && definition.delivery.includes("webhook")
        ? "webhook"
        : definition.delivery.includes("poll")
          ? "poll"
          : "webhook");
    if (!definition.delivery.includes(delivery))
      throw new Error("Event does not support that delivery mode");
    if (delivery === "webhook") this.callbackUrl(callbackUrl, "validation");
    const selectedCallbackUrl = delivery === "webhook" ? callbackUrl : undefined;
    const existing = this.triggers.listTriggers(input.workspaceId).find((trigger) => {
      const spec = trigger.action.config.mcpEvent;
      return (
        trigger.enabled &&
        trigger.source === "mcp_event" &&
        spec?.serverId === input.serverId &&
        spec.name === input.eventName &&
        canonicalJson(spec.arguments) === canonicalJson(input.arguments) &&
        spec.delivery === delivery &&
        spec.callbackUrl === selectedCallbackUrl &&
        trigger.action.config.prompt === input.instructions.trim() &&
        trigger.action.config.targetTaskId === input.taskId &&
        trigger.action.config.runMode ===
          (input.target === "new_task" ? "new_task" : "thread_follow_up")
      );
    });
    if (existing)
      return {
        triggerId: existing.id,
        status: (await this.status()).find((row) => row.triggerId === existing.id),
      };
    const trigger = await this.triggers.addTrigger({
      name: input.title?.trim() || `Watch ${input.eventName}`,
      enabled: true,
      source: "mcp_event",
      conditions: [],
      action: {
        type: "create_task",
        config: {
          prompt: input.instructions.trim(),
          title: input.title?.trim() || `MCP event: ${input.eventName}`,
          workspaceId: input.workspaceId,
          runMode: input.target === "new_task" ? "new_task" : "thread_follow_up",
          targetTaskId: input.taskId,
          mcpEvent: {
            serverId: input.serverId,
            name: input.eventName,
            arguments: input.arguments,
            delivery,
            ...(delivery === "webhook"
              ? {
                  callbackUrl,
                }
              : {}),
          },
        },
      },
      workspaceId: input.workspaceId,
      cooldownMs: 0,
    });
    await this.sync();
    return {
      triggerId: trigger.id,
      status: (await this.status()).find((row) => row.triggerId === trigger.id),
    };
  }

  async removeOwned(triggerId: string, workspaceId: string): Promise<boolean> {
    const trigger = this.triggers.getTrigger(triggerId);
    if (!trigger || trigger.source !== "mcp_event" || trigger.workspaceId !== workspaceId) {
      return false;
    }
    const removed = await this.triggers.removeTrigger(triggerId);
    await this.sync();
    return removed;
  }

  async sync(): Promise<void> {
    if (!this.running) return;
    if (this.reconciling) {
      await this.reconciling;
      return this.sync();
    }
    this.reconciling = this.reconcile().finally(async () => {
      this.reconciling = null;
      await this.scheduleNext();
    });
    return this.reconciling;
  }

  private async reconcile(): Promise<void> {
    const active = new Map(
      this.triggers
        .listTriggers()
        .filter((trigger) => trigger.enabled && trigger.source === "mcp_event")
        .map((trigger) => [trigger.id, trigger]),
    );
    const rows = await serviceStatements(this.db).unit("mcpEvent_list", []);
    for (const row of rows) {
      const trigger = active.get(row.trigger_id);
      if (!trigger || !this.matches(row, trigger)) {
        await this.remove(row);
      }
    }
    for (const trigger of active.values()) {
      const spec = trigger.action.config.mcpEvent;
      if (!spec) continue;
      let row = await this.get(trigger.id);
      if (!row) {
        try {
          const callbackUrl =
            spec.delivery === "webhook" ? this.callbackUrl(spec.callbackUrl, trigger.id) : null;
          const secret = spec.delivery === "webhook" ? this.newEncryptedSecret() : null;
          await serviceStatements(this.db).unit("mcpEvent_insert", [
            {
              trigger_id: trigger.id,
              server_id: spec.serverId,
              event_name: spec.name,
              arguments_json: canonicalJson(spec.arguments || {}),
              delivery: spec.delivery,
              callback_url: callbackUrl,
              secret_encrypted: secret,
            },
          ]);
          row = await this.get(trigger.id);
        } catch (error) {
          log.warn(`Invalid MCP event trigger ${trigger.id}:`, error);
          const message = error instanceof Error ? error.message : String(error);
          await serviceStatements(this.db).unit("mcpEvent_insertError", [
            trigger.id,
            spec.serverId,
            spec.name,
            canonicalJson(spec.arguments || {}),
            spec.delivery,
            message.slice(0, 500),
            Date.now() + 30_000,
          ]);
          continue;
        }
      }
      if (!row) continue;
      if (!this.matches(row, trigger)) continue;
      try {
        await this.holdServer(row.trigger_id, row.server_id);
        await this.ensureServer(row.server_id);
        if (row.delivery === "webhook") {
          if (!row.callback_url) continue;
          if (!row.secret_encrypted) {
            await serviceStatements(this.db).unit("mcpEvent_setSecret", [
              row.trigger_id,
              this.newEncryptedSecret(),
            ]);
            row = (await this.get(row.trigger_id))!;
          }
          if (!this.server) throw new Error("Local MCP webhook receiver is unavailable");
          const healthy = row.status === "active" || row.status === "gap";
          if (!healthy && row.next_poll_at && row.next_poll_at > Date.now()) continue;
          if (!healthy || !row.next_poll_at || row.next_poll_at <= Date.now()) {
            await this.subscribe(row);
          }
        } else if (!row.next_poll_at || row.next_poll_at <= Date.now()) {
          await this.poll(row);
        }
      } catch (error) {
        await this.setError(row.trigger_id, error);
      }
    }
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    const rows = await serviceStatements(this.db).unit("mcpEvent_list", []);
    if (!this.running) return;
    const deadlines = rows.map((row) => row.next_poll_at || Date.now() + 30_000);
    const next = deadlines.length ? Math.min(...deadlines) : Date.now() + 30_000;
    const delay = Math.max(1000, Math.min(30_000, next - Date.now()));
    this.timer = setTimeout(() => void this.sync(), delay);
  }

  private matches(row: SubscriptionRow, trigger: EventTrigger): boolean {
    const spec = trigger.action.config.mcpEvent;
    if (!spec) return false;
    let expectedUrl: string | null;
    try {
      expectedUrl =
        spec.delivery === "webhook" ? this.callbackUrl(spec.callbackUrl, trigger.id) : null;
    } catch {
      expectedUrl = null;
    }
    return (
      row.server_id === spec.serverId &&
      row.event_name === spec.name &&
      row.arguments_json === canonicalJson(spec.arguments || {}) &&
      row.delivery === spec.delivery &&
      row.callback_url === expectedUrl
    );
  }

  private async subscribe(row: SubscriptionRow): Promise<void> {
    const secret = this.decryptSecret(row.secret_encrypted);
    const result = await this.client.requestServerEventMethod(row.server_id, "events/subscribe", {
      name: row.event_name,
      arguments: JSON.parse(row.arguments_json),
      delivery: { mode: "webhook", url: row.callback_url, secret },
      cursor: row.cursor,
    });
    if (typeof result?.id !== "string") throw new Error("MCP subscription response lacks an ID");
    const refreshBefore = result.refreshBefore === null ? null : Date.parse(result.refreshBefore);
    if (
      refreshBefore !== null &&
      (!Number.isFinite(refreshBefore) || refreshBefore <= Date.now())
    ) {
      throw new Error("MCP subscription returned an invalid refresh deadline");
    }
    const refreshAt =
      refreshBefore === null
        ? Date.now() + 24 * 60 * 60_000
        : Date.now() + Math.max(1000, Math.floor((refreshBefore - Date.now()) * 0.8));
    const deliveryError =
      result.deliveryStatus?.active === false
        ? `Webhook delivery paused${typeof result.deliveryStatus.lastError === "string" ? ` (${result.deliveryStatus.lastError.slice(0, 100)})` : ""}`
        : null;
    await serviceStatements(this.db).unit("mcpEvent_setSubscribed", [
      row.trigger_id,
      result.id,
      typeof result.cursor === "string" ? result.cursor : row.cursor,
      refreshBefore,
      deliveryError ? Date.now() + 30_000 : refreshAt,
      deliveryError ? "error" : result.truncated ? "gap" : "active",
      deliveryError ||
        (result.truncated ? "Some events were missed before this subscription resumed" : null),
    ]);
  }

  private async poll(row: SubscriptionRow): Promise<void> {
    const result = await this.client.requestServerEventMethod(row.server_id, "events/poll", {
      name: row.event_name,
      arguments: JSON.parse(row.arguments_json),
      cursor: row.cursor,
      maxEvents: 50,
    });
    if (!Array.isArray(result?.events)) throw new Error("Invalid MCP event poll response");
    for (const event of result.events) await this.accept(row, event);
    const interval = result.hasMore
      ? MIN_POLL_MS
      : Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Number(result.nextPollMs) || DEFAULT_POLL_MS));
    await serviceStatements(this.db).unit("mcpEvent_setPolled", [
      row.trigger_id,
      typeof result.cursor === "string" ? result.cursor : row.cursor,
      Date.now() + interval,
      result.truncated ? "gap" : "active",
      result.truncated ? "Some events were missed before this poll resumed" : null,
    ]);
  }

  private async remove(row: SubscriptionRow): Promise<void> {
    if (row.delivery === "webhook" && row.callback_url) {
      try {
        await this.holdServer(row.trigger_id, row.server_id);
        await this.ensureServer(row.server_id);
        await this.client.requestServerEventMethod(row.server_id, "events/unsubscribe", {
          name: row.event_name,
          arguments: JSON.parse(row.arguments_json),
          delivery: { mode: "webhook", url: row.callback_url },
        });
      } catch (error) {
        if ((error as { code?: number })?.code === -32011) {
          await serviceStatements(this.db).unit("mcpEvent_delete", [row.trigger_id]);
          await this.releaseServer(row.trigger_id);
          return;
        }
        await this.setError(row.trigger_id, error, "removing");
        return;
      }
    }
    await serviceStatements(this.db).unit("mcpEvent_delete", [row.trigger_id]);
    await this.releaseServer(row.trigger_id);
  }

  private async holdServer(triggerId: string, serverId: string): Promise<void> {
    const previous = this.heldServers.get(triggerId);
    if (previous === serverId) return;
    if (previous) await this.releaseServer(triggerId);
    this.client.acquireForExecutor(`mcp-event:${triggerId}`, serverId);
    this.heldServers.set(triggerId, serverId);
  }

  private async releaseServer(triggerId: string): Promise<void> {
    if (!this.heldServers.delete(triggerId)) return;
    await this.client.releaseForExecutor(`mcp-event:${triggerId}`);
  }

  private async ensureServer(serverId: string): Promise<void> {
    const config = MCPSettingsManager.getServer(serverId);
    if (!config?.enabled) throw new Error("MCP event server is missing or disabled");
    const status = this.client.getServerStatus(serverId)?.status;
    if (status === "connected") return;
    if (status === "connecting" || status === "reconnecting") {
      throw new Error("MCP event server is reconnecting");
    }
    if (status === "error") await this.client.disconnectServer(serverId);
    await this.client.connectServer(serverId);
  }

  private async receive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/mcp-events\/([a-zA-Z0-9-]+)$/.exec(req.url || "");
    if (req.method !== "POST" || !match) return this.reply(res, 404, { error: "Not found" });
    const row = await this.get(match[1]);
    const trigger = this.triggers.getTrigger(match[1]);
    if (
      !this.running ||
      !row ||
      row.delivery !== "webhook" ||
      !trigger?.enabled ||
      !this.matches(row, trigger) ||
      row.status === "removing"
    ) {
      return this.reply(res, 410, { error: "Subscription unavailable" });
    }
    let body: Buffer;
    try {
      body = await readLimitedBody(req, MAX_BODY_BYTES);
    } catch {
      return this.reply(res, 413, { error: "Payload too large" });
    }
    const id = String(req.headers["webhook-id"] || "");
    const timestamp = String(req.headers["webhook-timestamp"] || "");
    const signature = String(req.headers["webhook-signature"] || "");
    const subscriptionId = String(req.headers["x-mcp-subscription-id"] || "");
    if (
      !id ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !this.verify(row, id, timestamp, body, signature)
    ) {
      return this.reply(res, 401, { error: "Invalid signature" });
    }
    let value: Any;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      return this.reply(res, 400, { error: "Invalid JSON" });
    }
    if (value?.type === "verification") {
      if (typeof value.challenge !== "string" || value.challenge.length > 512) {
        return this.reply(res, 400, { error: "Invalid challenge" });
      }
      return this.reply(res, 200, { challenge: value.challenge });
    }
    if (!row.server_subscription_id || subscriptionId !== row.server_subscription_id) {
      return this.reply(res, 401, { error: "Subscription mismatch" });
    }
    if (value?.type === "terminated") {
      await this.setError(
        row.trigger_id,
        new Error("MCP event subscription terminated"),
        "terminated",
      );
      return this.reply(res, 200, {});
    }
    if (value?.type === "gap") {
      await serviceStatements(this.db).unit("mcpEvent_setGap", [
        row.trigger_id,
        typeof value.cursor === "string" ? value.cursor : null,
        "Some events were missed; the subscription continues from the new cursor",
      ]);
      return this.reply(res, 200, {});
    }
    if (id !== value?.eventId) return this.reply(res, 400, { error: "Event ID mismatch" });
    await this.accept(row, value);
    if (typeof value.cursor === "string") {
      await serviceStatements(this.db).unit("mcpEvent_setCursor", [row.trigger_id, value.cursor]);
    }
    this.reply(res, 200, {});
  }

  private async accept(row: SubscriptionRow, event: Any): Promise<void> {
    if (
      typeof event?.eventId !== "string" ||
      event.eventId.length > 256 ||
      event.name !== row.event_name ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    ) {
      throw new Error("Invalid MCP event occurrence");
    }
    await this.triggers.evaluateEvent({
      source: "mcp_event",
      eventId: `${row.server_id}:${event.eventId}`,
      timestamp: Date.parse(event.timestamp),
      fields: {
        subscriptionTriggerId: row.trigger_id,
        serverId: row.server_id,
        eventName: row.event_name,
        eventId: event.eventId,
        data: JSON.stringify(event.data).slice(0, 16_000),
      },
    });
  }

  private callbackUrl(base: string | undefined, triggerId: string): string {
    if (!base) throw new Error("Public HTTPS callback URL is required for webhook delivery");
    const url = new URL(base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      /(^localhost$|\.localhost$|\.local$|\.internal$)/i.test(url.hostname)
    ) {
      throw new Error("MCP callback URL must be public HTTPS");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/mcp-events/${triggerId}`;
    url.search = "";
    return url.toString();
  }

  private newEncryptedSecret(): string {
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    if (safeStorage?.isEncryptionAvailable?.()) {
      return `os:${safeStorage.encryptString(secret).toString("base64")}`;
    }
    const key = this.environmentKey();
    if (!key) throw new Error("OS encryption or COWORK_MCP_EVENTS_KEY is required for webhooks");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return `env:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
  }

  private decryptSecret(encrypted: string | null): string {
    if (encrypted?.startsWith("os:")) {
      if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("OS encryption is unavailable");
      return safeStorage.decryptString(Buffer.from(encrypted.slice(3), "base64"));
    }
    if (encrypted?.startsWith("env:")) {
      const key = this.environmentKey();
      if (!key) throw new Error("COWORK_MCP_EVENTS_KEY is unavailable");
      const bytes = Buffer.from(encrypted.slice(4), "base64");
      if (bytes.length < 29) throw new Error("MCP webhook secret is corrupt");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    }
    throw new Error("MCP webhook signing secret is unavailable");
  }

  private environmentKey(): Buffer | null {
    const value = process.env.COWORK_MCP_EVENTS_KEY;
    if (!value) return null;
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error("COWORK_MCP_EVENTS_KEY must be 32 base64 encoded bytes");
    return key;
  }

  private verify(
    row: SubscriptionRow,
    id: string,
    timestamp: string,
    body: Buffer,
    header: string,
  ): boolean {
    const secret = this.decryptSecret(row.secret_encrypted);
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
    return header.split(" ").some((part) => {
      if (!part.startsWith("v1,")) return false;
      const actual = Buffer.from(part.slice(3), "base64");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  }

  private get(triggerId: string): Promise<SubscriptionRow | undefined> {
    return serviceStatements(this.db).unit("mcpEvent_get", [triggerId]);
  }

  private async setError(triggerId: string, error: unknown, status = "error"): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await serviceStatements(this.db).unit("mcpEvent_setError", [
      triggerId,
      status,
      message.slice(0, 500),
      Date.now() + 30_000,
    ]);
    log.warn(`MCP event subscription ${triggerId}: ${message}`);
  }

  private reply(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
}
