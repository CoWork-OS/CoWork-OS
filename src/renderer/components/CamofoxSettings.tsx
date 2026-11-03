import { useCallback, useEffect, useState } from "react";
import {
  camofoxStartCommand,
  type CamofoxConnectionResult,
  type CamofoxDisplaySettings,
  type CamofoxSettingsUpdate,
} from "../../shared/camofox";
import { hasHostMethods } from "../host/browser-capabilities";

const CAMOFOX_METHODS = [
  "getCamofoxSettings",
  "saveCamofoxSettings",
  "testCamofoxConnection",
] as const;

function originOf(url: string | undefined): string | null {
  try {
    return new URL((url ?? "").trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Settings > Browser > Camofox: an opt-in browser the user runs on this Mac. The key fields
 * are write-only; the main process reports only whether a key is stored.
 */
export function CamofoxSettingsGroup() {
  const [settings, setSettings] = useState<CamofoxDisplaySettings>();
  const [serverUrl, setServerUrl] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<CamofoxConnectionResult>();
  const [copied, setCopied] = useState(false);
  const available = hasHostMethods(...CAMOFOX_METHODS);
  const canCopy = hasHostMethods("copyCamofoxStartCommand");

  const apply = useCallback((next: CamofoxDisplaySettings) => {
    setSettings(next);
    setServerUrl(next.serverUrl);
    setProxyPort(String(next.proxyPort));
    setAccessKey("");
    setApiKey("");
  }, []);

  useEffect(() => {
    if (!available) return;
    window.electronAPI
      .getCamofoxSettings()
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

  const save = (update: CamofoxSettingsUpdate) =>
    run(async () => {
      setTest(undefined);
      setCopied(false);
      const port = Number(proxyPort.trim());
      apply(
        await window.electronAPI.saveCamofoxSettings({
          serverUrl: serverUrl.trim(),
          ...(Number.isInteger(port) ? { proxyPort: port } : {}),
          ...(accessKey.trim() ? { accessKey: accessKey.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...update,
        }),
      );
    });

  const dirty =
    serverUrl.trim() !== (settings?.serverUrl ?? "") ||
    proxyPort.trim() !== String(settings?.proxyPort ?? "") ||
    accessKey.trim().length > 0 ||
    apiKey.trim().length > 0;
  // The main process drops saved keys when the server's origin changes.
  const dropsKeys =
    Boolean(settings?.accessKeyConfigured || settings?.apiKeyConfigured) &&
    originOf(serverUrl) !== originOf(settings?.serverUrl);
  const command = settings ? camofoxStartCommand(settings.serverUrl, settings.proxyPort) : "";

  return (
    <div className="settings-group" aria-label="Camofox">
      <h3 className="settings-label">Camofox</h3>
      <p className="settings-description">
        An optional Firefox-based browser with fingerprint spoofing that you run on this Mac
        (github.com/jo-inc/camofox-browser). CoWork uses it only when you ask for Camofox, and only
        while its traffic goes through CoWork&apos;s network policy. Respect each site&apos;s terms
        when you use it.
      </p>
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="settings-field">
        <label className="settings-label" htmlFor="camofox-server-url">
          Server URL
        </label>
        <input
          id="camofox-server-url"
          type="url"
          className="settings-input"
          placeholder="http://127.0.0.1:9377"
          value={serverUrl}
          disabled={busy || !settings}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <p className="settings-description">Must be on this Mac (127.0.0.1 or [::1]).</p>
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="camofox-proxy-port">
          Policy proxy port
        </label>
        <input
          id="camofox-proxy-port"
          type="number"
          className="settings-input"
          min={1024}
          max={65535}
          value={proxyPort}
          disabled={busy || !settings}
          onChange={(e) => setProxyPort(e.target.value)}
        />
        <p className="settings-description">
          CoWork checks every request Camofox makes on this port. Start Camofox with:
        </p>
        {command ? <pre className="browser-settings-code">{command}</pre> : null}
        <p className="settings-description">
          The proxy password is made by CoWork and only Camofox should know it. Copy the command to
          get it, then fill in your access key.
        </p>
        {canCopy ? (
          <div className="computer-use-active-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={busy || !settings || dirty}
              onClick={() =>
                void run(async () => {
                  setCopied(false);
                  await window.electronAPI.copyCamofoxStartCommand();
                  setCopied(true);
                })
              }
            >
              Copy start command
            </button>
            {copied ? (
              <span className="settings-description" role="status">
                Copied, with the proxy password.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="camofox-access-key">
          Access key
        </label>
        <input
          id="camofox-access-key"
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder={
            settings?.accessKeyConfigured
              ? "Saved — enter a new key to replace it"
              : "Required: the CAMOFOX_ACCESS_KEY you start Camofox with"
          }
          value={accessKey}
          disabled={busy || !settings}
          onChange={(e) => setAccessKey(e.target.value)}
        />
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="camofox-api-key">
          Cookie import key (optional)
        </label>
        <input
          id="camofox-api-key"
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder={
            settings?.apiKeyConfigured
              ? "Saved — enter a new key to replace it"
              : "CAMOFOX_API_KEY, if you set one"
          }
          value={apiKey}
          disabled={busy || !settings}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      {dropsKeys ? (
        <p className="settings-description" role="status">
          Saving a different server address removes the saved keys.
        </p>
      ) : null}
      <label className="settings-description">
        <input
          type="checkbox"
          checked={settings?.persistentIdentity ?? false}
          disabled={busy || !settings}
          onChange={(e) => void save({ persistentIdentity: e.target.checked })}
        />{" "}
        Keep one Camofox identity per workspace (cookies and sign-ins carry across tasks)
      </label>
      <p className="settings-description">
        Saved cookies you let CoWork load never go into this shared identity. They load into one for
        that task only, so each task asks again.
      </p>
      <p className="settings-description">
        Camofox keeps each identity&apos;s cookies unencrypted in ~/.camofox/profiles unless you set{" "}
        <code>
          &quot;persistence&quot;: {"{"} &quot;enabled&quot;: false {"}"}
        </code>{" "}
        in its camofox.config.json. Saved cookies you let CoWork load are deleted from there when
        their task ends.
      </p>
      <label className="settings-description">
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={
            busy ||
            !settings ||
            (!settings.enabled && !settings.accessKeyConfigured && !accessKey.trim())
          }
          onChange={(e) => void save({ enabled: e.target.checked })}
        />{" "}
        Let CoWork use Camofox when you ask for it
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
          disabled={busy || !settings?.enabled || dirty}
          onClick={() =>
            void run(async () => {
              setTest(await window.electronAPI.testCamofoxConnection());
            })
          }
        >
          Check connection
        </button>
        {settings?.accessKeyConfigured || settings?.apiKeyConfigured ? (
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void save({ accessKey: null, apiKey: null, enabled: false })}
          >
            Remove keys
          </button>
        ) : null}
      </div>
      {test ? (
        test.reachable && test.proxied ? (
          <p className="settings-description" role="status">
            Camofox is running and browsing through CoWork&apos;s network policy.
          </p>
        ) : (
          <div className="settings-error" role="alert">
            {test.error ?? "Camofox did not answer."}
          </div>
        )
      ) : null}
    </div>
  );
}
