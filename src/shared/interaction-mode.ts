import type { AgentConfig, ExecutionMode } from "./types";

/**
 * Plan is the only runtime override a user can pin. Analyze, Debug and Verified are
 * strategies the runtime chooses under Do; stored selections that still name them fold
 * back to plain Do.
 */
export type AdvancedExecutionMode = "plan";
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
  if (config?.interactionMode) return foldLegacyOverride(config.interactionMode);
  if (config?.executionModeSource === "user" && config.executionMode) {
    if (config.executionMode === "chat") return { mode: "chat" };
    return config.executionMode === "plan"
      ? { mode: "smart", executionOverride: "plan" }
      : { mode: "smart" };
  }
  if (config?.executionMode === "chat" && !config.executionModeSource) return { mode: "chat" };
  if (config?.executionModeSource === "strategy" || config?.executionModeSource === "auto_promote")
    return { mode: "smart" };
  return undefined;
}

/** Saved sessions may still carry a folded override (analyze, debug, verified, execute). */
function foldLegacyOverride(selection: InteractionModeSelection): InteractionModeSelection {
  if (selection.mode !== "smart" || !selection.executionOverride) return selection;
  return (selection.executionOverride as ExecutionMode) === "plan"
    ? { mode: "smart", executionOverride: "plan" }
    : { mode: "smart" };
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
