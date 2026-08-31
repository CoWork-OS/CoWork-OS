/**
 * Channel Live Fetch Provider
 *
 * Provides access to live channel API operations (e.g. Discord fetch_messages,
 * download_attachment) for agent tools. The gateway registers itself when
 * initialized and unregisters on shutdown.
 */

export interface ChannelLiveFetchGateway {
  fetchDiscordMessages(chatId: string, limit?: number): Promise<DiscordMessage[]>;
  downloadDiscordAttachment(
    chatId: string,
    messageId: string,
  ): Promise<DiscordDownloadedAttachment[]>;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; name: string };
  timestamp: string;
  attachments?: Array<{ url: string; fileName?: string; contentType?: string; size?: number }>;
}

export interface DiscordDownloadedAttachment {
  path: string;
  fileName: string;
  contentType?: string;
  size?: number;
}

let gatewayInstance: ChannelLiveFetchGateway | undefined;

export function registerChannelLiveFetchProvider(gateway: ChannelLiveFetchGateway): void {
  gatewayInstance = gateway;
}

export function unregisterChannelLiveFetchProvider(): void {
  gatewayInstance = undefined;
}

export function getChannelLiveFetchProvider(): ChannelLiveFetchGateway | undefined {
  return gatewayInstance;
}
