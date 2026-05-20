import type { TaskEvent, ExecutionMode } from "../../../shared/types";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import { isVerificationStepDescription } from "../../../shared/plan-utils";
import { hasAssistantMediaDirective } from "../../utils/assistant-media-directives";
import {
  extractAttachmentNames,
  stripPptxBubbleContent,
  stripStrategyContextBlock,
} from "../utils/attachment-content";
import { deriveSlashCommandTaskTitle } from "../../utils/slash-command-title";
import { formatTimelineActivityLabel } from "../../../shared/timeline-v2";
import { TASK_TITLE_MAX_LENGTH, TITLE_ELLIPSIS_REGEX } from "./main-content-constants";

type Any = Record<string, any>;

// In non-verbose mode, hide verification noise (verification steps are still executed by the agent).
export const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message") {
    const message = typeof event.payload?.message === "string" ? event.payload.message : "";
    return event.payload?.internal === true && !hasAssistantMediaDirective(message);
  }

  if (
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_finished" ||
    effectiveType === "step_started" ||
    effectiveType === "step_completed"
  ) {
    return isVerificationStepDescription(event.payload?.step?.description);
  }

  // Verification events are shown on failure; success is kept quiet.
  if (effectiveType === "verification_started" || effectiveType === "verification_passed") {
    return true;
  }

  return false;
};

export const getAssistantStepDescription = (event: TaskEvent): string => {
  if (typeof event.payload?.stepDescription === "string") return event.payload.stepDescription;
  const step = event.payload?.step;
  if (step && typeof step === "object" && typeof (step as Record<string, unknown>).description === "string") {
    return (step as Record<string, string>).description;
  }
  return "";
};

export const shouldRevealInternalAssistantMessageInVerbose = (event: TaskEvent): boolean => {
  if (getEffectiveTaskEventType(event) !== "assistant_message" || event.payload?.internal !== true) {
    return false;
  }
  const message = typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
  const stepDescription = getAssistantStepDescription(event);
  if (!message) return false;
  if (hasAssistantMediaDirective(message)) return true;
  if (isVerificationStepDescription(stepDescription)) return false;
  if (/^ok[\s.!?]*$/i.test(message) || message.length <= 12) return false;
  return true;
};

export const getCompletionSummaryText = (event: TaskEvent): string => {
  if (getEffectiveTaskEventType(event) !== "task_completed") return "";
  const resultSummary =
    typeof event.payload?.resultSummary === "string" ? event.payload.resultSummary.trim() : "";
  const semanticSummary =
    typeof event.payload?.semanticSummary === "string" ? event.payload.semanticSummary.trim() : "";
  const verificationVerdict =
    typeof event.payload?.verificationVerdict === "string"
      ? event.payload.verificationVerdict.trim()
      : "";
  const verificationReport =
    typeof event.payload?.verificationReport === "string"
      ? event.payload.verificationReport.trim()
      : "";
  const summary = [resultSummary, semanticSummary].filter((value) => value.length > 0).join("\n\n");
  if (!verificationVerdict && !verificationReport) {
    return summary;
  }
  const verification = [
    verificationVerdict ? `Verification: ${verificationVerdict}` : "",
    verificationReport || "",
  ]
    .filter((value) => value.length > 0)
    .join("\n");
  return [summary, verification].filter((value) => value.length > 0).join("\n\n");
};

export const isLowSignalPauseMessage = (
  message: string | null | undefined,
  reasonCode?: string | null,
): boolean => {
  const trimmed = String(message || "").trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (reasonCode && lower === String(reasonCode).trim().toLowerCase()) return true;
  if (
    String(reasonCode || "").trim().toLowerCase().startsWith('required_decision') &&
    /\b(best next task|recommend(?:ed|ation)?.{0,80}next task)\b/.test(lower)
  ) {
    return true;
  }
  return (
    lower === "required_decision" ||
    lower === "required_decision_followup" ||
    lower === "input_request" ||
    lower === "skill_parameters" ||
    lower === "user_action_required_failure" ||
    lower === "user_action_required_tool" ||
    lower === "user_action_required_disabled" ||
    lower === "shell_permission_required" ||
    lower === "shell_permission_still_disabled" ||
    lower === "missing_required_workspace_artifact" ||
    lower === "paused - awaiting user input" ||
    lower === "waiting for structured user input."
  );
};

export const getPayloadString = (payload: Any, key: string): string => {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() : "";
};

