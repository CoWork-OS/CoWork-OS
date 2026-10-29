import { useId, useRef, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "./ModalDialog";
import "./confirm-dialog.css";

export interface ConfirmDialogProps {
  title: string;
  /** A sentence or two under the title. */
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive actions get a red confirm button. */
  danger?: boolean;
  /** Extra controls between the message and the buttons, such as an opt-in checkbox. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The in-app stand-in for `window.confirm`: a small modal with Cancel and one action.
 * Escape, a click outside and Cancel all cancel; focus starts on the first control.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  useModalDialog(cardRef, onCancel);

  return createPortal(
    // Clicks stop here so a dialog opened inside another surface never reaches its handlers.
    <div
      className="confirm-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onCancel();
      }}
      onClick={stopPropagation}
    >
      <div
        ref={cardRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        tabIndex={-1}
        onMouseDown={stopPropagation}
      >
        <h2 id={titleId} className="confirm-dialog-title">
          {title}
        </h2>
        {message ? (
          <p id={messageId} className="confirm-dialog-message">
            {message}
          </p>
        ) : null}
        {children ? <div className="confirm-dialog-extra">{children}</div> : null}
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog-confirm${danger ? " is-danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
