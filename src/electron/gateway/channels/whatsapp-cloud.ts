import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  ChannelAdapter,
  ChannelInfo,
  ChannelStatus,
  DeliveryState,
  DeliveryStatusHandler,
  ErrorHandler,
  IncomingMessage,
  MessageAttachment,
  MessageHandler,
  OutgoingMessage,
  StatusHandler,
  WhatsAppCloudConfig,
} from "./types";
import { createLogger } from "../../utils/logger";
import { timingSafeEqualString } from "../../utils/webhook-auth";
import {
  WebhookBodyTooLargeError,
  readLimitedBody,
  resolveRequestPath,
  resolveRequestQuery,
} from "./webhook-channel-utils";
import { HeldReply, ThrottledWarning, WebhookChannelState } from "./webhook-channel-state";

const logger = createLogger("WhatsAppCloudAdapter");

const GRAPH_BASE = "https://graph.facebook.com";
const DEFAULT_GRAPH_VERSION = "v21.0";
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 4096;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Held attachments are persisted inline; larger buffers are dropped with a warning. */
const MAX_HELD_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_INBOUND_ATTEMPTS = 6;
/** Graph error codes meaning free-form messages are outside the 24-hour window. */
const WINDOW_CLOSED_CODES = new Set([131047, 131026]);
const AUTH_ERROR_CODES = new Set([190, 102, 10, 200]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);

type CloudMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: CloudMedia;
  document?: CloudMedia & { filename?: string };
  audio?: CloudMedia & { voice?: boolean };
  video?: CloudMedia;
  sticker?: CloudMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  context?: { id?: string };
};

type CloudMedia = { id?: string; mime_type?: string; caption?: string };

type CloudStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
};

type CloudContact = { wa_id?: string; profile?: { name?: string } };

type CloudChangeValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: CloudContact[];
  messages?: CloudMessage[];
  statuses?: CloudStatus[];
};

type SpooledInbound = { message: CloudMessage; contactName?: string };

