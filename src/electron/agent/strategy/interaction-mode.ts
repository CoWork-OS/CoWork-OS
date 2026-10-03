import type { AgentConfig } from "../../../shared/types";
import {
  prepareInteractionMode,
  isChatActionShortcut,
  type InteractionModeSelection,
} from "../../../shared/interaction-mode";
import { IntentRouter } from "./IntentRouter";
import { TaskStrategyService } from "./TaskStrategyService";

const PROPOSAL_ONLY_LEAD =
  /(?:^|[.!?;\n]\s*)(?:please\s+)?(?:only|just)\s+(?:propose|plan|analy[sz]e|explain|review|suggest)\b/i;
const NO_ACTION_PROHIBITION =
  /\b(?:do not|don['’]?t)\s+(?:implement|execute)(?:\s+(?:it|this|anything|the (?:plan|solution|changes)))?\s*(?:[.!;,\n]|$)|\bwithout\s+(?:implementing|executing)(?:\s+(?:it|this|anything))?\s*(?:[.!;\n]|$)/i;
// A file prohibition followed by a scope ("files in vendor/", "files outside
// src/forms", "files that are generated") protects other files only.
const UNSCOPED_FILE_PROHIBITION =
  /\b(?:do not|don['’]?t)\s+(?:modify|change)\s+(?:any\s+)?files\b(?!\s+(?:in|under|inside|within|outside|other\s+than|except|besides|beyond|apart\s+from|that|which|from|of|matching|named|like)\b)/i;
const NEGATED_CLAUSE =
  /\b(?:do not|don['’]?t|without)\b[^.!?;\n]*?(?=,?\s+(?:but|then|instead)\b|[.!?;\n]|$)/gi;
const IMPLEMENTATION_REQUEST =
  /(?:^|[.!?;:\n]\s*|\b(?:and|then|also|but|please)\s+)(?:please\s+)?(?:implement|fix|add|create|write|build|update|change|modify|edit|refactor|rename|remove|delete|migrate|install|deploy|generate|make|apply|patch|set\s+up|configure|replace|convert|upgrade)\b/i;

/**
 * Detect a request whose whole point is a proposal/explanation. The no-action
 * cue must restrict the entire request: once the prohibited actions are
 * removed, no implementation request may remain ("Write the migration, but
 * don't execute it" and "Implement X and just explain the tricky parts" still
 * ask for real work).
 */
function isProposalOnlyRequest(prompt: string): boolean {
  const text = String(prompt || "");
  const hasProposalCue =
    PROPOSAL_ONLY_LEAD.test(text) ||
    NO_ACTION_PROHIBITION.test(text) ||
    UNSCOPED_FILE_PROHIBITION.test(text);
  if (!hasProposalCue) return false;
  return !IMPLEMENTATION_REQUEST.test(text.replace(NEGATED_CLAUSE, " "));
}

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
  const proposalOnly = isProposalOnlyRequest(prompt);
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
