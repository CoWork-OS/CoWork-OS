import { XSettingsManager } from "../../settings/x-manager";
import { runBirdCommand } from "../../utils/x-cli";
import { fetchMentionsWithRetry } from "../../x-mentions/fetch";
import {
  buildMentionTaskPrompt,
  parseBirdMentions,
  parseMentionTriggerCommand,
  sortMentionsOldestFirst,
  type ParsedMentionCommand,
} from "../../x-mentions/parser";
import { getXMentionTriggerStatusStore } from "../../x-mentions/status";
import {
  ChannelAdapter,
  ChannelInfo,
  ChannelStatus,
  ErrorHandler,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  StatusHandler,
  XConfig,
} from "./types";

type XMentionCommandResult = { taskId?: string } | void;
type XMentionCommandHandler = (mention: ParsedMentionCommand) => Promise<XMentionCommandResult>;

export interface XAdapterConfig extends XConfig {
  onMentionCommand?: XMentionCommandHandler;
}

export class XAdapter implements ChannelAdapter {
  readonly type = "x" as const;

  private _status: ChannelStatus = "disconnected";
  private messageHandler?: MessageHandler;
  private errorHandler?: ErrorHandler;
  private statusHandler?: StatusHandler;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private running = false;
  private botHandle?: string;
  private seenTweetIds: string[] = [];
  private seenTweetIdSet = new Set<string>();
  private readonly maxSeenTweetIds = 2000;
  private readonly statusStore = getXMentionTriggerStatusStore();

  constructor(private config: XAdapterConfig) {}

  get status(): ChannelStatus {
    return this._status;
  }

  get botUsername(): string | undefined {
    return this.botHandle;
  }

