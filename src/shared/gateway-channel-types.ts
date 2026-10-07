/** Canonical gateway channel names, shared by runtime and renderer capability choices. */
export const CHANNEL_TYPES = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "imessage",
  "signal",
  "mattermost",
  "matrix",
  "twitch",
  "line",
  "bluebubbles",
  "email",
  "teams",
  "googlechat",
  "feishu",
  "wecom",
  "x",
  "whatsapp_cloud",
  "twilio_sms",
] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];
