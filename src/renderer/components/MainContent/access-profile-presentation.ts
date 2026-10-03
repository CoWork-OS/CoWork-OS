import type { AccessProfileDefinition } from "../../../shared/access-profiles";

export function getAccessProfilePresentation(
  profile: AccessProfileDefinition,
  approvalPromptsEnabled: boolean | null,
): { label: string; description: string; notice: string | null } {
  if (approvalPromptsEnabled !== false || profile.approval !== "on-request") {
    return { label: profile.label, description: profile.description, notice: null };
  }

  // Without the legacy approval queue, an ask is answered in the task itself:
  // the daemon raises an inline "Deny / Allow once" card instead of a modal.
  return {
    label: profile.label,
    description: `${profile.description} Requests that need approval appear in the task as a Deny / Allow once card.`,
    notice: null,
  };
}
