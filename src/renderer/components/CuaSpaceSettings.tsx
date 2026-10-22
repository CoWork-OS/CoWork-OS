import { useCallback, useEffect, useState } from "react";
import type { CuaSpaceConnectionResult, CuaSpaceDisplaySettings } from "../../shared/cua-space";
import { hasHostMethods } from "../host/browser-capabilities";

function originOf(url: string | undefined): string | null {
  try {
    return new URL((url ?? "").trim()).origin;
  } catch {
    return null;
  }
}

const CUA_SPACE_METHODS = [
  "getCuaSpaceSettings",
  "saveCuaSpaceSettings",
  "testCuaSpaceConnection",
] as const;

/**
 * Optional Computer Use backend: drive a Cua Space instead of this computer. The
 * token field is write-only; the main process reports only whether one is stored.
 */
export function CuaSpaceSettings({
  onEnabledChange,
}: {
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const [settings, setSettings] = useState<CuaSpaceDisplaySettings>();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<CuaSpaceConnectionResult>();
  const available = hasHostMethods(...CUA_SPACE_METHODS);

  const apply = useCallback(
    (next: CuaSpaceDisplaySettings) => {
      setSettings(next);
      setUrl(next.url);
      setToken("");
      onEnabledChange?.(next.enabled);
    },
    [onEnabledChange],
  );

  useEffect(() => {
    if (!available) return;
    window.electronAPI
      .getCuaSpaceSettings()
      .then(apply)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [available, apply]);

  if (!available) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (update: { enabled?: boolean; token?: string | null }) =>
    run(async () => {
      setTest(undefined);
      apply(
        await window.electronAPI.saveCuaSpaceSettings({
          url: url.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          ...update,
        }),
      );
    });

  const testConnection = () =>
    run(async () => {
      setTest(await window.electronAPI.testCuaSpaceConnection());
    });

  const dirty = url.trim() !== (settings?.url ?? "") || token.trim().length > 0;
  // The main process drops the saved token when the Space's origin changes.
  const dropsToken =
    Boolean(settings?.tokenConfigured) &&
    !token.trim() &&
    originOf(url) !== originOf(settings?.url);

  return (
    <section className="settings-section" aria-label="Cua Space">
      <h3>Cua Space</h3>
      <p className="settings-description">
        Run Computer Use inside a Cua Space instead of on this computer. Screenshots, clicks and
        typing then happen in the Space, which you can watch from Cua Spaces. Your own windows are
        not touched while this is on.
      </p>
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="settings-field">
        <label htmlFor="cua-space-url">Space URL</label>
        <input
          id="cua-space-url"
          type="url"
          className="settings-input"
          placeholder="http://127.0.0.1:3211"
          value={url}
          disabled={busy || !settings}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="settings-field">
        <label htmlFor="cua-space-token">Space token</label>
        <input
          id="cua-space-token"
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder={settings?.tokenConfigured ? "Saved — enter a new token to replace it" : ""}
          value={token}
          disabled={busy || !settings}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      {dropsToken ? (
        <p className="settings-description" role="status">
          Saving a different Space address removes the saved token. Enter the token for the new
          Space.
        </p>
      ) : null}
      <p className="settings-description">
        A token is required unless the Space runs on this computer. Plain http is accepted only for
        this computer and private network addresses; use https anywhere else.
      </p>
      <label className="settings-description">
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={busy || !settings || (!settings.enabled && !url.trim())}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />{" "}
        Run Computer Use in this Cua Space
      </label>
      <div className="computer-use-active-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !settings || !dirty}
          onClick={() => void save({})}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !settings?.url || dirty}
          onClick={() => void testConnection()}
        >
          Test connection
        </button>
        {settings?.tokenConfigured ? (
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void save({ token: null })}
          >
            Remove token
          </button>
        ) : null}
      </div>
      {test ? (
        test.reachable ? (
          <p className="settings-description" role="status">
            Connected to the Space.
          </p>
        ) : (
          <div className="settings-error" role="alert">
            {test.error ?? "The Space did not answer."}
          </div>
        )
      ) : null}
    </section>
  );
}
