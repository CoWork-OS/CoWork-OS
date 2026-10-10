import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type { BrowserSavedLogin } from "../../../electron/preload";

/**
 * A key button that appears when the page being viewed has saved logins. Picking one fills
 * it into the page after the Mac's own approval (Touch ID or a confirmation). The password
 * never passes through this component.
 */
export function SavedLoginsMenu({
  workspaceId,
  taskId,
  sessionId,
  currentUrl,
  onNotice,
}: {
  workspaceId?: string;
  taskId: string;
  sessionId: string;
  currentUrl: string;
  onNotice: (message: string) => void;
}) {
  const [logins, setLogins] = useState<BrowserSavedLogin[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
    if (!workspaceId || !/^https?:/i.test(currentUrl)) {
      setLogins([]);
      return;
    }
    let cancelled = false;
    void window.electronAPI
      .listBrowserLoginsForPage?.({ workspaceId, url: currentUrl })
      .then((result) => {
        if (!cancelled) setLogins(result?.logins ?? []);
      })
      .catch(() => {
        if (!cancelled) setLogins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUrl]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  if (!workspaceId || logins.length === 0) return null;

  const fill = async (login: BrowserSavedLogin) => {
    setBusy(true);
    try {
      const result = await window.electronAPI.fillBrowserLogin({
        workspaceId,
        taskId,
        sessionId,
        id: login.id,
      });
      setOpen(false);
      if (result.success) onNotice("Filled saved login");
      else if (result.code === "no_password_field") onNotice("No password field on this page");
      else if (result.code !== "cancelled") onNotice(result.error || "Could not fill the login");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="browser-workbench-profile-menu" ref={rootRef}>
      <button
        type="button"
        className="browser-workbench-icon-btn"
        title="Saved logins"
        aria-label="Saved logins"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <KeyRound size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="browser-workbench-tab-menu browser-workbench-profile-popover" role="menu">
          <div className="browser-workbench-profile-heading">
            <strong>Saved logins</strong>
            <span>Filled only on this site, after you approve.</span>
          </div>
          {logins.map((login) => (
            <button
              key={login.id}
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void fill(login)}
            >
              {login.username || "(no username)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
