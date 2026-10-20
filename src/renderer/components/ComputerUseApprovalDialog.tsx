import { useState } from "react";
import type { ApprovalRequest } from "../../shared/types";

function shortAccessLevel(level: unknown): string {
  if (level === "full_control") return "Full control";
  if (level === "click_only") return "Click only";
  if (level === "view_only") return "View only";
  return "";
}

function formatAccessLevel(level: unknown): string {
  if (level === "full_control") return "Full control (click, type, keys)";
  if (level === "click_only") return "Click only (no typing)";
  if (level === "view_only") return "View only (screenshot & hover)";
  return String(level ?? "unknown");
}

export function isComputerUseAppGrantApproval(approval: ApprovalRequest): boolean {
  return (
    approval.type === "computer_use" &&
    approval.details &&
    typeof approval.details === "object" &&
    (approval.details as { kind?: string }).kind === "computer_use_app_grant"
  );
}

interface ComputerUseApprovalDialogProps {
  approval: ApprovalRequest;
  onAllowSession: () => void;
  onDeny: () => void;
}

export function ComputerUseApprovalDialog({
  approval,
  onAllowSession,
  onDeny,
}: ComputerUseApprovalDialogProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!isComputerUseAppGrantApproval(approval)) {
    return null;
  }
  const details = approval.details && typeof approval.details === "object" ? approval.details : {};
  const d = details as {
    appName?: string;
    bundleId?: string;
    requestedLevel?: string;
    reason?: string;
    riskClass?: string;
    sentinelWarning?: string;
  };

  const title = d.appName ? `Let CoWork use ${d.appName}?` : "Let CoWork use this app?";
  const summary = [shortAccessLevel(d.requestedLevel), "this session only"]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="session-approval-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="session-approval-card session-approval-card--minimal session-approval-card--computer-use">
        <h3 className="session-approval-title">{title}</h3>
        <div className="session-approval-meta">
          <span className="session-approval-summary">{summary}</span>
          <button
            type="button"
            className="session-approval-link"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "Hide details" : "Details"}
          </button>
        </div>

        {d.sentinelWarning ? (
          <p className="session-approval-sentinel-warning">{d.sentinelWarning}</p>
        ) : null}

        <div className="session-approval-details-panel" hidden={!detailsOpen}>
          <p className="session-approval-prompt">{approval.description}</p>
          <dl className="session-approval-details">
            {d.bundleId ? (
              <>
                <dt>Bundle ID</dt>
                <dd>
                  <code className="session-approval-code">{d.bundleId}</code>
                </dd>
              </>
            ) : null}
            {d.requestedLevel ? (
              <>
                <dt>Requested access</dt>
                <dd>{formatAccessLevel(d.requestedLevel)}</dd>
              </>
            ) : null}
            {d.riskClass ? (
              <>
                <dt>Category</dt>
                <dd>{d.riskClass.replace(/_/g, " ")}</dd>
              </>
            ) : null}
            {d.reason ? (
              <>
                <dt>Why</dt>
                <dd>{d.reason}</dd>
              </>
            ) : null}
          </dl>
          <p className="session-approval-footer-hint">
            Press <kbd className="session-approval-kbd">Esc</kbd> during control to stop.
          </p>
        </div>

        <div className="session-approval-actions">
          <button type="button" className="session-approval-btn-deny" onClick={onDeny}>
            Deny
          </button>
          <button type="button" className="session-approval-btn-allow" onClick={onAllowSession}>
            Allow for this session
          </button>
        </div>
      </div>
    </div>
  );
}
