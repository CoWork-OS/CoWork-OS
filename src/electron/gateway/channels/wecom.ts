import * as crypto from "crypto";
import * as http from "http";
import {
  ChannelAdapter,
  ChannelInfo,
  ChannelStatus,
  ErrorHandler,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  StatusHandler,
  WeComConfig,
} from "./types";
import { createLogger } from "../../utils/logger";

const logger = createLogger("WeComAdapter");

interface WeComTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface WeComSendResponse {
  errcode?: number;
  errmsg?: string;
  msgid?: string;
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

function resolveRequestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function xmlValue(xml: string, tag: string): string | undefined {
  const cdataPattern = new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, "s");
  const plainPattern = new RegExp(`<${tag}>(.*?)<\\/${tag}>`, "s");
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch?.[1] !== undefined) return cdataMatch[1];
  const plainMatch = xml.match(plainPattern);
  return plainMatch?.[1];
}

function computeWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return crypto
    .createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

function removePkcs7Padding(buffer: Buffer): Buffer {
  const padding = buffer[buffer.length - 1];
  if (padding <= 0 || padding > 32) {
    return buffer;
  }
  return buffer.subarray(0, buffer.length - padding);
}

function decryptWeComMessage(
  encryptedBase64: string,
  encodingAESKey: string,
  corpId: string,
): string {
  const aesKey = Buffer.from(`${encodingAESKey}=`, "base64");
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const unpadded = removePkcs7Padding(decrypted);
  const content = unpadded.subarray(16);
  const xmlLength = content.readUInt32BE(0);
  const xml = content.subarray(4, 4 + xmlLength).toString("utf8");
  const receiveId = content.subarray(4 + xmlLength).toString("utf8");
  if (receiveId !== corpId) {
    throw new Error("WeCom receive ID mismatch");
  }
  return xml;
}

function detectWeComTarget(chatId: string): { touser?: string; toparty?: string; totag?: string } {
  if (chatId.startsWith("party:")) {
    return { toparty: chatId.slice("party:".length) };
  }
  if (chatId.startsWith("tag:")) {
    return { totag: chatId.slice("tag:".length) };
  }
  return { touser: chatId || "@all" };
}

export class WeComAdapter implements ChannelAdapter {
  readonly type = "wecom" as const;

