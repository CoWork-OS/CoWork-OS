import { AlertTriangle, FolderOpen, Globe, ShieldAlert, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./FullAccessConfirmationDialog.css";

const ACKNOWLEDGEMENT_KEY = "cowork:full-access-confirmed:v1";
let confirmedThisSession = false;

export function hasConfirmedFullAccess(): boolean {
  try {
    return confirmedThisSession || window.localStorage.getItem(ACKNOWLEDGEMENT_KEY) === "true";
  } catch {
    return confirmedThisSession;
  }
}

export function confirmFullAccess(): void {
  confirmedThisSession = true;
  try {
    window.localStorage.setItem(ACKNOWLEDGEMENT_KEY, "true");
  } catch {
    // Keep the acknowledgement for this app session when storage is unavailable.
  }
}

export function FullAccessConfirmationDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const cancel = card.current?.querySelector<HTMLButtonElement>("button");
    cancel?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        const controls = Array.from(
          card.current?.querySelectorAll<HTMLElement>("button, a[href]") || [],
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [onCancel]);

  return (
    <div className="full-access-overlay">
      <div
        ref={card}
        className="full-access-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="full-access-title"
        aria-describedby="full-access-description full-access-risk"
      >
        <div className="full-access-heading">
          <div className="full-access-heading-icon">
            <ShieldAlert size={24} aria-hidden="true" />
          </div>
          <div>
            <span className="full-access-eyebrow">CoWork OS · Access profile</span>
            <h2 id="full-access-title">Turn on Full access?</h2>
          </div>
        </div>
        <p id="full-access-description">
          CoWork OS will be able to run commands, use the internet, and read and change files across
          this computer without asking for approval for each action. This includes:
        </p>
        <div className="full-access-capabilities">
          <div>
            <span className="full-access-capability-icon">
              <FolderOpen size={20} aria-hidden="true" />
            </span>
            <section>
              <strong>Files and folders</strong>
              <p>Read, create, modify, upload, or delete files.</p>
            </section>
          </div>
          <div>
            <span className="full-access-capability-icon">
              <Terminal size={20} aria-hidden="true" />
            </span>
            <section>
              <strong>Terminal commands</strong>
              <p>Run commands, install software, and change system settings.</p>
            </section>
          </div>
          <div>
            <span className="full-access-capability-icon">
              <Globe size={20} aria-hidden="true" />
            </span>
            <section>
              <strong>Internet and connected apps</strong>
              <p>
                Access websites, send data, and control enabled apps, including through computer
                use.
              </p>
            </section>
          </div>
        </div>
        <p id="full-access-risk">
          This can cause loss or exposure of sensitive data. Malicious content can trick an agent
          into taking unintended actions (prompt injection). You can turn Full access off at any
          time. Explicit deny rules, administrator policies, and operating system permissions still
          apply.
        </p>
        <div className="full-access-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="full-access-confirm" onClick={onConfirm}>
            <AlertTriangle size={16} aria-hidden="true" /> Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

/** Require one explicit acknowledgement before applying a Full access selection. */
export function useFullAccessConfirmation() {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const request = useCallback((fullAccess: boolean, apply: () => void) => {
    if (!fullAccess || hasConfirmedFullAccess()) apply();
    else setPending(() => apply);
  }, []);
  const cancel = useCallback(() => setPending(null), []);
  const confirm = useCallback(() => {
    if (!pending) return;
    confirmFullAccess();
    setPending(null);
    pending();
  }, [pending]);
  const dialog = pending
    ? createPortal(
        <FullAccessConfirmationDialog onConfirm={confirm} onCancel={cancel} />,
        document.body,
      )
    : null;
  return { request, dialog };
}
