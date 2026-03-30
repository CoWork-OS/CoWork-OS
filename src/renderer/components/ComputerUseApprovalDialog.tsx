import type { ApprovalRequest } from "../../shared/types";

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

  return (
    <div className="approval-dialog-overlay computer-use-approval-overlay" role="dialog" aria-modal="true">
      <div className="approval-dialog approval-warning computer-use-approval-dialog">
        <div className="approval-icon" aria-hidden="true">
          🖥️
        </div>

        <div className="approval-content">
          <h3>Computer use — app access</h3>
          <p className="approval-description">{approval.description}</p>

          <dl className="computer-use-approval-details">
            {d.appName ? (
              <>
                <dt>App</dt>
                <dd>{d.appName}</dd>
              </>
            ) : null}
            {d.bundleId ? (
              <>
                <dt>Bundle ID</dt>
                <dd>
                  <code>{d.bundleId}</code>
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

          {d.sentinelWarning ? (
            <p className="computer-use-sentinel-warning">{d.sentinelWarning}</p>
          ) : null}

          <p className="computer-use-session-hint">
            Grants apply only for this computer-use session. Press <kbd>Esc</kbd> during control to
            stop.
          </p>
        </div>

        <div className="approval-actions computer-use-approval-actions">
          <button type="button" className="button-secondary" onClick={onDeny}>
            Deny
          </button>
          <button type="button" className="button-primary" onClick={onAllowSession}>
            Allow for this session
          </button>
        </div>
      </div>
    </div>
  );
}