  private server: http.Server | null = null;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private processedMessages: Map<string, number> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _status: ChannelStatus = "disconnected";
  private _botUsername?: string;
  private config: WeComConfig;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(config: WeComConfig) {
    this.config = {
      webhookPort: 3981,
      webhookPath: "/wecom/webhook",
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
      await this.getAccessToken();
      this._botUsername = this.config.displayName || "WeCom Bot";
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
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;

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
    const token = await this.getAccessToken();
    const text = this.config.responsePrefix
      ? `${this.config.responsePrefix} ${message.text}`.trim()
      : message.text;
    const target = detectWeComTarget(message.chatId);
    const response = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          ...target,
          msgtype: "text",
          agentid: this.config.agentId,
          text: { content: text },
          safe: 0,
        }),
      },
    );

    const payload = (await response.json()) as WeComSendResponse;
    if (!response.ok || payload.errcode !== 0) {
      throw new Error(payload.errmsg || `WeCom send failed (${response.status})`);
    }
    return payload.msgid || `wecom-${Date.now()}`;
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

  updateConfig(config: WeComConfig): void {
    this.config = { ...this.config, ...config };
  }

  async getInfo(): Promise<ChannelInfo> {
    return {
      type: "wecom",
      status: this._status,
      botUsername: this._botUsername,
      botDisplayName: this._botUsername,
      extra: {
        corpId: this.config.corpId,
        agentId: this.config.agentId,
        webhookPort: this.config.webhookPort,
        webhookPath: this.config.webhookPath,
      },
    };
  }

  private async startServer(): Promise<void> {
    const port = this.config.webhookPort || 3981;
    const webhookPath = this.config.webhookPath || "/wecom/webhook";

    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = resolveRequestUrl(req);
        if (req.method === "GET" && url.pathname === "/wecom/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: this._status, bot: this._botUsername }));
          return;
        }

        if (url.pathname !== webhookPath) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        try {
          if (req.method === "GET") {
            const echo = this.verifyUrl(url);
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(echo);
            return;
          }

          if (req.method !== "POST") {
            res.writeHead(405);
            res.end("Method Not Allowed");
            return;
          }

          const rawBody = await readRequestBody(req);
          const xml = this.parseIncomingXml(url, rawBody);
          await this.handleIncomingXml(xml);
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("success");
        } catch (error) {
          const err = createError(error);
          this.handleError(err, "webhook");
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(err.message);
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

  private verifyUrl(url: URL): string {
    const signature = url.searchParams.get("msg_signature") || "";
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const echostr = url.searchParams.get("echostr") || "";

    if (!signature || !timestamp || !nonce || !echostr) {
      throw new Error("Missing WeCom verification parameters");
    }

    const expected = computeWeComSignature(this.config.token, timestamp, nonce, echostr);
    if (expected !== signature) {
      throw new Error("WeCom signature validation failed");
    }

    if (this.config.encodingAESKey) {
      return decryptWeComMessage(echostr, this.config.encodingAESKey, this.config.corpId);
    }
    return echostr;
  }

  private parseIncomingXml(url: URL, rawBody: string): string {
    if (!this.config.encodingAESKey) {
      return rawBody;
    }

    const signature = url.searchParams.get("msg_signature") || "";
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const encrypted = xmlValue(rawBody, "Encrypt") || "";
    if (!signature || !timestamp || !nonce || !encrypted) {
      throw new Error("Incomplete encrypted WeCom callback");
    }

    const expected = computeWeComSignature(this.config.token, timestamp, nonce, encrypted);
    if (expected !== signature) {
      throw new Error("WeCom signature validation failed");
    }

    return decryptWeComMessage(encrypted, this.config.encodingAESKey, this.config.corpId);
  }

  private async handleIncomingXml(xml: string): Promise<void> {
    const msgType = xmlValue(xml, "MsgType");
    if (msgType !== "text") {
      return;
    }

    const messageId = xmlValue(xml, "MsgId") || xmlValue(xml, "CreateTime") || `${Date.now()}`;
    if (this.config.deduplicationEnabled !== false && this.isDuplicate(messageId)) {
      return;
    }

    const userId = xmlValue(xml, "FromUserName") || "unknown";
    const chatId = xmlValue(xml, "ChatId") || userId;
    const text = (xmlValue(xml, "Content") || "").trim();
    if (!text) {
      return;
    }

    const incoming: IncomingMessage = {
      messageId,
      channel: "wecom",
      userId,
      userName: userId,
      chatId,
      isGroup: Boolean(xmlValue(xml, "ChatId")),
      text,
      timestamp: new Date(Number(xmlValue(xml, "CreateTime") || Date.now()) * 1000),
      raw: xml,
      metadata: {
        msgType,
        agentId: xmlValue(xml, "AgentID"),
        toUserName: xmlValue(xml, "ToUserName"),
      },
    };

    for (const handler of this.messageHandlers) {
      await handler(incoming);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const url =
      "https://qyapi.weixin.qq.com/cgi-bin/gettoken" +
      `?corpid=${encodeURIComponent(this.config.corpId)}` +
      `&corpsecret=${encodeURIComponent(this.config.secret)}`;
    const response = await fetch(url);
    const payload = (await response.json()) as WeComTokenResponse;
    if (!response.ok || payload.errcode !== 0 || !payload.access_token) {
      throw new Error(payload.errmsg || `WeCom auth failed (${response.status})`);
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in || 7200) * 1000;
    return payload.access_token;
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

export function createWeComAdapter(config: WeComConfig): WeComAdapter {
  return new WeComAdapter(config);
}
