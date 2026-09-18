import type { AgentConfig, ExecutionMode } from "./types";

export type AdvancedExecutionMode = Exclude<ExecutionMode, "chat">;
export type InteractionModeSelection =
  | { mode: "smart"; executionOverride?: AdvancedExecutionMode }
  | { mode: "chat" };

export function isChatActionShortcut(
  selection: InteractionModeSelection | undefined,
  prompt: string,
): boolean {
  return selection?.mode === "chat" && /^\/[a-z][\w-]*(?:\s|$)/i.test(prompt.trim());
}

/** Undefined deliberately preserves ambiguous legacy runtime behavior. */
export function getInteractionModeSelection(
  config?: AgentConfig,
): InteractionModeSelection | undefined {
  if (config?.interactionMode) return config.interactionMode;
  if (config?.executionModeSource === "user" && config.executionMode) {
    return config.executionMode === "chat"
      ? { mode: "chat" }
      : { mode: "smart", executionOverride: config.executionMode };
  }
  if (config?.executionMode === "chat" && !config.executionModeSource) return { mode: "chat" };
  if (config?.executionModeSource === "strategy" || config?.executionModeSource === "auto_promote")
    return { mode: "smart" };
  return undefined;
}

/** Clear previous routing decisions; policy and permission fields remain untouched. */
export function prepareInteractionMode(
  config: AgentConfig | undefined,
  selection: InteractionModeSelection,
): AgentConfig {
  const next = { ...config, interactionMode: selection };
  delete next.executionMode;
  delete next.executionModeSource;
  delete next.conversationMode;
  delete next.taskIntent;
  delete next.taskStrategySnapshot;
  if (selection.mode === "chat") {
    next.executionMode = "chat";
    next.executionModeSource = "user";
    next.conversationMode = "chat";
  } else if (selection.executionOverride) {
    next.executionMode = selection.executionOverride;
    next.executionModeSource = "user";
    next.conversationMode = "task";
  }
  return next;
}
