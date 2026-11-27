import { useCallback, useEffect, useState } from "react";
import type { AlwaysAllowedComputerUseApp } from "../../shared/computer-use-contract";

/**
 * The apps computer use controls without asking in sessions the user started. Apps are added
 * from an approval ("Always allow"); here they can only be removed.
 */
export function AlwaysAllowedAppsList({ disabled = false }: { disabled?: boolean }) {
  const [apps, setApps] = useState<AlwaysAllowedComputerUseApp[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Not offered where computer use is not (the app served in a browser).
    if (typeof window.electronAPI?.listAlwaysAllowedApps !== "function") {
      setApps([]);
      return;
    }
    try {
      const list = await window.electronAPI.listAlwaysAllowedApps();
      setApps(Array.isArray(list) ? list : []);
    } catch {
      setApps([]);
      setError("Couldn't load the always-allowed apps.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (bundleId: string) => {
    setRemoving(bundleId);
    setError(null);
    try {
      setApps(await window.electronAPI.removeAlwaysAllowedApp(bundleId));
    } catch {
      setError("Couldn't remove that app. Try again.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="builtin-tool-allowed-apps" aria-label="Always allowed apps">
      <div className="builtin-tool-advanced-text">
        <div className="builtin-tool-advanced-label">Always allowed apps</div>
        <div className="builtin-tool-advanced-hint">
          Controlled without asking, in the background and visibly, in sessions you start. Bots and
          automated sessions still ask. Add an app by choosing Always allow when CoWork asks to
          control it.
        </div>
      </div>
      {apps === null ? null : apps.length === 0 ? (
        <div className="builtin-tool-allowed-apps-empty">No apps yet.</div>
      ) : (
        <ul className="builtin-tool-allowed-apps-list">
          {apps.map((app) => (
            <li key={app.bundleId} className="builtin-tool-allowed-app">
              <span className="builtin-tool-allowed-app-text">
                <span className="builtin-tool-allowed-app-name">{app.name}</span>
                <span className="builtin-tool-allowed-app-id">{app.bundleId}</span>
              </span>
              <button
                type="button"
                className="builtin-tool-allowed-app-remove"
                onClick={() => void remove(app.bundleId)}
                disabled={disabled || removing !== null}
                aria-label={`Stop always allowing ${app.name}`}
              >
                {removing === app.bundleId ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="builtin-tool-allowed-apps-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
