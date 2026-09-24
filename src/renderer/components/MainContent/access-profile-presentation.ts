import type { AccessProfileDefinition } from "../../../shared/access-profiles";

export function getAccessProfilePresentation(
  profile: AccessProfileDefinition,
  approvalPromptsEnabled: boolean | null,
): { label: string; description: string; notice: string | null } {
  if (approvalPromptsEnabled !== false || profile.approval !== "on-request") {
    return { label: profile.label, description: profile.description, notice: null };
  }

  const notice =
    "Approval prompts are off in this runtime. Actions allowed by this profile can run; requests for additional authority are blocked.";
  return {
    label: `${profile.label} · prompts off`,
    description: "Allowed actions can run; requests that need approval are blocked.",
    notice,
  };
}
