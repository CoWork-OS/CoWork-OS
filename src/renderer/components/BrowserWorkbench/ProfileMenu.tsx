import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";

type BrowserDataType = "cookies" | "cache" | "storage" | "history";

const RANGES: Array<{ label: string; ms: number }> = [
  { label: "Last hour", ms: 60 * 60_000 },
  { label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "All time", ms: 0 },
];

/**
 * The workspace's browser profile: clear browsing data, sign out of all sites,
 * open the page in the system browser, Settings > Browser.
 */
export function ProfileMenu({
  workspaceId,
  currentUrl,
  onOpenExternal,
  onOpenSettings,
  onNotice,
}: {
  workspaceId?: string;
  currentUrl: string;
  onOpenExternal: (url: string) => void;
  onOpenSettings?: () => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [types, setTypes] = useState<Record<BrowserDataType, boolean>>({
    history: true,
    cookies: false,
    cache: true,
    storage: false,
  });
  const [range, setRange] = useState(RANGES[3].ms);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setClearing(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const clearData = async (selected: BrowserDataType[], since?: number) => {
    if (!workspaceId || selected.length === 0) return;
    const result = await window.electronAPI
      .clearBrowserData?.({ workspaceId, types: selected, since })
      .catch(() => null);
    onNotice(result?.success ? "Browsing data cleared" : "Could not clear browsing data");
    setOpen(false);
    setClearing(false);
  };

  return (
    <div className="browser-workbench-profile-menu" ref={rootRef}>
      <button
        type="button"
        className="browser-workbench-icon-btn"
        title="Browser profile"
        aria-label="Browser profile"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <UserRound size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <div className="browser-workbench-tab-menu browser-workbench-profile-popover" role="menu">
          <div className="browser-workbench-profile-heading">
            <strong>Workspace browser profile</strong>
            <span>Cookies, sign-ins, history and site permissions for this workspace.</span>
          </div>
          {clearing ? (
            <div className="browser-workbench-clear-data">
              {(Object.keys(types) as BrowserDataType[]).map((type) => (
                <label key={type}>
                  <input
                    type="checkbox"
                    checked={types[type]}
                    onChange={(event) =>
                      setTypes((current) => ({ ...current, [type]: event.target.checked }))
                    }
                  />
                  {type === "history"
                    ? "Browsing history"
                    : type === "cookies"
                      ? "Cookies (signs you out of sites)"
                      : type === "cache"
                        ? "Cached images and files"
                        : "Site storage"}
                </label>
              ))}
              <label>
                History time range
                <select value={range} onChange={(event) => setRange(Number(event.target.value))}>
                  {RANGES.map((entry) => (
                    <option key={entry.label} value={entry.ms}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="browser-workbench-clear-data-note">
                Cookies, cache and storage are cleared for all time.
              </span>
              <div className="browser-workbench-notice-actions">
                <button type="button" onClick={() => setClearing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() =>
                    void clearData(
                      (Object.keys(types) as BrowserDataType[]).filter((type) => types[type]),
                      range ? Date.now() - range : undefined,
                    )
                  }
                >
                  Clear data
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => setClearing(true)}>
                Clear browsing data…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  if (window.confirm("Sign out of all sites in this workspace's browser?")) {
                    void clearData(["cookies", "storage"]);
                  }
                }}
              >
                Sign out of all sites
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!/^https?:/i.test(currentUrl)}
                onClick={() => {
                  onOpenExternal(currentUrl);
                  setOpen(false);
                }}
              >
                Open page in system browser
              </button>
              {onOpenSettings && (
                <>
                  <div className="browser-workbench-tab-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onOpenSettings();
                      setOpen(false);
                    }}
                  >
                    Browser settings
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
