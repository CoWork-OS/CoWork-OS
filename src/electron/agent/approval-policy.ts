/**
 * Approval prompts are an opt-in compatibility path. CoWork's normal local
 * runtime follows the same no-prompt posture as the full-auto harnesses; set
 * COWORK_APPROVAL_PROMPTS=on when an operator explicitly wants the legacy
 * approval queue back (tests also opt into it through NODE_ENV=test).
 */
export function approvalPromptsDisabled(): boolean {
  const configured = String(process.env.COWORK_APPROVAL_PROMPTS || "")
    .trim()
    .toLowerCase();
  if (configured === "on" || configured === "enabled" || configured === "true") {
    return false;
  }
  if (configured === "off" || configured === "disabled" || configured === "false") {
    return true;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  return true;
}