export const getFailureEventText = (event: TaskEvent): string => {
  const payload = event.payload || {};
  const direct = [
    getPayloadString(payload, "message"),
    getPayloadString(payload, "error"),
    getPayloadString(payload, "reason"),
    getPayloadString(payload, "summary"),
    getPayloadString(payload, "title"),
    getPayloadString(payload, "stepDescription"),
  ].find((value) => value.length > 0);
  if (direct) return direct;

  const result = payload.result && typeof payload.result === "object" ? payload.result : null;
  const resultError = result && typeof (result as Any).error === "string" ? (result as Any).error.trim() : "";
  if (resultError) return resultError;

  const input = payload.input && typeof payload.input === "object" ? payload.input : null;
  const url = input && typeof (input as Any).url === "string" ? (input as Any).url.trim() : "";
  const path = input && typeof (input as Any).path === "string" ? (input as Any).path.trim() : "";
  const tool = getPayloadString(payload, "tool");
  if (tool && (url || path)) return `${tool} failed for ${url || path}`;
  if (url || path) return url || path;

  const step = payload.step && typeof payload.step === "object" ? payload.step : null;
  return step && typeof (step as Any).description === "string"
    ? (step as Any).description.trim()
    : "";
};

export const eventLooksFailed = (event: TaskEvent): boolean => {
  const effectiveType = getEffectiveTaskEventType(event);
  const payload = event.payload || {};
  if (
    /^(failed|error|blocked)$/i.test(String(event.status || "")) ||
    /^(failed|error|blocked)$/i.test(String(payload.status || "")) ||
    payload.success === false
  ) {
    return true;
  }
  if (payload.error || payload.isError === true || payload.is_error === true) return true;
  if (typeof effectiveType === "string" && /(?:failed|error)$/i.test(effectiveType)) return true;
  if (event.type === "timeline_step_finished" && event.status === "failed") return true;
  return false;
};

export const cleanFailureTextForPause = (text: string): string => {
  const cleaned = text
    .replace(/^Fetched\s+/i, "")
    .replace(/^Tool\s+["']?([^"']+)["']?\s+failed:\s*/i, "$1 failed: ")
    .trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}...` : cleaned;
};

export const buildPauseDecisionFallbackFromRecentEvents = (
  events: TaskEvent[],
  latestPauseEvent?: TaskEvent,
): string => {
  if (events.length === 0) return "";
  const pauseIndex = latestPauseEvent
    ? events.findIndex((event) => event.id === latestPauseEvent.id)
    : events.length;
  const endIndex = pauseIndex >= 0 ? pauseIndex : events.length;

  for (let i = Math.min(endIndex - 1, events.length - 1); i >= Math.max(0, endIndex - 30); i -= 1) {
    const event = events[i];
    if (!eventLooksFailed(event)) continue;
    const failureText = cleanFailureTextForPause(getFailureEventText(event));
    if (!failureText) continue;
    return (
      `I paused because the last step hit a blocker: ${failureText}. ` +
      "Reply with whether I should continue using the information already gathered, try another source/approach, or stop the task."
    );
  }

  return "";
};

export const getAssistantOrCompletionText = (event: TaskEvent | null | undefined): string => {
  if (!event) return "";
  if (getEffectiveTaskEventType(event) === "assistant_message") {
    return typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
  }
  return getCompletionSummaryText(event);
};

export const buildTaskTitle = (text: string): string => {
  const trimmed = deriveSlashCommandTaskTitle(text) || text.trim();
  if (trimmed.length <= TASK_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, TASK_TITLE_MAX_LENGTH)}...`;
};

