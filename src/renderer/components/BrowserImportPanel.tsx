import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import type {
  BrowserImportableBrowser,
  BrowserImportPrepareResult,
  BrowserSavedLogin,
} from "../../electron/preload";

type Staged = Extract<BrowserImportPrepareResult, { success: true }>;

/** Settings > Browser: bring cookies and saved logins in from another browser or a CSV file. */
export function BrowserImportPanel({
  workspaceId,
  onNotice,
}: {
  workspaceId: string;
  onNotice: (message: string) => void;
}) {
  const [browsers, setBrowsers] = useState<BrowserImportableBrowser[]>([]);
  const [canStore, setCanStore] = useState(true);
  const [browserId, setBrowserId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [cookies, setCookies] = useState(true);
  const [passwords, setPasswords] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [fileToken, setFileToken] = useState("");
  const [logins, setLogins] = useState<BrowserSavedLogin[]>([]);

  const api = window.electronAPI;
  const selected = browsers.find((browser) => browser.id === browserId);

  const loadLogins = useCallback(async () => {
    if (!workspaceId) return;
    const result = await api.listBrowserLogins?.({ workspaceId });
    setLogins(result?.logins ?? []);
  }, [api, workspaceId]);

  useEffect(() => {
    let live = true;
    void api.browserImportDetect?.().then((result) => {
      if (!live || !result) return;
      setBrowsers(result.browsers);
      setCanStore(result.canStorePasswords);
      const first = result.browsers[0];
      if (first) {
        setBrowserId(first.id);
        setProfileId(first.profiles[0]?.id ?? "");
      }
    });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    void loadLogins();
  }, [loadLogins]);

  // A prepared import is abandoned when this panel goes away.
  useEffect(() => {
    return () => {
      if (staged) void api.browserImportCancel?.({ token: staged.token });
    };
  }, [api, staged]);

  const prepare = async (request: Parameters<typeof api.browserImportPrepare>[0]) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.browserImportPrepare(request);
      if (result.success) {
        setStaged(result);
      } else if (result.code !== "cancelled") {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!staged) return;
    setBusy(true);
    setError("");
    const token = staged.token;
    try {
      const result = await api.browserImportCommit({
        workspaceId,
        token,
        cookies: cookies || staged.logins === 0,
        passwords: passwords || staged.cookies === 0,
      });
      setStaged(null);
      if (!result.success) {
        if (result.code !== "cancelled") setError(result.error);
        return;
      }
      const parts = [
        result.logins + result.loginsUpdated > 0
          ? `${result.logins + result.loginsUpdated} saved logins`
          : "",
        result.cookies > 0 ? `${result.cookies} cookies` : "",
      ].filter(Boolean);
      onNotice(`Imported ${parts.join(" and ") || "nothing"}`);
      void loadLogins();
      if (result.canDeleteFile) setFileToken(token);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (staged) void api.browserImportCancel?.({ token: staged.token });
    setStaged(null);
  };

  return (
    <div className="settings-field">
      <label>Import from another browser</label>
      <p className="settings-description">
        Bring in cookies (to stay signed in) and saved logins. Passwords are encrypted with this
        Mac&apos;s secure storage, can&apos;t be viewed or exported from here, and are only filled
        into the exact site they belong to when you choose.
      </p>

      {!staged && (
        <>
          {browsers.length > 0 && (
            <div className="browser-settings-row">
              <select
                aria-label="Browser"
                value={browserId}
                onChange={(event) => {
                  const next = browsers.find((browser) => browser.id === event.target.value);
                  setBrowserId(event.target.value);
                  setProfileId(next?.profiles[0]?.id ?? "");
                }}
              >
                {browsers.map((browser) => (
                  <option key={browser.id} value={browser.id}>
                    {browser.name}
                  </option>
                ))}
              </select>
              {selected && selected.profiles.length > 1 && (
                <select
                  aria-label="Profile"
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                >
                  {selected.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {browsers.length > 0 && (
            <div className="browser-settings-row">
              <label>
                <input
                  type="checkbox"
                  checked={cookies}
                  onChange={(event) => setCookies(event.target.checked)}
                />{" "}
                Cookies
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={passwords && canStore && selected?.kind !== "firefox"}
                  disabled={!canStore || selected?.kind === "firefox"}
                  onChange={(event) => setPasswords(event.target.checked)}
                />{" "}
                Saved logins
              </label>
              <button
                type="button"
                className="settings-button small"
                disabled={busy || !workspaceId || !selected || (!cookies && !passwords)}
                onClick={() =>
                  void prepare({
                    workspaceId,
                    kind: "browser",
                    browserId,
                    profileId,
                    cookies,
                    passwords: passwords && canStore && selected?.kind !== "firefox",
                  })
                }
              >
                {busy ? "Reading…" : "Review import"}
              </button>
            </div>
          )}
          {browsers.length === 0 && (
            <p className="settings-description">No other supported browsers were found.</p>
          )}
          <div className="browser-settings-row">
            <button
              type="button"
              className="settings-button small"
              disabled={busy || !workspaceId || !canStore}
              onClick={() => void prepare({ workspaceId, kind: "csv" })}
            >
              Import passwords from a CSV file…
            </button>
          </div>
          {!canStore && (
            <p className="settings-description">
              Saved logins are unavailable because this Mac&apos;s secure storage can&apos;t be
              used.
            </p>
          )}
          {selected?.kind === "firefox" && (
            <p className="settings-description">
              Firefox passwords can&apos;t be read directly: export them to a CSV file in Firefox
              and import that.
            </p>
          )}
        </>
      )}

      {staged && (
        <div className="browser-import-review">
          <p>
            Ready to import from <strong>{staged.source}</strong>:{" "}
            {staged.logins > 0 && `${staged.logins} saved logins`}
            {staged.logins > 0 && staged.cookies > 0 && " and "}
            {staged.cookies > 0 && `${staged.cookies} cookies`}.
          </p>
          {staged.sampleSites.length > 0 && (
            <p className="settings-description">
              Including {staged.sampleSites.join(", ")}
              {staged.logins + staged.cookies > staged.sampleSites.length ? " and more" : ""}.
            </p>
          )}
          <div className="browser-settings-row">
            <button
              type="button"
              className="settings-button small"
              disabled={busy}
              onClick={() => void commit()}
            >
              Import
            </button>
            <button type="button" className="settings-button small" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {fileToken && (
        <div className="browser-import-review">
          <p>The password file is still on your Mac in plain text.</p>
          <div className="browser-settings-row">
            <button
              type="button"
              className="settings-button small"
              onClick={() =>
                void api.browserImportDeleteFile?.({ token: fileToken }).then((result) => {
                  setFileToken("");
                  if (result?.deleted) onNotice("Password file deleted");
                })
              }
            >
              Delete the file…
            </button>
            <button
              type="button"
              className="settings-button small"
              onClick={() => setFileToken("")}
            >
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="settings-description" role="alert">
          {error}
        </p>
      )}

      {logins.length > 0 && (
        <div className="browser-saved-logins">
          <label>Saved logins ({logins.length})</label>
          <ul className="browser-settings-list">
            {logins.slice(0, 200).map((login) => (
              <li key={login.id}>
                <KeyRound size={13} aria-hidden="true" />
                <span>
                  {new URL(login.origin).host}
                  {login.username ? ` · ${login.username}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove saved login for ${login.origin}`}
                  onClick={() =>
                    void api.removeBrowserLogin?.({ workspaceId, id: login.id }).then(loadLogins)
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="settings-button small"
            onClick={() => void api.clearBrowserLogins?.({ workspaceId }).then(loadLogins)}
          >
            Remove all saved logins…
          </button>
        </div>
      )}
    </div>
  );
}