  updateConfig(config: XConfig): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.running) return;
    this.setStatus("connecting");

    try {
      const settings = XSettingsManager.loadSettings();
      if (!settings.enabled) {
        throw new Error("X integration is disabled in Settings > X");
      }

      const whoami = await runBirdCommand(settings, ["whoami"], { json: true });
      const payload = (whoami.data && typeof whoami.data === "object" ? whoami.data : null) as
        | { username?: string; user?: string; handle?: string }
        | null;
      this.botHandle =
        payload?.username || payload?.user || payload?.handle || this.extractHandle(whoami.stdout);

      this.running = true;
      this.statusStore.setMode("native", true);
      this.schedulePoll(0);
      this.setStatus("connected");
    } catch (error) {
      this.running = false;
      this.setStatus("error", this.toError(error));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.statusStore.setMode("disabled", false);
    this.setStatus("disconnected");
  }

  async sendMessage(message: OutgoingMessage): Promise<string> {
    const settings = XSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error("X integration is disabled in Settings > X");
    }

    if (this.config.outboundEnabled !== true) {
      return `x-suppressed-${Date.now()}`;
    }

    const text = String(message.text || "").trim();
    if (!text) {
      throw new Error("Cannot send an empty X message");
    }

    let args: string[];
    if (message.replyTo && message.replyTo.trim()) {
      args = ["reply", message.replyTo.trim(), text];
    } else {
      args = ["tweet", text];
    }

    const result = await runBirdCommand(settings, args, { json: true });
    const id = this.extractTweetId(result.data, result.stdout);
    return id || `x-${Date.now()}`;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  onStatusChange(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  async getInfo(): Promise<ChannelInfo> {
    return {
      type: this.type,
      status: this.status,
      botUsername: this.botHandle,
      extra: {
        outboundEnabled: this.config.outboundEnabled === true,
      },
    };
  }

  private setStatus(status: ChannelStatus, error?: Error): void {
    this._status = status;
    this.statusHandler?.(status, error);
    if (status === "error" && error) {
      this.errorHandler?.(error, "status");
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollTimer = setTimeout(() => {
      void this.pollOnce();
    }, Math.max(0, delayMs));
  }

  private getPollIntervalMs(): number {
    const configured = Number(this.config.pollIntervalSec);
    if (Number.isFinite(configured) && configured >= 30) {
      return configured * 1000;
    }
    const settings = XSettingsManager.loadSettings();
    return Math.max(30, settings.mentionTrigger.pollIntervalSec || 120) * 1000;
  }

  private getFetchCount(): number {
    const configured = Number(this.config.fetchCount);
    if (Number.isFinite(configured) && configured >= 1) {
      return Math.min(200, Math.floor(configured));
    }
    const settings = XSettingsManager.loadSettings();
    return Math.max(1, Math.min(200, settings.mentionTrigger.fetchCount || 25));
  }

  private resolveTriggerSettings() {
    const settings = XSettingsManager.loadSettings();
    const mentionTrigger = settings.mentionTrigger;
    return {
      enabled: true,
      commandPrefix: this.config.commandPrefix || mentionTrigger.commandPrefix || "do:",
      allowedAuthors:
        Array.isArray(this.config.allowedAuthors) && this.config.allowedAuthors.length > 0
          ? this.config.allowedAuthors
          : mentionTrigger.allowedAuthors,
      pollIntervalSec: this.config.pollIntervalSec || mentionTrigger.pollIntervalSec || 120,
      fetchCount: this.getFetchCount(),
      workspaceMode: "temporary" as const,
    };
  }

  private rememberTweetId(tweetId: string): boolean {
    const normalized = String(tweetId || "").trim();
    if (!normalized) return false;
    if (this.seenTweetIdSet.has(normalized)) return false;
    this.seenTweetIds.push(normalized);
    this.seenTweetIdSet.add(normalized);
    if (this.seenTweetIds.length > this.maxSeenTweetIds) {
      const removed = this.seenTweetIds.shift();
      if (removed) {
        this.seenTweetIdSet.delete(removed);
      }
    }
    return true;
  }

  private hasSeenTweetId(tweetId: string): boolean {
    const normalized = String(tweetId || "").trim();
    if (!normalized) return false;
    return this.seenTweetIdSet.has(normalized);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    if (this.pollInFlight) {
      this.schedulePoll(this.getPollIntervalMs());
      return;
    }

    this.pollInFlight = true;
    try {
      const settings = XSettingsManager.loadSettings();
      if (!settings.enabled || !settings.mentionTrigger?.enabled) {
        this.statusStore.setMode("disabled", false);
        return;
      }

      const trigger = this.resolveTriggerSettings();
      this.statusStore.setMode("native", true);
      this.statusStore.markPoll();

      const result = await fetchMentionsWithRetry(settings, trigger.fetchCount);
      if (result.jsonFallbackUsed) {
        throw new Error("bird mentions requires JSON support. Upgrade bird CLI to a newer version.");
      }
      const mentions = sortMentionsOldestFirst(parseBirdMentions(result.data ?? result.stdout));

      for (const mention of mentions) {
        const tweetId = String(mention.tweetId || "").trim();
        if (this.hasSeenTweetId(tweetId)) {
          continue;
        }

        const parsed = parseMentionTriggerCommand(mention, trigger);
        if (!parsed.accepted || !parsed.mention) {
          this.statusStore.incrementIgnored();
          continue;
        }

        let taskId: string | undefined;
        try {
          if (this.config.onMentionCommand) {
            const handled = await this.config.onMentionCommand(parsed.mention);
            taskId =
              handled && typeof handled === "object" && typeof handled.taskId === "string"
                ? handled.taskId
                : undefined;
          }
          if (taskId) {
            this.statusStore.setLastTaskId(taskId);
          }

          const inbound: IncomingMessage = {
            messageId: `x-${parsed.mention.tweetId}`,
            channel: "x",
            userId: parsed.mention.author,
            userName: `@${parsed.mention.author}`,
            chatId: parsed.mention.conversationId || parsed.mention.tweetId,
            text: buildMentionTaskPrompt(parsed.mention),
            timestamp: new Date(parsed.mention.timestamp),
            ingestOnly: true,
            metadata: {
              tweetId: parsed.mention.tweetId,
              conversationId: parsed.mention.conversationId,
              tweetUrl: parsed.mention.url,
              fullText: parsed.mention.text,
              extractedCommand: parsed.mention.command,
            },
            raw: parsed.mention.raw,
          };
          if (this.messageHandler) {
            await this.messageHandler(inbound);
          }

          this.rememberTweetId(parsed.mention.tweetId);
          this.statusStore.incrementAccepted();
        } catch (error) {
          const err = this.toError(error);
          this.statusStore.markError(err.message);
          this.errorHandler?.(err, "mention");
        }
      }

      this.statusStore.markSuccess();
    } catch (error) {
      const err = this.toError(error);
      this.statusStore.markError(err.message);
      this.errorHandler?.(err, "poll");
    } finally {
      this.pollInFlight = false;
      this.schedulePoll(this.getPollIntervalMs());
    }
  }

  private extractHandle(stdout?: string): string | undefined {
    const value = String(stdout || "");
    const match = value.match(/@([A-Za-z0-9_]{1,15})/);
    return match ? match[1] : undefined;
  }

  private extractTweetId(data: unknown, stdout?: string): string | undefined {
    const payload =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const fromPayload = payload
      ? [payload.id, payload.tweetId, payload.tweet_id]
          .map((value) => (value === undefined ? "" : String(value).trim()))
          .find((value) => value.length > 0)
      : undefined;
    if (fromPayload) return fromPayload;

    const text = String(stdout || "");
    const match = text.match(/\/status\/(\d{5,})/);
    return match ? match[1] : undefined;
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}

export function createXAdapter(config: XAdapterConfig): XAdapter {
  return new XAdapter(config);
}
