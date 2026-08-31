/**
 * Research chat routing logic.
 * When a message comes from a designated research chat (Telegram/WhatsApp),
 * we rewrite the message text and optionally set the agent role.
 */

import type { ChannelType } from "./channels/types";

export interface ResearchRoutingResult {
  text: string;
  agentRoleId?: string;
  /** When true, task creation should merge `researchWorkflow: { enabled: true }` into agentConfig */
  researchWorkflowPreset?: boolean;
}

/**
 * Determines if research chat routing should apply and returns the new message text
 * and optional agent role ID.
 *
 * @returns Result to apply, or null if no routing change
 */
export function applyResearchChatRouting(params: {
  channelType: ChannelType;
  channelConfig: Record<string, unknown>;
  chatId: string;
  originalText: string;
  currentAgentRoleId?: string;
  roleExists: (id: string) => boolean;
}): ResearchRoutingResult | null {
  const { channelType, channelConfig, chatId, originalText, currentAgentRoleId, roleExists } =
    params;

  if (channelType !== "telegram" && channelType !== "whatsapp") {
    return null;
  }
  if (currentAgentRoleId !== undefined) {
    return null;
  }

  const researchChatIds = channelConfig.researchChatIds as string[] | undefined;
  const researchAgentRoleId = channelConfig.researchAgentRoleId as string | undefined;

  if (
    !Array.isArray(researchChatIds) ||
    researchChatIds.length === 0 ||
    !researchChatIds.includes(chatId)
  ) {
    return null;
  }

  const roleId =
    typeof researchAgentRoleId === "string" && researchAgentRoleId.trim()
      ? researchAgentRoleId
      : typeof channelConfig.defaultAgentRoleId === "string"
        ? channelConfig.defaultAgentRoleId
        : undefined;

  const agentRoleId = roleId && roleExists(roleId) ? roleId : undefined;

  // Allow per-channel customisation of the prompt template via `researchPromptTemplate`.
  // Use `{message}` as the placeholder for the original message text.
  // Falls back to the built-in default when not configured.
  const DEFAULT_RESEARCH_TEMPLATE =
    "Research the following links and build a findings report with classification: {message}";
  const rawTemplate =
    typeof channelConfig.researchPromptTemplate === "string" &&
    channelConfig.researchPromptTemplate.trim()
      ? channelConfig.researchPromptTemplate
      : DEFAULT_RESEARCH_TEMPLATE;
  const text = rawTemplate.replace("{message}", originalText);

  return {
    text,
    agentRoleId,
    researchWorkflowPreset: true,
  };
}
