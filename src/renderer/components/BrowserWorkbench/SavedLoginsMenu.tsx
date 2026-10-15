import { Fragment, useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import type {
  BrowserVaultCommand,
  BrowserVaultItem,
  BrowserVaultSource,
} from "../../../shared/browser-vault";

type Source = { source: BrowserVaultSource; installed: boolean; unlocked: boolean };

/** 1Password's listing does not advertise whether an item has an authenticator. */
export function savedVerificationCodeCommand(item: BrowserVaultItem): BrowserVaultCommand | null {
  return item.kind === "login" &&
    (item.hasOtp === true || (item.source !== "local" && item.hasOtp !== false))
    ? { action: "enter_code", handle: item.id }
    : null;
}

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
  const [items, setItems] = useState<BrowserVaultItem[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setOpen(false);
    setItems([]);
    setSources([]);
  }, [workspaceId, currentUrl, taskId, sessionId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    void window.electronAPI
      .browserVaultCommand(taskId, { action: "list", session_id: sessionId })
      .then((result) => {
        if (!cancelled) {
          setItems(Array.isArray(result.items) ? (result.items as BrowserVaultItem[]) : []);
          setSources(Array.isArray(result.sources) ? (result.sources as Source[]) : []);
        }
      })
      .catch(() => {
        if (!cancelled) onNotice("Could not load saved items");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", close);
    };
  }, [open, taskId, sessionId]);
  if (!workspaceId || !/^https?:/i.test(currentUrl)) return null;
  const run = async (command: BrowserVaultCommand) => {
    setOpen(false);
    try {
      const result = await window.electronAPI.browserVaultCommand(taskId, {
        ...command,
        session_id: sessionId,
      });
      onNotice(
        result.success
          ? command.action === "unlock"
            ? "Password manager unlocked"
            : command.action === "lock"
              ? "Password manager locked"
              : "Private browser action complete"
          : result.error === "user_declined"
            ? "Cancelled"
            : "Could not complete private browser action. Check the page and try again.",
      );
    } catch {
      onNotice("Private browser action unavailable");
    }
  };
  return (
    <div className="browser-workbench-profile-menu" ref={rootRef}>
      <button
        type="button"
        className="browser-workbench-icon-btn"
        title="Passwords & autofill"
        aria-label="Passwords & autofill"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <KeyRound size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="browser-workbench-tab-menu browser-workbench-profile-popover" role="menu">
          <div className="browser-workbench-profile-heading">
            <strong>Passwords & autofill</strong>
            <span>Private input, bound to this site.</span>
          </div>
          {busy && <span role="status">Loading saved items…</span>}
          {items.map((item) => {
            const codeCommand = savedVerificationCodeCommand(item);
            return (
              <Fragment key={item.id}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void run({ action: "fill", handle: item.id })}
                >
                  {item.kind === "login"
                    ? item.username || item.label
                    : item.kind === "payment"
                      ? item.label
                      : "Saved address"}{" "}
                  · {item.source}
                </button>
                {codeCommand && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => void run(codeCommand)}
                  >
                    Verification code for {item.username || item.label} · {item.source}
                  </button>
                )}
              </Fragment>
            );
          })}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run({ action: "save_login" })}
          >
            Enter login privately
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run({ action: "enter_code" })}
          >
            Enter verification code privately
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run({ action: "save_item", kind: "address" })}
          >
            Add address for this site
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void run({ action: "save_item", kind: "payment" })}
          >
            Add payment card for this site
          </button>
          {sources
            .filter((source) => source.installed)
            .map((source) => (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                key={source.source}
                onClick={() =>
                  void run({ action: source.unlocked ? "lock" : "unlock", source: source.source })
                }
              >
                {source.unlocked ? "Lock" : "Unlock"}{" "}
                {source.source === "onepassword" ? "1Password" : "Bitwarden"}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
