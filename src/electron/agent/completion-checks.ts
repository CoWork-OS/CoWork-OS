import { TaskDomain } from "../../shared/types";

export interface LoopGuardrailConfig {
  stopReasonToolUseStreak: number;
  stopReasonMaxTokenStreak: number;
  lowProgressWindowSize: number;
  lowProgressSameTargetMinCalls: number;
  followUpLockMinStreak: number;
  followUpLockMinToolCalls: number;
  skippedToolOnlyTurnThreshold: number;
}

const DEFAULT_LOOP_GUARDRAIL: LoopGuardrailConfig = {
  stopReasonToolUseStreak: 6,
  stopReasonMaxTokenStreak: 2,
  lowProgressWindowSize: 8,
  lowProgressSameTargetMinCalls: 6,
  followUpLockMinStreak: 10,
  followUpLockMinToolCalls: 10,
  skippedToolOnlyTurnThreshold: 2,
};

const CODE_LOOP_GUARDRAIL: LoopGuardrailConfig = {
  stopReasonToolUseStreak: 7,
  stopReasonMaxTokenStreak: 3,
  lowProgressWindowSize: 10,
  lowProgressSameTargetMinCalls: 7,
  followUpLockMinStreak: 12,
  followUpLockMinToolCalls: 12,
  skippedToolOnlyTurnThreshold: 3,
};

const NON_CODE_LOOP_GUARDRAIL: LoopGuardrailConfig = {
  stopReasonToolUseStreak: 4,
  stopReasonMaxTokenStreak: 2,
  lowProgressWindowSize: 6,
  lowProgressSameTargetMinCalls: 4,
  followUpLockMinStreak: 8,
  followUpLockMinToolCalls: 6,
  skippedToolOnlyTurnThreshold: 2,
};

export function getLoopGuardrailConfig(domain: TaskDomain | undefined): LoopGuardrailConfig {
  if (domain === "code" || domain === "operations") return CODE_LOOP_GUARDRAIL;
  if (domain === "research" || domain === "writing" || domain === "general") {
    return NON_CODE_LOOP_GUARDRAIL;
  }
  return DEFAULT_LOOP_GUARDRAIL;
}

export function shouldRequireExecutionEvidenceForDomain(domain: TaskDomain | undefined): boolean {
  return domain === "code" || domain === "operations" || domain === "auto";
}

export interface DomainCompletionInput {
  domain: TaskDomain | undefined;
  isLastStep: boolean;
  assistantText: string;
  hadAnyToolSuccess: boolean;
}

export interface DomainCompletionResult {
  failed: boolean;
  reason?: string;
}

const NON_SUBSTANTIVE_RESPONSES = new Set([
  "done",
  "done.",
  "completed",
  "completed.",
  "all set",
  "all set.",
  "finished",
  "finished.",
  "ok",
  "ok.",
]);

export function evaluateDomainCompletion(input: DomainCompletionInput): DomainCompletionResult {
  if (!input.isLastStep) return { failed: false };

  const domain = input.domain ?? "auto";
  if (domain === "code" || domain === "operations") return { failed: false };

  const text = String(input.assistantText || "").trim();
  const normalized = text.toLowerCase();

  if (!text) {
    if (input.hadAnyToolSuccess) {
      return {
        failed: true,
        reason:
          "Task ended without a user-facing answer. Provide a concise summary of results before finishing.",
      };
    }
    return { failed: false };
  }

  if (NON_SUBSTANTIVE_RESPONSES.has(normalized)) {
    return {
      failed: true,
      reason:
        "Final response was too brief to be useful. Provide a concrete answer with findings or outcomes.",
    };
  }

  if (domain === "research") {
    const hasResearchSignal =
      /\b(found|finding|source|evidence|according|result|conclusion|summary|data)\b/i.test(text) ||
      /\[[0-9]+\]/.test(text);
    if (text.length < 80 || !hasResearchSignal) {
      return {
        failed: true,
        reason:
          "Research task ended without a sufficient findings summary. Include key findings and explicit uncertainties.",
      };
    }
  }

  if (domain === "writing" && text.length < 120) {
    return {
      failed: true,
      reason:
        "Writing task ended with insufficient content. Provide the actual draft/content instead of a short status line.",
    };
  }

  if ((domain === "general" || domain === "auto") && text.length < 40) {
    return {
      failed: true,
      reason:
        "Final response is too short to be actionable. Include a concrete answer or next steps.",
    };
  }

  return { failed: false };
}
