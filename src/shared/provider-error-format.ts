import type { Task } from "./types";
import { isAutomatedTaskLike } from "./automated-task-detection";

// An account that is out of quota or credits often answers with HTTP 429 too, but waiting
// does not help. Matches the wording the provider error classifier treats as final.
const QUOTA_EXHAUSTED_TEXT =
  /exceeded your current quota|insufficient[_ ]quota|credit balance is too low|insufficient credits|billing_hard_limit_reached|billing_not_active/i;

/**
 * Format LLM provider errors for user display.
 * Rate limit errors get actionable guidance for manual tasks; shorter copy for automated/scheduled.
 */
export function formatProviderErrorForDisplay(
  errorMessage: string,
  options?: { task?: Task | null },
): string {
  const msg = String(errorMessage || "").trim();
  if (!msg) return "Provider error";
  if (QUOTA_EXHAUSTED_TEXT.test(msg)) {
    return "The model provider says this account is out of quota or credits. Check your plan and billing with the provider, or switch to another model.";
  }
  if (/429|rate limit|too many requests|free-models-per-min/i.test(msg)) {
    const automated = isAutomatedTaskLike(options?.task);
    if (automated) {
      return "Rate limit exceeded. Will retry automatically.";
    }
    // Most people already use their own key, so only the free tier is told to add one.
    const hint = /free-models-per-min|free.*model/i.test(msg)
      ? " Free tier has strict limits — add an OpenRouter API key in Settings for higher limits, or wait a minute and try again."
      : " Wait a minute and try again, or switch to another model.";
    return `Rate limit exceeded.${hint}`;
  }
  return msg;
}
