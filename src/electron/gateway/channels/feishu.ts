import * as crypto from "crypto";
import * as http from "http";
import {
  ChannelAdapter,
  ChannelInfo,
  ChannelStatus,
  ErrorHandler,
  FeishuConfig,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  StatusHandler,
} from "./types";
import { createLogger } from "../../utils/logger";
import { timingSafeEqualString } from "../../utils/webhook-auth";

const logger = createLogger("FeishuAdapter");

interface FeishuTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

type FeishuMessageEvent = {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type?: string;
  };
};

function normalizeJsonBody(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end >= start) {
    return value.slice(start, end + 1);
  }
  return value;
}

function parseMaybeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function createError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function resolveRequestPath(req: http.IncomingMessage): string {
  const url = req.url || "/";
  try {
    return new URL(url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    return url;
  }
}

function parseFeishuContent(content: string | undefined): string {
  if (!content) return "";
  const parsed = parseMaybeJson<Record<string, unknown>>(content);
  if (!parsed) return content;
  const text = parsed.text;
  if (typeof text === "string") return text;
  if (typeof parsed.content === "string") return parsed.content;
  return content;
}

function decryptFeishuPayload(encrypt: string, encryptKey: string): string {
  const encrypted = Buffer.from(encrypt, "base64");
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const iv = encrypted.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted.subarray(16), undefined, "utf8");
  decrypted += decipher.final("utf8");
  return normalizeJsonBody(decrypted);
}

function computeFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  rawBody: string,
): string {
  return crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest("hex");
}

export class FeishuAdapter implements ChannelAdapter {
  readonly type = "feishu" as const;

  private server: http.Server | null = null;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private processedMessages: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private config: FeishuConfig;
  private tenantAccessToken: string | null = null;
  private tenantAccessTokenExpiresAt = 0;

