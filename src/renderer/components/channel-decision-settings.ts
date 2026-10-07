import type { ChannelData } from "../../shared/types";
import { validateGatewayOwnerIds } from "../../shared/gateway-owner-ids";

export type DecisionSettingsChannel = Pick<
  ChannelData,
  "id" | "type" | "config" | "configReadError"
>;

/** Configuration only; runtime owner/transport/request checks remain authoritative. */
export function channelDecisionEnableError(channel: DecisionSettingsChannel): string | undefined {
  if (channel.type !== "slack" && channel.type !== "teams")
    return "Decision cards are available for Slack and Teams.";
  if (channel.configReadError)
    return "Repair this channel's configuration before enabling decision cards.";
  const owners = channel.config?.ownerUserIds;
  const result = Array.isArray(owners) ? validateGatewayOwnerIds(owners) : undefined;
  if (!result?.ok || result.ids.length === 0)
    return "Save your own account ID under Your Account on This Channel first.";
  return undefined;
}

export async function saveChannelDecisionSetting(
  channel: DecisionSettingsChannel,
  enabled: boolean,
  update: (request: {
    id: string;
    config: { decisionMessagesEnabled: boolean };
  }) => Promise<unknown>,
): Promise<void> {
  if (enabled) {
    const error = channelDecisionEnableError(channel);
    if (error) throw new Error(error);
  }
  await update({ id: channel.id, config: { decisionMessagesEnabled: enabled } });
}
