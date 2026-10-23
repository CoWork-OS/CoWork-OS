interface ApproveAllSessionWarningDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirms enabling session-wide auto-approve — matches session approval modal chrome
 * (overlay, card, typography, pill buttons).
 */
export function ApproveAllSessionWarningDialog({
  onConfirm,
  onCancel,
}: ApproveAllSessionWarningDialogProps) {
  return (
    <div
      className="session-approval-overlay session-approval-overlay--warning-layer"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="approve-all-warning-title"
      aria-describedby="approve-all-warning-desc"
    >
      <div className="session-approval-card session-approval-card--minimal session-approval-card--warning">
        <h3 id="approve-all-warning-title" className="session-approval-title">
          Auto-approve every request in this session?
        </h3>
        <p id="approve-all-warning-desc" className="session-approval-meta">
          Only turn this on if you fully trust the active tasks.
        </p>

        <div className="session-approval-actions session-approval-actions--warning">
          <button type="button" className="session-approval-btn-deny" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="session-approval-btn-danger-primary" onClick={onConfirm}>
            I Understand
          </button>
        </div>
      </div>
    </div>
  );
}
