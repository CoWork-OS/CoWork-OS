import type {
  ChannelAdapter,
  ChannelType,
  MessageAttachment,
  OutgoingMessage,
} from "./channels/types";

export interface ChannelDeliveryRecord {
  id: string;
}

export interface ChannelDeliveryServiceDeps {
  getAdapter(channelType: ChannelType, channelId?: string): ChannelAdapter | undefined;
  getChannel(channelType: ChannelType, channelId?: string): ChannelDeliveryRecord | undefined;
  cleanupIdempotencyCache(): void;
  getIdempotencyCacheKey(
    channelType: ChannelType,
    message: OutgoingMessage,
    channelId?: string,
  ): string | null;
  getCachedIdempotentMessage(cacheKey: string): { messageId: string } | undefined;
  setCachedIdempotentMessage(cacheKey: string, messageId: string): void;
  sendRawMessage(adapter: ChannelAdapter, message: OutgoingMessage): Promise<string>;
  logOutgoingMessage(input: {
    channelId: string;
    channelMessageId: string;
    chatId: string;
    content: string;
    attachments?: MessageAttachment[];
  }): void;
  emitMessageSent(input: { channelType: ChannelType; chatId: string; messageId: string }): void;
  warn(message: string, error: unknown): void;
}

export class ChannelDeliveryService {
  constructor(private readonly deps: ChannelDeliveryServiceDeps) {}

  async sendMessage(
    channelType: ChannelType,
    message: OutgoingMessage,
    channelId?: string,
  ): Promise<string> {
    this.deps.cleanupIdempotencyCache();
    const cacheKey = this.deps.getIdempotencyCacheKey(channelType, message, channelId);
    if (cacheKey) {
      const existing = this.deps.getCachedIdempotentMessage(cacheKey);
      if (existing) {
        return existing.messageId;
      }
    }

    const adapter = this.deps.getAdapter(channelType, channelId);
    if (!adapter) {
      const suffix = channelId ? ` (channel ${channelId})` : "";
      throw new Error(`No adapter registered for channel type: ${channelType}${suffix}`);
    }

    if (adapter.status !== "connected") {
      throw new Error(`Adapter ${channelType} is not connected`);
    }

    const messageId = await this.deps.sendRawMessage(adapter, message);
    if (cacheKey) {
      this.deps.setCachedIdempotentMessage(cacheKey, messageId);
    }

    try {
      const channel = this.deps.getChannel(channelType, channelId);
      if (channel) {
        this.deps.logOutgoingMessage({
          channelId: channel.id,
          channelMessageId: messageId,
          chatId: message.chatId,
          content: message.text,
          attachments: message.attachments,
        });
        this.deps.emitMessageSent({
          channelType,
          chatId: message.chatId,
          messageId,
        });
      }
    } catch (logError) {
      this.deps.warn(
        `[ChannelDeliveryService] Failed to log outgoing message (${channelType}):`,
        logError,
      );
    }

    return messageId;
  }
}