export class WhatsAppCloudApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function computeWhatsAppSignature(appSecret: string, rawBody: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

function createError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function splitText(text: string, limit = MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function mediaKind(attachment: { type: string }): "image" | "document" | "audio" | "video" {
  if (attachment.type === "image") return "image";
  if (attachment.type === "audio") return "audio";
  if (attachment.type === "video") return "video";
  return "document";
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly type = "whatsapp_cloud" as const;

  private server: http.Server | null = null;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private deliveryHandlers: DeliveryStatusHandler[] = [];
  private readonly state: WebhookChannelState;
  private readonly rejectionWarning = new ThrottledWarning();
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private displayPhoneNumber?: string;
  private config: WhatsAppCloudConfig;

  constructor(config: WhatsAppCloudConfig) {
    this.config = {
      webhookPort: 3982,
      webhookPath: "/whatsapp-cloud/webhook",
      graphApiVersion: DEFAULT_GRAPH_VERSION,
      fallbackTemplateLanguage: "en_US",
      ...config,
    };
    this.state = new WebhookChannelState(config.stateDir);
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  async probe(): Promise<ChannelInfo> {
    this.assertConfigured();
    const profile = (await this.graphRequest(
      "GET",
      `/${encodeURIComponent(this.config.phoneNumberId)}?fields=display_phone_number,verified_name`,
    )) as { display_phone_number?: string; verified_name?: string };
    this.displayPhoneNumber = profile.display_phone_number;
    this._botUsername =
      this.config.displayName || profile.verified_name || profile.display_phone_number;
    return this.getInfo();
  }

  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") return;
    this.setStatus("connecting");
    try {
      await this.probe();
      await this.startServer();
      this.setStatus("connected");
      logger.info(`Connected on port ${this.config.webhookPort}`);
      this.scheduleDrain(0);
    } catch (error) {
      const err = createError(error);
      await this.stopServer().catch(() => undefined);
      this.setStatus("error", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    await this.stopServer();
    this.state.flush();
    this.setStatus("disconnected");
  }

  async sendMessage(message: OutgoingMessage): Promise<string> {
    const to = this.requireRecipient(message.chatId);
    const text = this.config.responsePrefix
      ? `${this.config.responsePrefix} ${message.text}`.trim()
      : message.text;

    if (this.isWindowKnownClosed(to)) {
      return this.holdAndNotify(to, text, message.replyTo, message.attachments || []);
    }

    const attachments = [...(message.attachments || [])];
    const chunks = text.trim() ? splitText(text) : [];
    let lastId = "";
    let sentAny = false;
    try {
      while (attachments.length > 0) {
        lastId = await this.sendAttachment(to, attachments[0]);
        attachments.shift();
        sentAny = true;
      }
      while (chunks.length > 0) {
        lastId = await this.postMessage(to, {
          type: "text",
          text: { body: chunks[0], preview_url: message.disableLinkPreview !== true },
          ...(!sentAny && message.replyTo ? { context: { message_id: message.replyTo } } : {}),
        });
        chunks.shift();
        sentAny = true;
      }
      return lastId || `whatsapp-cloud-${Date.now()}`;
    } catch (error) {
      if (error instanceof WhatsAppCloudApiError && WINDOW_CLOSED_CODES.has(error.code ?? -1)) {
        // Meta is the authority on the window (our last-activity record can be
        // missing after a restart or reinstall). Hold whatever was not sent.
        return this.holdAndNotify(to, chunks.join("\n"), message.replyTo, attachments);
      }
      throw error;
    }
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    return this.sendMessage({
      chatId,
      text: caption || "",
      attachments: [{ type: "document", url: filePath, fileName: path.basename(filePath) }],
    });
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    return this.sendMessage({
      chatId,
      text: caption || "",
      attachments: [{ type: "image", url: filePath }],
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  onStatusChange(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  onDeliveryStatus(handler: DeliveryStatusHandler): void {
    this.deliveryHandlers.push(handler);
  }

  updateConfig(config: WhatsAppCloudConfig): void {
    const previousPort = this.config.webhookPort;
    this.config = { ...this.config, ...config };
    if (this.server && this.config.webhookPort !== previousPort) void this.restartServer();
  }

  private async restartServer(): Promise<void> {
    try {
      await this.stopServer();
      await this.startServer();
    } catch (error) {
      this.setStatus("error", createError(error));
    }
  }

  async getInfo(): Promise<ChannelInfo> {
    return {
      type: "whatsapp_cloud",
      status: this._status,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
      extra: {
        webhookPort: this.config.webhookPort,
        webhookPath: this.config.webhookPath,
        phoneNumber: this.displayPhoneNumber,
        fallbackTemplate: this.config.fallbackTemplateName || null,
        health: this.state.snapshot(),
      },
    };
  }

  /** Visible for tests: accept a verified webhook payload (spool, then process). */
  async handleWebhookPayload(payload: Record<string, unknown>): Promise<void> {
    this.acceptWebhookPayload(payload);
    await this.drainInbound();
  }

  /** Validates routing, spools inbound messages and emits receipts. Synchronous so it runs before the ack. */
  private acceptWebhookPayload(payload: Record<string, unknown>): void {
    if (payload.object !== "whatsapp_business_account") return;
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries as Array<{
      changes?: Array<{ field?: string; value?: CloudChangeValue }>;
    }>) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages" || !change.value) continue;
        const value = change.value;
        if (
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== this.config.phoneNumberId
        ) {
          continue;
        }
        for (const status of value.statuses || []) this.emitDeliveryStatus(status);
        for (const message of value.messages || []) {
          if (!message.id || !message.from) continue;
          const contactName = (value.contacts || []).find((c) => c.wa_id === message.from)?.profile
            ?.name;
          this.state.enqueueInbound<SpooledInbound>(message.id, { message, contactName });
        }
      }
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drainInbound();
    }, delayMs);
    this.drainTimer.unref?.();
  }

  private async drainInbound(): Promise<void> {
    if (this.draining) {
      // Entries spooled while a drain is running are not in its snapshot; rescan after it.
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.drainAgain = false;
        for (const entry of this.state.dueInbound<SpooledInbound>()) {
          try {
            await this.processInbound(entry.payload);
            this.state.completeInbound(entry.id);
          } catch (error) {
            const err = createError(error);
            const delay = this.state.failInbound(entry.id, err.message, MAX_INBOUND_ATTEMPTS);
            this.handleError(
              new Error(
                delay === null
                  ? `Giving up on inbound WhatsApp message ${entry.id}: ${err.message}`
                  : `Inbound WhatsApp message ${entry.id} failed; retrying in ${Math.round(delay / 1000)}s: ${err.message}`,
              ),
              "inbound-processing",
            );
          }
        }
      } while (this.drainAgain);
      const nextAttemptAt = this.state.nextInboundAttemptAt();
      if (nextAttemptAt !== undefined && this._status === "connected") {
        this.scheduleDrain(Math.max(0, nextAttemptAt - Date.now()));
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async processInbound({ message, contactName }: SpooledInbound): Promise<void> {
    const from = message.from as string;
    const timestampMs = Number(message.timestamp) * 1000 || Date.now();
    this.state.recordChatActivity(from, timestampMs);

    // The contact has reopened the window, so answers held while it was
    // closed go out before the new message is routed.
    await this.flushHeldReplies(from);

    const { text, attachments } = await this.extractContent(message);
    if (!text.trim() && attachments.length === 0) return;

    const incoming: IncomingMessage = {
      messageId: message.id as string,
      channel: "whatsapp_cloud",
      userId: from,
      userName: contactName || from,
      chatId: from,
      isGroup: false,
      text,
      timestamp: new Date(timestampMs),
      replyTo: message.context?.id,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: message,
      metadata: { messageType: message.type },
    };
    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }

  private async flushHeldReplies(chatId: string): Promise<void> {
    const held = this.state.takeHeldReplies(chatId);
    for (let i = 0; i < held.length; i++) {
      try {
        await this.sendHeldReply(chatId, held[i]);
        this.state.discardHeldReply(held[i]);
      } catch (error) {
        this.state.restoreHeldReplies(chatId, held.slice(i));
        this.handleError(
          new Error(`Could not deliver held WhatsApp reply: ${createError(error).message}`),
          "held-reply",
        );
        return;
      }
    }
    if (held.length > 0) logger.info(`Delivered ${held.length} held reply(s) to ${chatId}`);
  }

  private async sendHeldReply(to: string, reply: HeldReply): Promise<void> {
    for (const attachment of reply.attachments || []) {
      await this.sendAttachment(to, {
        type: attachment.type as MessageAttachment["type"],
        url: attachment.url,
        data: this.state.heldAttachmentData(attachment),
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      });
    }
    const chunks = reply.text.trim() ? splitText(reply.text) : [];
    for (let i = 0; i < chunks.length; i++) {
      await this.postMessage(to, {
        type: "text",
        text: { body: chunks[i] },
        ...(i === 0 && reply.replyTo ? { context: { message_id: reply.replyTo } } : {}),
      });
    }
  }

  private isWindowKnownClosed(waId: string): boolean {
    const last = this.state.lastChatActivity(waId);
    return last !== undefined && Date.now() - last >= CUSTOMER_SERVICE_WINDOW_MS;
  }

  /**
   * Holds a reply that cannot be sent as free-form text and, at most once per
   * 24 hours per contact, sends the approved template inviting them back.
   */
  private async holdAndNotify(
    to: string,
    text: string,
    replyTo: string | undefined,
    attachments: MessageAttachment[],
  ): Promise<string> {
    if (!this.config.fallbackTemplateName) {
      throw new Error(
        "The 24-hour WhatsApp customer-service window is closed for this contact, so only an approved template can be sent. Configure a fallback template in the WhatsApp Business channel settings, or wait for the contact to message first.",
      );
    }
    const heldAttachments: NonNullable<HeldReply["attachments"]> = [];
    for (const attachment of attachments) {
      if (attachment.data && attachment.data.length > MAX_HELD_ATTACHMENT_BYTES) {
        logger.warn(`Dropping ${attachment.fileName || "attachment"} from held reply: too large`);
        continue;
      }
      heldAttachments.push({
        type: attachment.type,
        url: attachment.url,
        dataBase64: attachment.data?.toString("base64"),
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      });
    }
    if (text.trim() || heldAttachments.length > 0) {
      this.state.holdReply(to, {
        text,
        replyTo,
        attachments: heldAttachments.length > 0 ? heldAttachments : undefined,
        heldAt: Date.now(),
      });
    }

    const lastTemplate = this.state.lastTemplateSent(to);
    if (lastTemplate !== undefined && Date.now() - lastTemplate < CUSTOMER_SERVICE_WINDOW_MS) {
      return `whatsapp-cloud-held-${Date.now()}`;
    }
    const id = await this.postMessage(to, {
      type: "template",
      template: {
        name: this.config.fallbackTemplateName,
        language: { code: this.config.fallbackTemplateLanguage || "en_US" },
      },
    });
    this.state.recordTemplateSent(to);
    return id;
  }

  private assertConfigured(): void {
    const missing = (["phoneNumberId", "accessToken", "appSecret", "verifyToken"] as const).filter(
      (key) => !this.config[key]?.trim(),
    );
    if (missing.length > 0) {
      throw new Error(
        `WhatsApp Cloud is missing ${missing.join(", ")}. The app secret and verify token are required so webhook calls can be authenticated.`,
      );
    }
  }

  private requireRecipient(chatId: string): string {
    const digits = chatId.replace(/^\+/, "").replace(/[\s()-]/g, "");
    if (!/^[1-9]\d{6,14}$/.test(digits)) {
      throw new Error(`WhatsApp Cloud recipient must be an international phone number: ${chatId}`);
    }
    return digits;
  }

  private async sendAttachment(
    to: string,
    attachment: MessageAttachment,
    caption?: string,
  ): Promise<string> {
    const kind = mediaKind(attachment);
    const media: Record<string, unknown> = {};
    if (attachment.url && /^https:\/\//i.test(attachment.url) && !attachment.data) {
      media.link = attachment.url;
    } else {
      media.id = await this.uploadMedia(attachment);
    }
    if (caption && kind !== "audio") media.caption = caption;
    if (kind === "document") {
      media.filename =
        attachment.fileName || (attachment.url ? path.basename(attachment.url) : "file");
    }
    return this.postMessage(to, { type: kind, [kind]: media });
  }

  private async uploadMedia(attachment: MessageAttachment): Promise<string> {
    let data = attachment.data;
    let fileName = attachment.fileName;
    if (!data) {
      const localPath = attachment.url?.replace(/^file:\/\//, "");
      if (!localPath) throw new Error("Attachment has neither data nor a file path");
      const stat = await fs.promises.stat(localPath);
      if (stat.size > MAX_MEDIA_BYTES) throw new Error("Attachment exceeds the 25 MB limit");
      data = await fs.promises.readFile(localPath);
      fileName = fileName || path.basename(localPath);
    }
    if (data.length > MAX_MEDIA_BYTES) throw new Error("Attachment exceeds the 25 MB limit");
    const mimeType = attachment.mimeType || "application/octet-stream";
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), fileName || "file");
    const result = (await this.graphRequest(
      "POST",
      `/${encodeURIComponent(this.config.phoneNumberId)}/media`,
      form,
    )) as { id?: string };
    if (!result.id) throw new Error("WhatsApp media upload returned no id");
    return result.id;
  }

  private async postMessage(to: string, body: Record<string, unknown>): Promise<string> {
    const result = (await this.graphRequest(
      "POST",
      `/${encodeURIComponent(this.config.phoneNumberId)}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, ...body },
    )) as { messages?: Array<{ id?: string }> };
    return result.messages?.[0]?.id || `whatsapp-cloud-${Date.now()}`;
  }

  private async graphRequest(
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: Record<string, unknown> | FormData,
  ): Promise<unknown> {
    const version = this.config.graphApiVersion || DEFAULT_GRAPH_VERSION;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.accessToken}` };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${GRAPH_BASE}/${version}${pathAndQuery}`, {
      method,
      headers,
      body: payload,
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    if (!response.ok || data.error) {
      throw this.toApiError(response.status, data.error);
    }
    return data;
  }

  private toApiError(
    status: number,
    error?: { message?: string; code?: number; error_data?: { details?: string } },
  ): WhatsAppCloudApiError {
    const code = error?.code;
    const detail = error?.error_data?.details || error?.message || `HTTP ${status}`;
    if (code !== undefined && AUTH_ERROR_CODES.has(code)) {
      return new WhatsAppCloudApiError(
        `WhatsApp Cloud rejected the access token (${detail}). Generate a new system-user token and update the channel.`,
        code,
        status,
      );
    }
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
      return new WhatsAppCloudApiError(
        `WhatsApp Cloud rate limit reached: ${detail}`,
        code,
        status,
      );
    }
    return new WhatsAppCloudApiError(`WhatsApp Cloud API error: ${detail}`, code, status);
  }

  private async startServer(): Promise<void> {
    const port = this.config.webhookPort || 3982;
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });
      this.server.on("error", (error: NodeJS.ErrnoException) => {
        reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use.`) : error);
      });
      this.server.listen(port, () => resolve());
    });
  }

  private async stopServer(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private rejectWebhook(res: http.ServerResponse, status: number, reason: string): void {
    this.state.recordRejectedWebhook(reason);
    const warning = this.rejectionWarning.next(
      `Rejected WhatsApp webhook: ${reason}. Check that the App Secret matches the Meta app and that the callback URL points at this channel.`,
    );
    if (warning) this.handleError(new Error(warning), "webhook-auth");
    res.writeHead(status);
    res.end(status === 403 ? "Forbidden" : "Invalid signature");
  }

  /** Visible for tests. */
  async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const webhookPath = this.config.webhookPath || "/whatsapp-cloud/webhook";
    const requestPath = resolveRequestPath(req);
    if (req.method === "GET" && requestPath === "/whatsapp-cloud/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: this._status }));
      return;
    }
    if (requestPath !== webhookPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    if (req.method === "GET") {
      const query = resolveRequestQuery(req);
      const verifyToken = query.get("hub.verify_token") || "";
      if (
        query.get("hub.mode") === "subscribe" &&
        this.config.verifyToken &&
        timingSafeEqualString(verifyToken, this.config.verifyToken)
      ) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(query.get("hub.challenge") || "");
        return;
      }
      this.rejectWebhook(res, 403, "verification handshake with a wrong verify token");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const rawBody = await readLimitedBody(req);
      const signature = String(req.headers["x-hub-signature-256"] || "");
      if (!signature) {
        this.rejectWebhook(res, 401, "missing X-Hub-Signature-256 header");
        return;
      }
      if (
        !this.config.appSecret ||
        !timingSafeEqualString(signature, computeWhatsAppSignature(this.config.appSecret, rawBody))
      ) {
        this.rejectWebhook(res, 401, "signature does not match the App Secret");
        return;
      }
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      res.writeHead(error instanceof WebhookBodyTooLargeError ? 413 : 400);
      res.end("Bad Request");
      return;
    }

    try {
      this.acceptWebhookPayload(payload);
    } catch (error) {
      // Spooling failed (e.g. disk full): do not ack, so Meta retries later.
      this.handleError(createError(error), "webhook-spool");
      res.writeHead(500);
      res.end("Temporarily unavailable");
      return;
    }
    res.writeHead(200);
    res.end("OK");
    await this.drainInbound();
  }

  private async extractContent(
    message: CloudMessage,
  ): Promise<{ text: string; attachments: MessageAttachment[] }> {
    switch (message.type) {
      case "text":
        return { text: message.text?.body || "", attachments: [] };
      case "button":
        return { text: message.button?.text || message.button?.payload || "", attachments: [] };
      case "interactive":
        return {
          text:
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title ||
            "",
          attachments: [],
        };
      case "location": {
        const loc = message.location;
        const label = [loc?.name, loc?.address].filter(Boolean).join(", ");
        return {
          text: `Shared location: ${loc?.latitude},${loc?.longitude}${label ? ` (${label})` : ""}`,
          attachments: [],
        };
      }
      case "image":
      case "document":
      case "audio":
      case "video":
      case "sticker": {
        const media = message[message.type];
        const attachment = media?.id
          ? await this.downloadMedia(media.id, message.type, media.mime_type, message)
          : null;
        return { text: media?.caption || "", attachments: attachment ? [attachment] : [] };
      }
      default:
        return { text: "", attachments: [] };
    }
  }

  private async downloadMedia(
    mediaId: string,
    type: string,
    mimeType: string | undefined,
    message: CloudMessage,
  ): Promise<MessageAttachment | null> {
    const meta = (await this.graphRequest("GET", `/${encodeURIComponent(mediaId)}`)) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!meta.url) return null;
    if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) {
      logger.warn(`Skipping inbound media ${mediaId}: ${meta.file_size} bytes exceeds limit`);
      return null;
    }
    const response = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
    });
    if (!response.ok) throw new Error(`media download returned HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_MEDIA_BYTES) return null;
    const attachmentType: MessageAttachment["type"] =
      type === "image" || type === "sticker"
        ? "image"
        : type === "audio"
          ? "audio"
          : type === "video"
            ? "video"
            : "document";
    return {
      type: attachmentType,
      data,
      size: data.length,
      mimeType: meta.mime_type || mimeType,
      fileName: message.document?.filename,
      isVoiceNote: type === "audio" ? Boolean(message.audio?.voice) : undefined,
    };
  }

  private emitDeliveryStatus(status: CloudStatus): void {
    if (!status.id || !status.status) return;
    const state = (
      ["sent", "delivered", "read", "failed"].includes(status.status) ? status.status : "sent"
    ) as DeliveryState;
    const error = status.errors?.[0];
    const update = {
      messageId: status.id,
      chatId: status.recipient_id || "",
      state,
      timestamp: new Date(Number(status.timestamp) * 1000 || Date.now()),
      errorCode: error?.code !== undefined ? String(error.code) : undefined,
      errorMessage: error?.message || error?.title,
    };
    this.state.recordDelivery(update);
    if (state === "failed") {
      logger.warn(`Delivery failed for ${status.id}: ${update.errorMessage || "unknown error"}`);
    }
    for (const handler of this.deliveryHandlers) handler(update);
  }

  private setStatus(status: ChannelStatus, error?: Error): void {
    this._status = status;
    for (const handler of this.statusHandlers) handler(status, error);
  }

  private handleError(error: Error, context?: string): void {
    for (const handler of this.errorHandlers) handler(error, context);
    logger.error(error.message, context);
  }
}

export function createWhatsAppCloudAdapter(config: WhatsAppCloudConfig): WhatsAppCloudAdapter {
  return new WhatsAppCloudAdapter(config);
}
