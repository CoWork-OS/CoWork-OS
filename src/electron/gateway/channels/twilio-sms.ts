import * as crypto from "crypto";
import * as http from "http";
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
  TwilioSmsConfig,
} from "./types";
import { createLogger } from "../../utils/logger";
import { timingSafeEqualString } from "../../utils/webhook-auth";
import {
  WebhookBodyTooLargeError,
  normalizeE164,
  readLimitedBody,
  resolveRequestPath,
} from "./webhook-channel-utils";
import { ThrottledWarning, WebhookChannelState } from "./webhook-channel-state";

const logger = createLogger("TwilioSmsAdapter");

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
/** Twilio concatenates up to 1600 characters into one logical message. */
const MAX_BODY_LENGTH = 1600;
const PART_LABEL_RESERVE = 10;
const MAX_INBOUND_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_PER_MESSAGE = 10;
const MAX_INBOUND_ATTEMPTS = 6;
/**
 * Keywords Twilio and carriers answer themselves (opt-out, opt-in, help).
 * YES is deliberately absent even though Twilio treats it as opt-in: it is too
 * common as an ordinary answer to the agent.
 */
const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "revoke",
]);
const CARRIER_KEYWORDS = new Set(["start", "unstop", "help", "info"]);
const AUTH_ERROR_CODES = new Set([20003, 20005, 20008]);
const RATE_LIMIT_CODES = new Set([20429, 14107]);

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the URL plus the sorted form params. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => `${acc}${key}${params[key]}`, url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

/** Twilio may sign the URL with or without the default port, so accept either form. */
function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const origin = `${parsed.protocol}//${parsed.hostname}`;
  const rest = `${parsed.pathname}${parsed.search}`;
  return [`${origin}${rest}`, `${origin}:${port}${rest}`].some((candidate) =>
    timingSafeEqualString(signature, computeTwilioSignature(authToken, candidate, params)),
  );
}

export class TwilioApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

function createError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Split text into Twilio-sized messages. Carriers do not guarantee ordering
 * across separate messages, so multi-part replies are labelled "(1/3)".
 */
export function splitSmsBody(text: string): string[] {
  if (text.length <= MAX_BODY_LENGTH) return [text];
  const limit = MAX_BODY_LENGTH - PART_LABEL_RESERVE;
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
  return parts.map((part, index) => `(${index + 1}/${parts.length}) ${part}`);
}

