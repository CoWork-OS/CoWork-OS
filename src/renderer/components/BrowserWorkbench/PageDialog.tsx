import { useEffect, useRef } from "react";

export type BrowserPageDialogRequest = {
  dialogId: string;
  tabId: string;
  type?: "alert" | "confirm";
  message?: string;
  origin?: string;
};

function originLabel(origin?: string): string {
  if (!origin) return "This page";
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/**
 * A page's alert or confirm shown over its tab. Once CoWork's debugger
 * is attached to a page Chromium shows no dialog of its own and the page waits
 * for an answer, so the workbench asks instead. CoWork can still answer it with
 * `browser_handle_dialog`; whichever answers first wins.
 */
export function PageDialog({
  dialog,
  onRespond,
}: {
  dialog: BrowserPageDialogRequest;
  onRespond: (dialog: BrowserPageDialogRequest, accept: boolean) => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    okRef.current?.focus();
  }, [dialog.dialogId]);

  const accept = () => onRespond(dialog, true);
  const cancel = () => onRespond(dialog, dialog.type === "alert");

  return (
    <div className="browser-workbench-page-dialog-layer">
      <div
        className="browser-workbench-page-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`${originLabel(dialog.origin)} says`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            accept();
          }
        }}
      >
        <strong>{originLabel(dialog.origin)} says</strong>
        {dialog.message && (
          <p className="browser-workbench-page-dialog-message">{dialog.message}</p>
        )}
        <div className="browser-workbench-page-dialog-actions">
          {dialog.type !== "alert" && (
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          )}
          <button ref={okRef} type="button" className="is-primary" onClick={accept}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
