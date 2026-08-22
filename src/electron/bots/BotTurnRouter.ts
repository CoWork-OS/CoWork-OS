import type { BotSendMessageRequest, BotTurnMode, ManagedAgentVersion } from "../../shared/types";
import { analyzeInstructionIntent } from "../agent/step-contract";

export interface BotTurnRoute {
  mode: BotTurnMode;
  reason: string;
  confidence: "deterministic" | "inferred";
}

const DIRECT_RESPONSE_RE =
  /\b(?:reply|respond|answer)\s+(?:to\s+me\s+)?(?:exactly|only)|\b(?:do not|don't|never)\s+(?:use|call)\s+(?:any\s+)?tools?\b|\b(?:no|without)\s+(?:tools?|delegation|agents?)\b|\bjust\s+(?:answer|reply|respond|explain|summarize)\b/i;
const TEAM_RE =
  /\b(?:delegate|parallel(?:ize)?|multiple\s+(?:agents?|specialists?)|two\s+(?:agents?|specialists?)|team\s+of\s+agents?|ask\s+\w+\s+(?:agents?|specialists?)|independent\s+reviewers?)\b/i;
const ACTION_RE =
  /\b(?:create|write|edit|modify|update|delete|rename|move|save|export|build|implement|fix|run|execute|install|deploy|publish|send|email|purchase|buy|book|schedule|cancel|upload|download|research\s+(?:the\s+)?(?:latest|current)|look\s+up|browse|search\s+(?:the\s+)?(?:web|internet)|monitor|watch)\b/i;
const LIVE_RE = /\b(?:latest|current|today|tonight|right\s+now|live|upcoming|price|weather|score)\b/i;
const TEXT_RESPONSE_RE = /\b(?:answer|explain|summarize|rewrite|rephrase|draft|compose|write|brainstorm)\b/i;
const EXTERNAL_OUTPUT_RE =
  /\b(?:file|folder|directory|workspace|repository|repo|document|spreadsheet|presentation|slides?|pdf|docx|xlsx|pptx|deploy|publish|send|email|upload|download|install|command|terminal)\b|\.[a-z0-9]{1,8}\b/i;

export function routeBotTurn(
  request: Pick<BotSendMessageRequest, "body" | "turnMode">,
  version?: Pick<ManagedAgentVersion, "executionMode">,
): BotTurnRoute {
  if (request.turnMode && request.turnMode !== "auto") {
    return { mode: request.turnMode, reason: "explicit_turn_mode", confidence: "deterministic" };
  }
  const body = String(request.body || "").trim();
  if (
    DIRECT_RESPONSE_RE.test(body) &&
    !ACTION_RE.test(analyzeInstructionIntent(body).positiveText.replace(DIRECT_RESPONSE_RE, ""))
  ) {
    return { mode: "conversation", reason: "explicit_direct_response", confidence: "deterministic" };
  }
  if (TEAM_RE.test(body) && version?.executionMode === "team") {
    return { mode: "team_task", reason: "explicit_team_work", confidence: "deterministic" };
  }
  if (TEXT_RESPONSE_RE.test(body) && !EXTERNAL_OUTPUT_RE.test(body) && !LIVE_RE.test(body)) {
    return { mode: "conversation", reason: "text_response_only", confidence: "deterministic" };
  }
  if (ACTION_RE.test(body) || LIVE_RE.test(body)) {
    return {
      mode: version?.executionMode === "team" ? "team_task" : "task",
      reason: "action_or_live_work",
      confidence: "inferred",
    };
  }
  return { mode: "conversation", reason: "conversational_default", confidence: "inferred" };
}