  constructor(config: FeishuConfig) {
    this.config = {
      webhookPort: 3980,
      webhookPath: "/feishu/webhook",
      deduplicationEnabled: true,
      ...config,
    };
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this._botUsername;
  }

  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") {
      return;
    }

    this.setStatus("connecting");
    try {
      await this.getTenantAccessToken();
      this._botUsername = this.config.displayName || "Feishu Bot";
      await this.startServer();
      this.startCleanupLoop();
      this.setStatus("connected");
      logger.info(`Connected on port ${this.config.webhookPort}`);
    } catch (error) {
      const err = createError(error);
      this.setStatus("error", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.processedMessages.clear();
    this.tenantAccessToken = null;
    this.tenantAccessTokenExpiresAt = 0;

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }

    this.setStatus("disconnected");
  }

  async sendMessage(message: OutgoingMessage): Promise<string> {
    const token = await this.getTenantAccessToken();
    const text = this.config.responsePrefix
      ? `${this.config.responsePrefix} ${message.text}`.trim()
      : message.text;
    const response = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: message.chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );

    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    };
    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || `Feishu send failed (${response.status})`);
    }
    return payload.data?.message_id || `feishu-${Date.now()}`;
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

  updateConfig(config: FeishuConfig): void {
    this.config = { ...this.config, ...config };
  }

  async getInfo(): Promise<ChannelInfo> {
    return {
      type: "feishu",
      status: this._status,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
      extra: {
        webhookPort: this.config.webhookPort,
        webhookPath: this.config.webhookPath,
      },
    };
  }

  private async startServer(): Promise<void> {
    const port = this.config.webhookPort || 3980;
    const webhookPath = this.config.webhookPath || "/feishu/webhook";

    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const requestPath = resolveRequestPath(req);
        if (req.method === "GET" && requestPath === "/feishu/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: this._status, bot: this._botUsername }));
          return;
        }

        if (req.method !== "POST" || requestPath !== webhookPath) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        try {
          const rawBody = await readRequestBody(req);
          const payload = this.parseAndVerifyPayload(req, rawBody);
          const payloadEvent =
            typeof payload.event === "object" && payload.event
              ? (payload.event as Record<string, unknown>)
              : null;

          const challenge =
            typeof payload.challenge === "string"
              ? payload.challenge
              : typeof payloadEvent?.challenge === "string"
                ? payloadEvent.challenge
                : null;
          if (challenge) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ challenge }));
            return;
          }

          await this.handleIncomingPayload(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0 }));
        } catch (error) {
          const err = createError(error);
          this.handleError(err, "webhook");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 1, msg: err.message }));
        }
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use.`));
          return;
        }
        reject(error);
      });

      this.server.listen(port, () => resolve());
    });
  }

  private parseAndVerifyPayload(
    req: http.IncomingMessage,
    rawBody: string,
  ): Record<string, unknown> {
    const parsed = parseMaybeJson<Record<string, unknown>>(rawBody);
    if (!parsed) {
      throw new Error("Invalid Feishu payload");
    }

    if (this.config.encryptKey) {
      const timestamp = String(req.headers["x-lark-request-timestamp"] || "");
      const nonce = String(req.headers["x-lark-request-nonce"] || "");
      const signature = String(req.headers["x-lark-signature"] || "");
      if (!timestamp || !nonce || !signature) {
        throw new Error("Feishu signature headers are required");
      }
      const expected = computeFeishuSignature(timestamp, nonce, this.config.encryptKey, rawBody);
      if (!timingSafeEqualString(expected, signature)) {
        throw new Error("Feishu signature validation failed");
      }
    }

    const encrypted = parsed.encrypt;
    if (typeof encrypted === "string" && this.config.encryptKey) {
      const decrypted = decryptFeishuPayload(encrypted, this.config.encryptKey);
      const decryptedPayload = parseMaybeJson<Record<string, unknown>>(decrypted);
      if (!decryptedPayload) {
        throw new Error("Failed to parse decrypted Feishu payload");
      }
      return decryptedPayload;
    }

    const token =
      typeof parsed.token === "string"
        ? parsed.token
        : typeof parsed?.header === "object" &&
            parsed.header &&
            typeof (parsed.header as Record<string, unknown>).token === "string"
          ? ((parsed.header as Record<string, unknown>).token as string)
          : undefined;
    if (this.config.verificationToken) {
      if (!token) {
        throw new Error("Feishu verification token is required");
      }
      if (!timingSafeEqualString(token, this.config.verificationToken)) {
        throw new Error("Feishu verification token mismatch");
      }
    }

    return parsed;
  }

  private async handleIncomingPayload(payload: Record<string, unknown>): Promise<void> {
    const header =
      typeof payload.header === "object" && payload.header
        ? (payload.header as Record<string, unknown>)
        : undefined;
    const eventType =
      typeof header?.event_type === "string"
        ? header.event_type
        : typeof payload.type === "string"
          ? payload.type
          : "";

    if (!eventType.includes("message")) {
      return;
    }

    const event =
      typeof payload.event === "object" && payload.event
        ? (payload.event as FeishuMessageEvent)
        : (payload as FeishuMessageEvent);
    const message = event.message;
    if (!message?.message_id || !message.chat_id) {
      return;
    }

    const senderType = event.sender?.sender_type;
    if (senderType === "bot") {
      return;
    }

    if (this.config.deduplicationEnabled !== false && this.isDuplicate(message.message_id)) {
      return;
    }

    const userId =
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.union_id ||
      "unknown";
    const text = parseFeishuContent(message.content);
    if (!text.trim()) {
      return;
    }

    const incoming: IncomingMessage = {
      messageId: message.message_id,
      channel: "feishu",
      userId,
      userName: userId,
      chatId: message.chat_id,
      isGroup: message.chat_type === "group",
      text,
      timestamp: new Date(Number(message.create_time || Date.now())),
      raw: payload,
      metadata: {
        eventType,
        chatType: message.chat_type,
        messageType: message.message_type,
      },
    };

    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantAccessToken && Date.now() < this.tenantAccessTokenExpiresAt - 60_000) {
      return this.tenantAccessToken;
    }

    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const payload = (await response.json()) as FeishuTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(payload.msg || `Feishu auth failed (${response.status})`);
    }

    this.tenantAccessToken = payload.tenant_access_token;
    this.tenantAccessTokenExpiresAt = Date.now() + (payload.expire || 7200) * 1000;
    return payload.tenant_access_token;
  }

  private isDuplicate(messageId: string): boolean {
    const existing = this.processedMessages.get(messageId);
    if (existing && Date.now() - existing < 60_000) {
      return true;
    }
    this.processedMessages.set(messageId, Date.now());
    return false;
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const [messageId, seenAt] of this.processedMessages.entries()) {
        if (seenAt < cutoff) {
          this.processedMessages.delete(messageId);
        }
      }
    }, 60_000);
  }

  private setStatus(status: ChannelStatus, error?: Error): void {
    this._status = status;
    for (const handler of this.statusHandlers) {
      handler(status, error);
    }
  }

  private handleError(error: Error, context?: string): void {
    for (const handler of this.errorHandlers) {
      handler(error, context);
    }
    logger.error(error.message, context);
  }
}

export function createFeishuAdapter(config: FeishuConfig): FeishuAdapter {
  return new FeishuAdapter(config);
}