export function normalizeInitialPromptText(text: string): string {
  return stripStrategyContextBlock(stripPptxBubbleContent(text))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function getUserEventDisplayMessage(event: TaskEvent): string {
  return typeof event.payload?.message === "string"
    ? normalizeInitialPromptText(event.payload.message)
    : "";
}

export function shouldSuppressInitialPromptUserEvent(params: {
  event: TaskEvent;
  initialPromptEventId: string | null;
  trimmedPrompt: string;
  taskCreatedAt?: number | null;
}): boolean {
  const { event, initialPromptEventId, trimmedPrompt, taskCreatedAt } = params;
  if (getEffectiveTaskEventType(event) !== "user_message") return false;
  if (initialPromptEventId && event.id === initialPromptEventId) return true;

  const promptText = normalizeInitialPromptText(trimmedPrompt);
  if (!promptText) return false;

  const eventText = getUserEventDisplayMessage(event);
  if (!eventText) return false;

  const matchesPrompt = eventText === promptText || eventText.startsWith(promptText);
  if (!matchesPrompt) return false;

  if (typeof taskCreatedAt !== "number" || !Number.isFinite(taskCreatedAt) || taskCreatedAt <= 0) {
    return true;
  }

  const eventTimestamp =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : taskCreatedAt;
  return eventTimestamp >= taskCreatedAt - 5_000 && eventTimestamp <= taskCreatedAt + 60_000;
}

export function deriveTaskHeaderPresentation(task?: {
  title?: string | null;
  prompt?: string | null;
  rawPrompt?: string | null;
  userPrompt?: string | null;
} | null): {
  cleanedDisplayPrompt: string;
  trimmedPrompt: string;
  promptAttachmentNames: string[];
  headerTitle: string;
  headerTooltip: string;
  showHeaderTitle: boolean;
} {
  const displayPromptValue =
    typeof task?.rawPrompt === "string" && task.rawPrompt.trim().length > 0
      ? task.rawPrompt
      : typeof task?.userPrompt === "string" && task.userPrompt.trim().length > 0
        ? task.userPrompt
        : typeof task?.prompt === "string"
          ? task.prompt
          : "";
  const cleanedDisplayPromptValue = displayPromptValue
    ? normalizeInitialPromptText(displayPromptValue)
    : "";
  const trimmedPromptValue = cleanedDisplayPromptValue.trim();
  const promptAttachmentNamesValue = displayPromptValue ? extractAttachmentNames(displayPromptValue) : [];
  const baseTitleValue = task?.title || buildTaskTitle(trimmedPromptValue);
  const normalizedTitle = baseTitleValue.replace(TITLE_ELLIPSIS_REGEX, "").trim();
  const titleMatchesPrompt =
    normalizedTitle.length > 0 &&
    trimmedPromptValue.length > 0 &&
    (trimmedPromptValue === normalizedTitle || trimmedPromptValue.startsWith(normalizedTitle));
  const isTitleTruncated = titleMatchesPrompt && trimmedPromptValue.length > normalizedTitle.length;
  const headerTitleValue =
    isTitleTruncated && !TITLE_ELLIPSIS_REGEX.test(baseTitleValue)
      ? `${baseTitleValue}...`
      : baseTitleValue;
  const showHeaderTitle = headerTitleValue.trim().length > 0 && !titleMatchesPrompt;

  return {
    cleanedDisplayPrompt: cleanedDisplayPromptValue,
    trimmedPrompt: trimmedPromptValue,
    promptAttachmentNames: promptAttachmentNamesValue,
    headerTitle: headerTitleValue,
    headerTooltip: trimmedPromptValue || baseTitleValue,
    showHeaderTitle,
  };
}

export function shouldCreateFreshTaskForSend(params: {
  executionMode: ExecutionMode;
  selectedTaskId: string | null;
  selectedTaskExecutionMode?: ExecutionMode | null;
  forceFreshTask?: boolean;
}): boolean {
  if (params.forceFreshTask) return true;
  if (!params.selectedTaskId) return true;
  if (params.executionMode === "chat") return false;
  return false;
}

export function isChatExecutionTask(executionMode?: ExecutionMode | null): boolean {
  return executionMode === "chat";
}

/**
 * Condense a verbose step description (often a direct echo of the user's prompt)
 * into a short, action-oriented fragment suitable for a timeline row header.
 */
export function condenseStepText(raw: string, maxLength: number = 72): string {
  if (!raw) return raw;
  let text = raw.trim();
  // Strip leading/trailing surrounding quotes that signal a prompt echo.
  text = text.replace(/^["""'`]+/, "").replace(/["""'`]+$/, "");
  // If the text looks like a quoted phrase + meta commentary ("X" means Y…), keep only the quoted phrase.
  const quotedLead = text.match(/^["""'`]([^"""'`]{3,})["""'`]/);
  if (quotedLead?.[1]) {
    text = quotedLead[1].trim();
  }
  // Cut at the first sentence boundary or separator.
  const sentenceCut = text.split(/(?<=[.!?])\s+|\s+[—–-]\s+/)[0] || text;
  text = sentenceCut.trim();
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return text;
}

/** Maps technical timeline/log messages to user-friendly text for verbose mode */
export function humanizeTimelineMessage(message: string): string {
  if (!message || typeof message !== "string") return message;
  const m = message.trim();

  if (m === "Analyzing task requirements...") return "Understanding the request";
  if (/^\[planning\]/i.test(m)) return "Choosing the best planning approach";
  if (/^\[skill-routing\]/i.test(m)) return "Selecting relevant skills";
  if (/^Creating execution plan \(model:[^)]+\)\.\.\.$/i.test(m)) return "Creating execution plan";
  if (/^Starting execution of \d+ steps$/i.test(m)) return "Starting the work";
  const executingStepMatch = /^Executing step \d+\/\d+:\s*(.+)$/i.exec(m);
  if (executingStepMatch?.[1]) {
    return formatTimelineActivityLabel(executingStepMatch[1]);
  }
  const completedStepMatch = /^Completed step [^:]+:\s*(.+)$/i.exec(m);
  if (completedStepMatch?.[1]) {
    return `Finished: ${condenseStepText(completedStepMatch[1])}`;
  }
  if (m === "All steps completed") return "Completed all planned steps";
  if (m === "timeline_step_finished") return "Step finished";

  // Raw JSON progress payloads (web search / fetch metadata)
  if (m.startsWith("{") && m.endsWith("}")) {
    try {
      const parsed = JSON.parse(m) as Record<string, unknown>;
      if (typeof parsed.query === "string" && parsed.query.trim()) {
        const q = parsed.query.trim();
        const prov = typeof parsed.provider === "string" ? ` (${parsed.provider})` : "";
        return `Web search: ${q.length > 90 ? `${q.slice(0, 89)}…` : q}${prov}`;
      }
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        const head = title || parsed.url;
        return `Fetched page: ${head.length > 90 ? `${head.slice(0, 89)}…` : head}`;
      }
    } catch {
      /* keep message */
    }
  }

  // Prompt budget / context optimization
  if (/prompt budget applied$/i.test(m)) return "Optimized context to fit limits";

  // Auto-waive completion gate messages
  if (m.includes("Auto-waived verification-only failed steps") && m.includes("partial_success")) {
    return "Completed with some verification steps skipped (results were good enough)";
  }
  if (m.includes("Auto-waived budget-constrained failed steps") && m.includes("partial_success")) {
    return "Completed with some steps skipped (reached context limit)";
  }
  if (
    m.includes("Auto-waived failed steps because the task already produced substantive outputs") &&
    m.includes("partial_success")
  ) {
    return "Completed with some steps skipped (task already had useful results)";
  }

  // Raw event type names that may appear as messages
  if (m === "timeline_step_updated" || m === "progress_update") return "Progress update";
  if (m === "executing") return "Working";

  // Execution outcome messages
  if (m === "Execution completed with partial results.") return "Completed with partial results";
  if (m.startsWith("Execution failed:") && m.includes("step(s) failed")) {
    const n = m.match(/(\d+)\s+step\(s\)\s+failed/)?.[1];
    return n ? `Failed: ${n} step(s) didn't complete` : "Execution failed";
  }
  if (m.includes("Completed with warnings:") && m.includes("optional step(s) failed")) {
    return "Completed with some steps skipped (main work done)";
  }
  if (m.includes("Completed with warnings:") && m.includes("final deliverable was produced")) {
    return "Completed with some steps skipped (output was produced)";
  }
  if (m.includes("Completed with warnings:") && m.includes("majority of work succeeded")) {
    return "Completed with some steps skipped (most work done)";
  }
  if (m.includes("mutation-required steps failed unrecovered")) {
    return "Failed: required file changes didn't complete";
  }
  if (m.includes("high-risk verification gate did not pass")) {
    return "Failed: verification did not pass";
  }

  // Completion guard / contract messages
  if (m.includes("Completion guard blocked finalization") && m.includes("artifact contract")) {
    return "Paused: output didn't match requirements";
  }
  if (m.includes("Completion blocked:") && m.includes("unresolved")) {
    return m.replace(/^Completion blocked:\s*unresolved\s+/, "Blocked: ");
  }

  // Other technical patterns
  if (m.startsWith("execution_run_summary")) return "Execution summary";
  if (/^\[verified-mode\]/i.test(m)) return m.replace(/^\[verified-mode\]\s*/i, "").trim() || "Verification";
  if (m.includes("Suppressed raw tool-call markup")) return "Cleaned up model output";
  if (m.includes("Security:") && m.includes("Suspicious output")) return "Security check applied";
  if (m.includes("Security:") && m.includes("Potential injection")) return "Security check applied";
  if (m.includes("Pre-compaction memory flush saved")) return "Freed up context space";
  if (m.includes("LLM route selected:")) return "Selected model";
  if (m.includes("Creating execution plan")) return m; // Already friendly
  if (m.includes("Step timeout detected")) return "Step took too long; finishing with best effort";
  if (m.includes("Wrap-up requested")) return "Finishing up";
  if (m.includes("Answer-first short-circuit")) return "Answered directly (simple prompt)";
  if (m.includes("Answer-first non-execute short-circuit")) return "Answered directly (no execution needed)";
  if (m.includes("Pre-flight framing failed")) return "Continuing with execution";
  if (m.includes("Answer-first pre-response failed")) return "Continuing with full execution";
  if (m.includes("Applied /batch external=none policy")) return "Running in batch mode (no external tools)";
  if (m.includes("User granted explicit external side-effect approval")) return "Approved to use external tools";
  if (m.includes("External side-effect approval request failed")) return "Could not get approval for external tools";
  if (m.includes("Normalized /") && m.includes("to deterministic skill")) return "Running skill";
  if (m.includes("Detected inline /") && m.includes("chain")) return "Running skill chain";
  if (m.includes("Step soft deadline reached")) return "Step time limit approached";
  if (m.includes("Key factual claims are missing evidence links")) {
    return "Some claims need evidence links";
  }

  return message;
}
