import { useState } from "react";
import type { AgentImportResult } from "../../../shared/types";
import { AgentImportPanel } from "../AgentImport/AgentImportPanel";

/**
 * Onboarding step shown before provider setup when a Hermes Agent or OpenClaw home exists
 * on this machine: the same preview-then-import list as Settings > Import.
 */
export function OnboardingImportStep({
  workspaceId,
  onFinish,
}: {
  workspaceId?: string | null;
  onFinish: (imported: boolean) => void;
}) {
  const [result, setResult] = useState<AgentImportResult | null>(null);
  return (
    <div className="onboarding-import-step">
      <AgentImportPanel compact workspaceId={workspaceId || undefined} onImported={setResult} />
      <div className="onboarding-actions">
        <button
          type="button"
          className={`onboarding-btn ${result ? "onboarding-btn-primary" : "onboarding-btn-secondary"}`}
          onClick={() => onFinish(Boolean(result && result.imported > 0))}
        >
          {result ? "Continue" : "Skip for now"}
        </button>
      </div>
    </div>
  );
}
