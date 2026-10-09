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
      <div className="session-approval-card session-approval-card--warning">
        <div className="session-approval-heading">
          <span className="session-approval-icon" aria-hidden="true">
            ⚠️
          </span>
          <h3 id="approve-all-warning-title" className="session-approval-title">
            Warning: approve all requests?
          </h3>
        </div>
        <p id="approve-all-warning-desc" className="session-approval-prompt">
          This will auto-approve every future request in this session. Only enable this if you fully
          trust the active tasks.
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