function mapTwilioStatus(status: string): DeliveryState | null {
  switch (status) {
    case "accepted":
    case "queued":
    case "scheduled":
      return "queued";
    case "sending":
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "undelivered":
      return "undelivered";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

type SenderKind = "phone" | "short_code" | "alphanumeric" | "whatsapp" | "unknown";

function classifySender(raw: string): { id: string; kind: SenderKind } {
  const value = raw.trim();
  if (value.toLowerCase().startsWith("whatsapp:")) return { id: value, kind: "whatsapp" };
  const e164 = normalizeE164(value);
  if (e164) return { id: e164, kind: "phone" };
  if (/^\d{3,8}$/.test(value)) return { id: value, kind: "short_code" };
  if (/^[A-Za-z0-9 ]{2,15}$/.test(value)) return { id: value, kind: "alphanumeric" };
  return { id: value, kind: "unknown" };
}

export class TwilioSmsAdapter implements ChannelAdapter {
  readonly type = "twilio_sms" as const;

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
  private config: TwilioSmsConfig;

  constructor(config: TwilioSmsConfig) {
    this.config = {
      webhookPort: 3983,
      webhookPath: "/twilio-sms/webhook",
      statusPath: "/twilio-sms/status",
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
    const account = (await this.twilioRequest(
      "GET",
      `/Accounts/${encodeURIComponent(this.config.accountSid)}.json`,
    )) as { friendly_name?: string; status?: string };
    if (account.status && account.status !== "active") {
      throw new Error(`Twilio account is ${account.status}`);
    }
    this._botUsername = this.config.displayName || this.config.fromNumber || account.friendly_name;
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
    const to = normalizeE164(message.chatId);
    if (!to) {
      throw new Error(
        `SMS recipient must be an E.164 number such as +15551234567: ${message.chatId}`,
      );
    }
    const mediaUrls = (message.attachments || []).map((attachment) =>
      this.publicMediaUrl(attachment),
    );
    if (mediaUrls.length > MAX_MEDIA_PER_MESSAGE) {
      throw new Error(`Twilio allows at most ${MAX_MEDIA_PER_MESSAGE} media items per message`);
    }
    const text = this.config.responsePrefix
      ? `${this.config.responsePrefix} ${message.text}`.trim()
      : message.text;
    const bodies = text.trim() ? splitSmsBody(text) : [""];
    let lastSid = "";
    for (let i = 0; i < bodies.length; i++) {
      lastSid = await this.createMessage(to, bodies[i], i === 0 ? mediaUrls : []);
    }
    return lastSid;
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<string> {
    return this.sendMessage({
      chatId,
      text: caption || "",
      attachments: [{ type: "image", url: filePath }],
    });
  }

  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<string> {
    return this.sendMessage({
      chatId,
      text: caption || "",
      attachments: [{ type: "document", url: filePath }],
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

  updateConfig(config: TwilioSmsConfig): void {
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
      type: "twilio_sms",
      status: this._status,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
      extra: {
        webhookPort: this.config.webhookPort,
        webhookUrl: this.publicUrl(this.config.webhookPath),
        statusCallbackUrl: this.publicUrl(this.config.statusPath),
        fromNumber: this.config.fromNumber || null,
        messagingServiceSid: this.config.messagingServiceSid || null,
        health: this.state.snapshot(),
      },
    };
  }

  private assertConfigured(): void {
    if (!/^AC[0-9a-f]{32}$/i.test(this.config.accountSid || "")) {
      throw new Error("Twilio Account SID must start with AC followed by 32 hex characters");
    }
    if (!this.config.authToken?.trim()) throw new Error("Twilio auth token is required");
    if (this.config.messagingServiceSid) {
      if (!/^MG[0-9a-f]{32}$/i.test(this.config.messagingServiceSid)) {
        throw new Error("Messaging Service SID must start with MG followed by 32 hex characters");
      }
    } else if (!this.config.fromNumber || !normalizeE164(this.config.fromNumber)) {
      throw new Error(
        "Set a sending number in E.164 format (e.g. +15551234567) or a Messaging Service SID",
      );
    }
    let base: URL;
    try {
      base = new URL(this.config.webhookPublicUrl || "");
    } catch {
      throw new Error(
        "Twilio needs the public HTTPS URL that forwards to this machine (for example a tunnel URL) to verify webhook signatures.",
      );
    }
    if (base.protocol !== "https:") {
      throw new Error("The Twilio public webhook URL must use https");
    }
  }

  private publicBase(): { origin: string; prefix: string } {
    try {
      const base = new URL(this.config.webhookPublicUrl || "");
      return { origin: base.origin, prefix: base.pathname.replace(/\/+$/, "") };
    } catch {
      return { origin: "", prefix: "" };
    }
  }

  private publicUrl(pathName: string | undefined): string {
    const { origin, prefix } = this.publicBase();
    return `${origin}${prefix}${pathName || ""}`;
  }

  /**
   * Maps the local request path to the configured route. A reverse proxy may
   * forward `/prefix/twilio-sms/webhook` with or without stripping the prefix
   * from the public base URL; both must resolve to the same route and signed URL.
   */
  private localRoute(requestPath: string): string {
    const { prefix } = this.publicBase();
    return prefix && requestPath.startsWith(`${prefix}/`)
      ? requestPath.slice(prefix.length)
      : requestPath;
  }

  private publicMediaUrl(attachment: MessageAttachment): string {
    if (attachment.url && /^https:\/\//i.test(attachment.url)) return attachment.url;
    throw new Error(
      "Twilio MMS can only send media from a public HTTPS URL; local files and in-memory attachments are not supported on this channel.",
    );
  }

  private async createMessage(to: string, body: string, mediaUrls: string[]): Promise<string> {
    const form = new URLSearchParams();
    form.set("To", to);
    if (this.config.messagingServiceSid) {
      form.set("MessagingServiceSid", this.config.messagingServiceSid);
    } else {
      form.set("From", normalizeE164(this.config.fromNumber || "") || "");
    }
    if (body) form.set("Body", body);
    for (const url of mediaUrls) form.append("MediaUrl", url);
    form.set("StatusCallback", this.publicUrl(this.config.statusPath));
    const result = (await this.twilioRequest(
      "POST",
      `/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      form,
    )) as { sid?: string };
    if (!result.sid) throw new Error("Twilio did not return a message SID");
    return result.sid;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`;
  }

  private async twilioRequest(
    method: "GET" | "POST",
    pathName: string,
    form?: URLSearchParams,
  ): Promise<unknown> {
    const response = await fetch(`${TWILIO_API_BASE}${pathName}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form?.toString(),
    });
    const data = (await response.json().catch(() => ({}))) as {
      code?: number;
      message?: string;
    };
    if (!response.ok) {
      const code = data.code;
      if (response.status === 401 || (code !== undefined && AUTH_ERROR_CODES.has(code))) {
        throw new TwilioApiError(
          "Twilio rejected the Account SID or auth token. Check the credentials in the channel settings.",
          code,
          response.status,
        );
      }
      if (response.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
        throw new TwilioApiError(
          `Twilio rate limit reached: ${data.message || "retry later"}`,
          code,
          429,
        );
      }
      if (code === 21610) {
        throw new TwilioApiError(
          "This recipient has replied STOP and opted out of SMS from this number.",
          code,
          response.status,
        );
      }
      throw new TwilioApiError(
        `Twilio API error${code ? ` ${code}` : ""}: ${data.message || `HTTP ${response.status}`}`,
        code,
        response.status,
      );
    }
    return data;
  }

  private async startServer(): Promise<void> {
    const port = this.config.webhookPort || 3983;
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

  private rejectWebhook(res: http.ServerResponse, reason: string, signedUrl: string): void {
    this.state.recordRejectedWebhook(reason);
    const warning = this.rejectionWarning.next(
      `Rejected Twilio webhook: ${reason}. CoWork verified it against ${signedUrl}; if your tunnel URL changed, update the public base URL in the channel settings and in the Twilio console.`,
    );
    if (warning) this.handleError(new Error(warning), "webhook-auth");
    res.writeHead(403);
    res.end("Invalid signature");
  }

  /** Visible for tests. */
  async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const route = this.localRoute(resolveRequestPath(req));
    const webhookPath = this.config.webhookPath || "/twilio-sms/webhook";
    const statusPath = this.config.statusPath || "/twilio-sms/status";

    if (req.method === "GET" && route === "/twilio-sms/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: this._status }));
      return;
    }
    if (route !== webhookPath && route !== statusPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    let params: Record<string, string>;
    try {
      const rawBody = await readLimitedBody(req);
      params = Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
    } catch (error) {
      res.writeHead(error instanceof WebhookBodyTooLargeError ? 413 : 400);
      res.end("Bad Request");
      return;
    }

    const signature = String(req.headers["x-twilio-signature"] || "");
    const rawUrl = req.url || "";
    const query = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
    const signedUrl = `${this.publicUrl(route)}${query}`;
    if (!signature) {
      this.rejectWebhook(res, "missing X-Twilio-Signature header", signedUrl);
      return;
    }
    let valid = false;
    try {
      valid =
        Boolean(this.config.authToken) &&
        validateTwilioSignature(this.config.authToken, signature, signedUrl, params);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.rejectWebhook(res, "signature does not match the auth token and URL", signedUrl);
      return;
    }

    if (route === statusPath) {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end("<Response></Response>");
      this.handleStatusCallback(params);
      return;
    }

    const sid = params.MessageSid || params.SmsSid;
    try {
      if (sid) this.state.enqueueInbound(sid, params);
    } catch (error) {
      // Spooling failed (e.g. disk full): do not ack, so Twilio retries.
      this.handleError(createError(error), "webhook-spool");
      res.writeHead(500);
      res.end("Temporarily unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    await this.drainInbound();
  }

  private handleStatusCallback(params: Record<string, string>): void {
    const sid = params.MessageSid || params.SmsSid;
    const rawStatus = params.MessageStatus || params.SmsStatus || "";
    const state = mapTwilioStatus(rawStatus);
    if (!sid || !state) return;
    const key = `status:${sid}:${rawStatus}`;
    if (this.state.hasSeen(key)) return;
    this.state.markSeen(key);
    const update = {
      messageId: sid,
      chatId: params.To || "",
      state,
      timestamp: new Date(),
      errorCode: params.ErrorCode || undefined,
      errorMessage: params.ErrorMessage || undefined,
    };
    this.state.recordDelivery(update);
    if (state === "failed" || state === "undelivered") {
      logger.warn(
        `Delivery ${rawStatus} for ${sid}${update.errorCode ? ` (error ${update.errorCode})` : ""}`,
      );
    }
    for (const handler of this.deliveryHandlers) handler(update);
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
        for (const entry of this.state.dueInbound<Record<string, string>>()) {
          try {
            await this.processInbound(entry.payload);
            this.state.completeInbound(entry.id);
          } catch (error) {
            const err = createError(error);
            const delay = this.state.failInbound(entry.id, err.message, MAX_INBOUND_ATTEMPTS);
            this.handleError(
              new Error(
                delay === null
                  ? `Giving up on inbound SMS ${entry.id}: ${err.message}`
                  : `Inbound SMS ${entry.id} failed; retrying in ${Math.round(delay / 1000)}s: ${err.message}`,
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

  private async processInbound(params: Record<string, string>): Promise<void> {
    const sid = params.MessageSid || params.SmsSid;
    const sender = classifySender(params.From || "");
    if (!sid || !sender.id) return;

    const text = params.Body || "";
    const attachments = await this.downloadInboundMedia(params);
    if (!text.trim() && attachments.length === 0) return;

    const keyword = text.trim().toLowerCase();
    const optOut = OPT_OUT_KEYWORDS.has(keyword);
    const carrierKeyword = optOut || CARRIER_KEYWORDS.has(keyword);
    // Short codes, alphanumeric senders and WhatsApp-over-Twilio addresses
    // cannot receive replies from this SMS number.
    const replyable = sender.kind === "phone";
    if (!replyable) {
      logger.warn(`Recording SMS from non-replyable ${sender.kind} sender without routing it`);
    }
    const incoming: IncomingMessage = {
      messageId: sid,
      channel: "twilio_sms",
      userId: sender.id,
      userName: sender.id,
      chatId: sender.id,
      isGroup: false,
      text,
      timestamp: new Date(),
      attachments: attachments.length > 0 ? attachments : undefined,
      // Twilio/carriers answer these keywords themselves, and replying after
      // STOP fails with error 21610, so record them without routing.
      ingestOnly: carrierKeyword || !replyable || undefined,
      raw: params,
      metadata: {
        to: params.To,
        numSegments: params.NumSegments,
        senderKind: sender.kind,
        optOut: optOut || undefined,
        carrierKeyword: carrierKeyword ? keyword : undefined,
      },
    };
    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }

  private async downloadInboundMedia(params: Record<string, string>): Promise<MessageAttachment[]> {
    const count = Math.min(Number(params.NumMedia || 0) || 0, MAX_MEDIA_PER_MESSAGE);
    const attachments: MessageAttachment[] = [];
    for (let i = 0; i < count; i++) {
      const url = params[`MediaUrl${i}`];
      if (!url || !/^https:\/\/api\.twilio\.com\//.test(url)) continue;
      const mimeType = params[`MediaContentType${i}`];
      const response = await fetch(url, { headers: { Authorization: this.authHeader() } });
      if (!response.ok) throw new Error(`MMS media download returned HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > MAX_INBOUND_MEDIA_BYTES) {
        logger.warn(`Skipping MMS media ${i}: ${data.length} bytes exceeds limit`);
        continue;
      }
      attachments.push({
        type: mimeType?.startsWith("image/")
          ? "image"
          : mimeType?.startsWith("audio/")
            ? "audio"
            : mimeType?.startsWith("video/")
              ? "video"
              : "document",
        data,
        size: data.length,
        mimeType,
      });
    }
    return attachments;
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

export function createTwilioSmsAdapter(config: TwilioSmsConfig): TwilioSmsAdapter {
  return new TwilioSmsAdapter(config);
}
