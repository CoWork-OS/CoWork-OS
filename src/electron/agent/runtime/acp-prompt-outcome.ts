export interface AcpPromptEvidence {
  /** Raw stop reason from the prompt result, if any. */
  stopReason: string | undefined;
  /** Final assistant text. */
  assistantText: string;
  /** Files the agent reported changing that CoWork confirmed exist in the workspace. */
  verifiedArtifactPaths: readonly string[];
}

export type AcpPromptOutcome =
  | { kind: "completed" }
  | { kind: "needs_user_action"; reason: string }
  | { kind: "partial_success"; failureClass: "budget_exhausted"; reason: string }
  | { kind: "failed"; failureClass: "contract_error"; reason: string }
  | { kind: "cancelled"; reason: string };

/**
 * Classify one ACP prompt result, exactly once, into a CoWork outcome. A stop reason
 * says why a turn ended; it is not proof that the task succeeded.
 * https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons
 *
 * Only prompt results carry a stop reason; session create/ensure commands must not be
 * passed here. A missing or unrecognized stop reason is a contract error, never a
 * success.
 */
export function classifyAcpPromptResult(evidence: AcpPromptEvidence): AcpPromptOutcome {
  const hasOutput =
    evidence.assistantText.trim().length > 0 || evidence.verifiedArtifactPaths.length > 0;
  const stopReason = evidence.stopReason;

  switch (stopReason) {
    case "end_turn":
      if (hasOutput) return { kind: "completed" };
      return {
        kind: "needs_user_action",
        reason:
          "The external agent ended its turn without a final response or a verifiable output. Inspect the timeline and resume if more work is needed.",
      };
    case "max_tokens":
    case "max_turn_requests": {
      const limit =
        stopReason === "max_tokens" ? "its token limit" : "its maximum number of model requests";
      if (hasOutput) {
        return {
          kind: "partial_success",
          failureClass: "budget_exhausted",
          reason: `The external agent stopped after reaching ${limit}; the result may be incomplete.`,
        };
      }
      return {
        kind: "needs_user_action",
        reason: `The external agent stopped after reaching ${limit} without usable output. Decide whether to continue.`,
      };
    }
    case "refusal":
      return {
        kind: "failed",
        failureClass: "contract_error",
        reason: "The external agent refused to continue this request.",
      };
    case "cancelled":
      return {
        kind: "cancelled",
        reason: "The external agent reported that the turn was cancelled.",
      };
    default:
      return {
        kind: "failed",
        failureClass: "contract_error",
        reason: stopReason
          ? `The external agent ended the turn with an unrecognized stop reason (${stopReason}).`
          : "The external agent ended the turn without reporting a stop reason.",
      };
  }
}
