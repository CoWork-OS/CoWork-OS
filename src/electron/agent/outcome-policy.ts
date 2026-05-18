import type {
  StepFailureClass,
  Task,
  TaskBestKnownOutcome,
  TaskOutputSummary,
  TaskStatus,
  TaskTerminalStatus,
} from "../../shared/types";

export interface OutcomeDecisionInput {
  requestedStatus: TaskStatus;
  terminalStatus?: TaskTerminalStatus;
  failureClass?: StepFailureClass;
  resultSummary?: string;
  outputSummary?: TaskOutputSummary;
  bestKnownOutcome?: TaskBestKnownOutcome;
  error?: string | null;
}

export interface OutcomeDecision {
  status: TaskStatus;
  terminalStatus: TaskTerminalStatus;
  failureClass?: StepFailureClass;
}

export function hasTaskOutputs(summary?: TaskOutputSummary | null): boolean {
  return !!summary && summary.outputCount > 0;
}

export function hasUsableSummary(summary?: string | null, minChars = 80): boolean {
  return typeof summary === "string" && summary.trim().length >= minChars;
}

export function hasSubstantiveOutcomeEvidence(input: {
  resultSummary?: string | null;
  outputSummary?: TaskOutputSummary | null;
  bestKnownOutcome?: TaskBestKnownOutcome;
}): boolean {
  if (hasTaskOutputs(input.outputSummary)) return true;
  if (hasUsableSummary(input.resultSummary, 160)) return true;
  const best = input.bestKnownOutcome;
  if (!best) return false;
  return hasTaskOutputs(best.outputSummary) || hasUsableSummary(best.resultSummary, 160);
}

export function buildBestKnownOutcome(params: {
  resultSummary?: string;
  outputSummary?: TaskOutputSummary;
  completedStepIds?: string[];
  blockingIssues?: string[];
  terminalStatus?: TaskTerminalStatus;
  failureClass?: StepFailureClass;
  confidence?: "low" | "medium" | "high";
}): TaskBestKnownOutcome | undefined {
  const trimmedSummary = typeof params.resultSummary === "string" ? params.resultSummary.trim() : "";
  const completedStepIds = Array.isArray(params.completedStepIds)
    ? Array.from(new Set(params.completedStepIds.map((id) => String(id || "").trim()).filter(Boolean)))
    : [];
  const blockingIssues = Array.isArray(params.blockingIssues)
    ? Array.from(new Set(params.blockingIssues.map((issue) => String(issue || "").trim()).filter(Boolean)))
    : [];
  if (!trimmedSummary && !hasTaskOutputs(params.outputSummary) && completedStepIds.length === 0) {
    return undefined;
  }
  return {
    capturedAt: Date.now(),
    ...(trimmedSummary ? { resultSummary: trimmedSummary } : {}),
    ...(params.outputSummary ? { outputSummary: params.outputSummary } : {}),
    ...(completedStepIds.length > 0 ? { completedStepIds } : {}),
    ...(blockingIssues.length > 0 ? { blockingIssues } : {}),
    ...(params.terminalStatus ? { terminalStatus: params.terminalStatus } : {}),
    ...(params.failureClass ? { failureClass: params.failureClass } : {}),
    confidence: params.confidence || (hasTaskOutputs(params.outputSummary) ? "high" : "medium"),
  };
}

export function mergeBestKnownOutcome(
  previous?: TaskBestKnownOutcome,
  incoming?: TaskBestKnownOutcome,
): TaskBestKnownOutcome | undefined {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const previousHasOutputs = hasTaskOutputs(previous.outputSummary);
  const incomingHasOutputs = hasTaskOutputs(incoming.outputSummary);
  const preferredSummary =
    (incoming.resultSummary || "").trim().length >= (previous.resultSummary || "").trim().length
      ? incoming.resultSummary
      : previous.resultSummary;
  return {
    capturedAt: Math.max(previous.capturedAt || 0, incoming.capturedAt || 0),
    ...(preferredSummary ? { resultSummary: preferredSummary } : {}),
    outputSummary: incomingHasOutputs ? incoming.outputSummary : previousHasOutputs ? previous.outputSummary : incoming.outputSummary || previous.outputSummary,
    completedStepIds: Array.from(
      new Set([...(previous.completedStepIds || []), ...(incoming.completedStepIds || [])]),
    ),
    blockingIssues: Array.from(
      new Set([...(previous.blockingIssues || []), ...(incoming.blockingIssues || [])]),
    ),
    terminalStatus: incoming.terminalStatus || previous.terminalStatus,
    failureClass: incoming.failureClass || previous.failureClass,
    confidence:
      incomingHasOutputs || previousHasOutputs
        ? "high"
        : incoming.confidence || previous.confidence || "medium",
  };
}

function isHardFailureWithoutRecovery(failureClass?: StepFailureClass): boolean {
  return failureClass === "required_verification" || failureClass === "user_blocker";
}

export function decideTaskOutcome(input: OutcomeDecisionInput): OutcomeDecision {
  const requestedTerminalStatus = input.terminalStatus;
  const failureClass = input.failureClass;
  const hasEvidence = hasSubstantiveOutcomeEvidence(input);

  if (input.requestedStatus === "blocked" || requestedTerminalStatus === "awaiting_approval") {
    return {
      status: "blocked",
      terminalStatus: "awaiting_approval",
      failureClass: undefined,
    };
  }

  if (input.requestedStatus === "paused" || requestedTerminalStatus === "needs_user_action") {
    return {
      status: input.requestedStatus === "completed" ? "completed" : "paused",
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    };
  }

  if (input.requestedStatus === "interrupted" || requestedTerminalStatus === "resume_available") {
    return {
      status: "interrupted",
      terminalStatus: hasEvidence ? "resume_available" : "failed",
      failureClass: hasEvidence ? failureClass : failureClass || "unknown",
    };
  }

  if (input.requestedStatus === "failed") {
    if (hasEvidence && !isHardFailureWithoutRecovery(failureClass)) {
      return {
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: failureClass || "unknown",
      };
    }
    return {
      status: "failed",
      terminalStatus: "failed",
      failureClass: failureClass || "unknown",
    };
  }

  if (input.requestedStatus === "completed") {
    if (requestedTerminalStatus === "failed") {
      return {
        status: "failed",
        terminalStatus: "failed",
        failureClass: failureClass || "unknown",
      };
    }
    if (requestedTerminalStatus === "partial_success") {
      return {
        status: "completed",
        terminalStatus: "partial_success",
        failureClass: failureClass || "contract_error",
      };
    }
    if (hasEvidence && failureClass && !isHardFailureWithoutRecovery(failureClass)) {
      return {
        status: "completed",
        terminalStatus: "partial_success",
        failureClass,
      };
    }
    return {
      status: "completed",
      terminalStatus: "ok",
      failureClass: undefined,
    };
  }

  return {
    status: input.requestedStatus,
    terminalStatus: requestedTerminalStatus || "ok",
    failureClass,
  };
}

export function getTaskBestKnownOutcome(task?: Pick<Task, "bestKnownOutcome"> | null): TaskBestKnownOutcome | undefined {
  return task?.bestKnownOutcome;
}
