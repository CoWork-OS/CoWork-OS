import type { Task } from "../../../shared/types";

/**
 * Prompt-turn stop reasons defined by the Agent Client Protocol. A stop reason says
 * why a turn ended; it is not proof that the task succeeded.
 * https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons
 */
export const ACP_PROMPT_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;

export type AcpPromptStopReason = (typeof ACP_PROMPT_STOP_REASONS)[number];

export interface AcpPromptEvidence {
  /** Raw stop reason from the prompt result, if any. */
  stopReason: string | undefined;
  /** Final assistant text, trimmed. */
  assistantText: string;
  /** Files the agent reported changing that CoWork confirmed exist in the workspace. */
  verifiedArtifactPaths: readonly string[];
}

export type AcpPromptOutcome =
  | {
      kind: "completed";
      stopReason: "end_turn";
      /** What makes the turn usable: a final response, or only verified artifacts. */
      evidence: "response" | "artifact";
    }
  | { kind: "needs_user_action"; stopReason: string; reason: string }
  | {
      kind: "partial_success";
      stopReason: string;
      failureClass: "budget_exhausted";
      reason: string;
    }
  | {
      kind: "failed";
      stopReason: string | null;
      failureClass: NonNullable<Task["failureClass"]>;
      reason: string;
    }
  | { kind: "cancelled"; stopReason: "cancelled"; reason: string };

export function isAcpPromptStopReason(value: unknown): value is AcpPromptStopReason {
  return (
    typeof value === "string" && (ACP_PROMPT_STOP_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Classify one ACP prompt result, exactly once, into a CoWork outcome.
 *
 * Only prompt results carry a stop reason; session create/ensure commands must not be
 * passed here. A missing or unrecognized stop reason is a contract error, never a
 * success.
 */
export function classifyAcpPromptResult(evidence: AcpPromptEvidence): AcpPromptOutcome {
  const text = evidence.assistantText.trim();
  const hasArtifact = evidence.verifiedArtifactPaths.length > 0;
  const stopReason = evidence.stopReason;

  if (!isAcpPromptStopReason(stopReason)) {
    return {
      kind: "failed",
      stopReason: stopReason ?? null,
      failureClass: "contract_error",
      reason: stopReason
        ? `The external agent ended the turn with an unrecognized stop reason (${stopReason}).`
        : "The external agent ended the turn without reporting a stop reason.",
    };
  }

  switch (stopReason) {
    case "end_turn":
      if (text) return { kind: "completed", stopReason, evidence: "response" };
      if (hasArtifact) return { kind: "completed", stopReason, evidence: "artifact" };
      return {
        kind: "needs_user_action",
        stopReason,
        reason:
          "The external agent ended its turn without a final response or a verifiable output. Inspect the timeline and resume if more work is needed.",
      };
    case "max_tokens":
    case "max_turn_requests": {
      const limit =
        stopReason === "max_tokens" ? "its token limit" : "its maximum number of model requests";
      if (text || hasArtifact) {
        return {
          kind: "partial_success",
          stopReason,
          failureClass: "budget_exhausted",
          reason: `The external agent stopped after reaching ${limit}; the result may be incomplete.`,
        };
      }
      return {
        kind: "needs_user_action",
        stopReason,
        reason: `The external agent stopped after reaching ${limit} without usable output. Decide whether to continue.`,
      };
    }
    case "refusal":
      return {
        kind: "failed",
        stopReason,
        failureClass: "contract_error",
        reason: "The external agent refused to continue this request.",
      };
    case "cancelled":
      return {
        kind: "cancelled",
        stopReason,
        reason: "The external agent reported that the turn was cancelled.",
      };
  }
}
