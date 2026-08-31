import type { ChannelType } from "./channels/types";
import { getCanonicalRemoteCommand } from "./remote-command-registry";

export type RemoteCommandNormalizationSource = "plain" | "slash" | "natural";

export interface RemoteCommandNormalizationResult {
  text: string;
  source: RemoteCommandNormalizationSource;
  canonicalCommand?: string;
}

export function normalizeRemoteIncomingCommand(input: {
  channelType: ChannelType;
  text: string;
  naturalCommandText?: string | null;
}): RemoteCommandNormalizationResult {
  const trimmed = String(input.text || "").trim();
  if (!trimmed) {
    return { text: "", source: "plain" };
  }

  if (input.naturalCommandText) {
    return normalizeSlashText(input.naturalCommandText, "natural");
  }

  if (trimmed.startsWith("/")) {
    return normalizeSlashText(trimmed, "slash");
  }

  return { text: trimmed, source: "plain" };
}

function normalizeSlashText(
  text: string,
  source: RemoteCommandNormalizationSource,
): RemoteCommandNormalizationResult {
  const trimmed = String(text || "").trim();
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const canonicalCommand = getCanonicalRemoteCommand(rawCommand);
  if (!canonicalCommand) {
    return { text: trimmed, source };
  }

  return {
    text: [canonicalCommand, ...args].join(" ").trim(),
    source,
    canonicalCommand,
  };
}
