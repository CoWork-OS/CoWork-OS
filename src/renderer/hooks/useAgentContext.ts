import { useState, useEffect, useCallback, useMemo } from "react";
import {
  PersonalityId,
  PersonaId,
  EmojiUsage,
  PersonalityQuirks,
  DEFAULT_QUIRKS,
  DEFAULT_RESPONSE_STYLE,
} from "../../shared/types";
import {
  getMessage,
  getRandomPlaceholder,
  getUiCopy,
  type MessageKey,
  type UiCopyKey,
  type AgentMessageContext,
} from "../utils/agentMessages";

/**
 * Agent context returned by the hook
 */
export interface AgentContext {
  // Core identity
  agentName: string;
  userName?: string;
  personality: PersonalityId;
  persona?: PersonaId;

  // Style settings
  emojiUsage: EmojiUsage;
  quirks: PersonalityQuirks;

  // Loading state
  isLoading: boolean;

  // Helper methods
  getMessage: (key: MessageKey, detail?: string) => string;
  getPlaceholder: () => string;
  getUiCopy: (key: UiCopyKey, replacements?: Record<string, string | number>) => string;
  formatWithNames: (template: string) => string;

  // Refresh settings
  refresh: () => Promise<void>;
}

/**
 * Hook that provides unified access to agent personality context
 */
export function useAgentContext(): AgentContext {
  const [agentName, setAgentName] = useState("CoWork");
  const [userName, setUserName] = useState<string | undefined>(undefined);
  const [personality, setPersonality] = useState<PersonalityId>("professional");
  const [persona, setPersona] = useState<PersonaId | undefined>(undefined);
  const [emojiUsage, setEmojiUsage] = useState<EmojiUsage>("minimal");
  const [quirks, setQuirks] = useState<PersonalityQuirks>(DEFAULT_QUIRKS);
  const [isLoading, setIsLoading] = useState(true);

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    try {
      setIsLoading(true);

      // Load from both appearance and personality settings
      const [appearanceSettings, personalitySettings] = await Promise.all([
        window.electronAPI.getAppearanceSettings(),
        window.electronAPI.getPersonalitySettings(),
      ]);

      // Agent name priority: personalitySettings > appearanceSettings > default
      const name = personalitySettings.agentName || appearanceSettings.assistantName || "CoWork";
      setAgentName(name);

      // User name from relationship
      setUserName(personalitySettings.relationship?.userName);

      // Personality settings
      setPersonality(personalitySettings.activePersonality || "professional");
      setPersona(personalitySettings.activePersona);
      setEmojiUsage(
        personalitySettings.responseStyle?.emojiUsage || DEFAULT_RESPONSE_STYLE.emojiUsage,
      );
      setQuirks(personalitySettings.quirks || DEFAULT_QUIRKS);
    } catch (error) {
      console.error("Failed to load agent context:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Pick up name changes made elsewhere (settings, calm agent setup).
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onPersonalitySettingsChanged?.(() => {
      void loadSettings();
    });
    return () => unsubscribe?.();
  }, [loadSettings]);

  // Build message context
  const messageContext = useMemo<AgentMessageContext>(
    () => ({
      agentName,
      userName,
      personality,
      persona,
      emojiUsage,
      quirks,
    }),
    [agentName, userName, personality, persona, emojiUsage, quirks],
  );

  // getMessage helper
  const getMessageFn = useCallback(
    (key: MessageKey, detail?: string) => getMessage(key, messageContext, detail),
    [messageContext],
  );

  const getUiCopyFn = useCallback(
    (key: UiCopyKey, replacements?: Record<string, string | number>) =>
      getUiCopy(key, messageContext, replacements),
    [messageContext],
  );

  // getPlaceholder helper
  const getPlaceholderFn = useCallback(
    () => getRandomPlaceholder(messageContext),
    [messageContext],
  );

  // formatWithNames helper - replaces {agentName} and {userName} in templates
  const formatWithNames = useCallback(
    (template: string) => {
      let result = template.replace(/{agentName}/g, agentName);
      if (userName) {
        result = result.replace(/{userName}/g, userName);
      } else {
        // Remove patterns like ", {userName}" or "{userName}, " if no userName
        result = result.replace(/,?\s*{userName}\s*,?/g, "");
      }
      return result;
    },
    [agentName, userName],
  );

  return useMemo(
    () => ({
      agentName,
      userName,
      personality,
      persona,
      emojiUsage,
      quirks,
      isLoading,
      getMessage: getMessageFn,
      getPlaceholder: getPlaceholderFn,
      getUiCopy: getUiCopyFn,
      formatWithNames,
      refresh: loadSettings,
    }),
    [
      agentName,
      userName,
      personality,
      persona,
      emojiUsage,
      quirks,
      isLoading,
      getMessageFn,
      getPlaceholderFn,
      getUiCopyFn,
      formatWithNames,
      loadSettings,
    ],
  );
}

export default useAgentContext;
