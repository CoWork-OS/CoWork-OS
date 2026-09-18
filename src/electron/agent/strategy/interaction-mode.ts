import type { AgentConfig } from "../../../shared/types";
import {
  prepareInteractionMode,
  isChatActionShortcut,
  type InteractionModeSelection,
} from "../../../shared/interaction-mode";
import { IntentRouter } from "./IntentRouter";
import { TaskStrategyService } from "./TaskStrategyService";

export function prepareInteractionTurn(
  config: AgentConfig | undefined,
  selection: InteractionModeSelection,
  prompt: string,
): AgentConfig {
  if (isChatActionShortcut(selection, prompt)) {
    throw new Error("Switch to Smart before using action or skill shortcuts.");
  }
  const prepared = prepareInteractionMode(config, selection);
  // Explicit no-action language is a user restriction, even when filenames and
  // implementation vocabulary otherwise make the intent router choose execution.
  const proposalOnly =
    /\b(?:only|just)\s+(?:propose|plan|analy[sz]e|explain|review|suggest)\b|\b(?:do not|don't)\s+(?:implement|execute)(?:\s+(?:it|this|anything|the (?:plan|solution|changes)))?\s*(?:[.!;\n]|$)|\b(?:do not|don't)\s+(?:modify|change)\s+(?:any\s+)?files\b|\bwithout\s+(?:implementing|executing)(?:\s+(?:it|this|anything))?\s*(?:[.!;\n]|$)/i.test(
      prompt,
    );
  if (selection.mode === "smart" && !selection.executionOverride && proposalOnly) {
    prepared.executionMode = "plan";
    prepared.executionModeSource = "user";
    prepared.conversationMode = "task";
  }
  return prepared;
}

/** Resolve each interactive turn afresh, preserving explicit restrictions. */
export function resolveInteractionMode(
  config: AgentConfig | undefined,
  selection: InteractionModeSelection,
  prompt: string,
): AgentConfig {
  const prepared = prepareInteractionTurn(config, selection, prompt);
  const route = IntentRouter.route("", prompt);
  const strategy = TaskStrategyService.derive(route, prepared, { title: "", prompt });
  return {
    ...TaskStrategyService.applyToAgentConfig(prepared, strategy),
    taskIntent: route.intent,
  };
}
