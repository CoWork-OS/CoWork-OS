/**
 * Plan/step helpers shared across Electron (agent executor) and Renderer (UI).
 */

/**
 * Detects the explicit "Verify: ..." final-plan step that the agent planner is instructed to add.
 *
 * Keep this intentionally narrow: we only treat steps that are clearly labeled as verification
 * as "verification steps" for UI suppression.
 */
export function isVerificationStepDescription(description?: string | null): boolean {
  const desc = String(description || "")
    .trim()
    .toLowerCase();
  if (!desc) return false;

  if (desc === "verify") return true;
  if (desc.startsWith("verify:")) return true;
  if (desc.startsWith("verify -")) return true;
  if (desc.startsWith("verify ")) return true;

  if (desc === "verification") return true;
  if (desc.startsWith("verification:")) return true;
  if (desc.startsWith("verification ")) return true;

  return false;
}

export function planHasVerificationStep(
  plan?: {
    steps?: Array<{
      kind?: string;
      description?: string | null;
    }>;
  } | null,
): boolean {
  return Boolean(
    plan?.steps?.some(
      (step) => step?.kind === "verification" || isVerificationStepDescription(step?.description),
    ),
  );
}
