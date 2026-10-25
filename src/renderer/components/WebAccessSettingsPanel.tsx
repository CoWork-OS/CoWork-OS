import React, { useState, useEffect } from "react";
import { Globe, Copy, Check, ExternalLink, Link2, LogOut } from "lucide-react";

interface WebAccessConfig {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  allowedOrigins: string[];
  browserApp: boolean;
  publicOrigin: string;
}

interface WebAccessStatus {
  running: boolean;
  browserApplication: boolean;
  url?: string;
  port?: number;
  connectedClients: number;
  startedAt?: number;
  signedInBrowsers?: number;
  browserAppUrl?: string;
  browserAppError?: string;
}

interface SignInLink {
  url: string;
  appUrl: string;
  expiresAt: number;
}

type OpenBrowserAppResult = { opened: true; appUrl: string } | { opened: false; link: SignInLink };

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  // Electron prefixes errors thrown in the main process with the channel name.
  return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

export const WebAccessSettingsPanel: React.FC = () => {
  const [config, setConfig] = useState<WebAccessConfig>({
    enabled: false,
    port: 3847,
    host: "127.0.0.1",
    token: "",
    allowedOrigins: [],
    browserApp: false,
    publicOrigin: "",
  });
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [publicOriginDraft, setPublicOriginDraft] = useState("");
  const [publicOriginError, setPublicOriginError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    const timeout = setTimeout(() => setPairing(null), Math.max(0, pairing.expiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [pairing]);

  useEffect(() => {
    loadSettings();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const applyLoadedConfig = (settings: WebAccessConfig) => {
    setConfig(settings);
    setPublicOriginDraft(settings.publicOrigin || "");
  };

  const loadSettings = async () => {
    try {
      const settings = await (window as Any).electronAPI.getWebAccessSettings();
      if (settings) applyLoadedConfig(settings);
      await loadStatus();
    } catch {
      // Not available
    }
  };

  const loadStatus = async () => {
    try {
      const s = await (window as Any).electronAPI.getWebAccessStatus();
      if (s) setStatus(s);
    } catch {
      // Not available
    }
  };

  const saveSettings = async (updates: Partial<WebAccessConfig>) => {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      const saved = await (window as Any).electronAPI.saveWebAccessSettings(updates);
      if (saved) applyLoadedConfig(saved);
      await loadStatus();
    } catch {
      // Save failed
    }
  };

  const savePublicOrigin = async () => {
    const next = publicOriginDraft.trim();
    if (next === (config.publicOrigin || "")) return;
    setPublicOriginError(null);
    try {
      const saved = await (window as Any).electronAPI.saveWebAccessSettings({
        publicOrigin: next,
      });
      if (saved) applyLoadedConfig(saved);
      await loadStatus();
    } catch (error) {
      setPublicOriginError(errorMessage(error, "Could not save the public address."));
    }
  };

  const copyToken = () => {
    if (config.token) {
      navigator.clipboard.writeText(config.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const accessUrl = status?.url || `http://${config.host}:${config.port}`;
  const appUrl = status?.browserAppUrl || new URL("/app/", accessUrl).toString();
  const signedInBrowsers = status?.signedInBrowsers ?? 0;

  const runAction = async (action: () => Promise<void>, fallbackError: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error, fallbackError));
    } finally {
      setBusy(false);
      await loadStatus();
    }
  };

  const copySignInLink = async (link: SignInLink, lead: string) => {
    await navigator.clipboard.writeText(link.url);
    setNotice(
      `${lead} It works once, for the next ${secondsLeft(link.expiresAt)} seconds. Paste it into a browser's address bar.`,
    );
  };

  const openInBrowser = () =>
    runAction(async () => {
      const result: OpenBrowserAppResult = await (
        window as Any
      ).electronAPI.openWebAccessBrowserApp();
      if (result.opened) {
        setNotice("Opened CoWork OS in your browser.");
        return;
      }
      // On this system other local accounts can read the command line a browser starts with.
      await copySignInLink(result.link, "Sign-in link copied.");
    }, "Could not open the browser app.");

  const copyLink = () =>
    runAction(async () => {
      const link: SignInLink = await (window as Any).electronAPI.createWebAccessSignInLink();
      await copySignInLink(link, "Sign-in link copied.");
    }, "Could not create a sign-in link.");

  const signOutAll = () =>
    runAction(async () => {
      const result: { signedOut: number } = await (
        window as Any
      ).electronAPI.signOutWebAccessBrowsers();
      setNotice(
        result.signedOut === 1
          ? "Signed out 1 browser."
          : `Signed out ${result.signedOut} browsers.`,
      );
    }, "Could not sign browsers out.");

  const createPairingCode = async () => {
    setPairingError(null);
    setPairing(null);
    try {
      const result = await (window as Any).electronAPI.createWebAccessPairingCode();
      if (typeof result?.code !== "string" || !Number.isFinite(result.expiresAt)) {
        throw new Error("The host did not return a pairing code.");
      }
      setPairing(result);
    } catch (error) {
      setPairingError(errorMessage(error, "Could not create a pairing code."));
    }
  };

  return (
    <div className="settings-section">
      <h2 className="settings-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Globe size={18} />
        Web Access
      </h2>
      <p className="settings-description">
        Use CoWork OS from a web browser. Web Access runs a listener on this computer; turn on the
        full app to open your workspace, chats, files, Git and terminal in any browser.
      </p>

      <div className="settings-group">
        <div className="settings-section-header">
          <span className="settings-label">Enable Web Access</span>
          <label className="settings-toggle">
            <input
              type="checkbox"
              aria-label="Enable Web Access"
              checked={config.enabled}
              onChange={(e) => saveSettings({ enabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {config.enabled && (
          <>
            <div className="settings-field">
              <label>Port</label>
              <input
                type="number"
                value={config.port}
                min={1024}
                max={65535}
                onChange={(e) => saveSettings({ port: Number(e.target.value) })}
              />
            </div>

            <div className="settings-field">
              <label>Access URL</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <code
                  style={{
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: "var(--color-bg-secondary)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                >
                  {accessUrl}
                </code>
                {status?.running && (
                  <span style={{ color: "var(--color-success)", fontSize: 11 }}>Running</span>
                )}
              </div>
            </div>

            {config.token && (
              <div className="settings-field">
                <label>Access Token</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code
                    style={{
                      padding: "4px 8px",
                      borderRadius: 4,
                      background: "var(--color-bg-secondary)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text)",
                      fontSize: 12,
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {config.token.slice(0, 8)}...{config.token.slice(-4)}
                  </code>
                  <button className="settings-button small" onClick={copyToken}>
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            {status && (
              <div className="settings-field">
                <label>Status</label>
                <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                  {status.connectedClients} connected client(s)
                  {status.startedAt && (
                    <> &middot; Started {new Date(status.startedAt).toLocaleTimeString()}</>
                  )}
                </div>
              </div>
            )}

            <div className="settings-section-header">
              <span className="settings-label">Full app in the browser</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Full app in the browser"
                  checked={config.browserApp}
                  onChange={(e) => saveSettings({ browserApp: e.target.checked })}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              Serves the whole CoWork OS app at <code>/app/</code>. A browser signs in with a
              one-use link from this computer, never with a password or the access token.
            </p>

            {config.browserApp && (
              <>
                {status?.browserApplication && (
                  <div className="settings-field">
                    <label>Browser app</label>
                    <div className="web-access-actions">
                      <button
                        type="button"
                        className="settings-button primary"
                        disabled={busy}
                        onClick={() => void openInBrowser()}
                      >
                        <ExternalLink size={12} />
                        Open in browser
                      </button>
                      <button
                        type="button"
                        className="settings-button"
                        disabled={busy}
                        onClick={() => void copyLink()}
                      >
                        <Link2 size={12} />
                        Copy sign-in link
                      </button>
                      <button
                        type="button"
                        className="settings-button"
                        disabled={busy || signedInBrowsers === 0}
                        onClick={() => void signOutAll()}
                      >
                        <LogOut size={12} />
                        Sign out all browsers
                      </button>
                    </div>
                    <div className="web-access-app-meta">
                      <code>{appUrl}</code> &middot;{" "}
                      {signedInBrowsers === 1
                        ? "1 browser signed in"
                        : `${signedInBrowsers} browsers signed in`}
                    </div>
                    {notice && (
                      <p className="settings-hint" role="status">
                        {notice}
                      </p>
                    )}
                    {actionError && <p role="alert">{actionError}</p>}
                    <p className="settings-hint">
                      From a terminal on this computer, <code>cowork web</code> opens it too.
                    </p>
                  </div>
                )}

                {status?.browserAppError && <p role="alert">{status.browserAppError}</p>}
                {status?.running && !status.browserApplication && !status.browserAppError && (
                  <p role="status">The browser app is starting on this listener.</p>
                )}

                <div className="settings-field">
                  <label htmlFor="web-access-public-origin">Public HTTPS address</label>
                  <input
                    id="web-access-public-origin"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    placeholder="https://my-mac.example.ts.net"
                    value={publicOriginDraft}
                    aria-invalid={Boolean(publicOriginError)}
                    onChange={(e) => setPublicOriginDraft(e.target.value)}
                    onBlur={() => void savePublicOrigin()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void savePublicOrigin();
                    }}
                  />
                  {publicOriginError && <p role="alert">{publicOriginError}</p>}
                  <p className="settings-hint">
                    To use the app from another device, put an HTTPS proxy on this computer in front
                    of <code>{`http://127.0.0.1:${config.port}`}</code>, such as{" "}
                    <code>{`tailscale serve --bg ${config.port}`}</code>, and enter its address
                    here. The proxy must keep the Host header and send{" "}
                    <code>X-Forwarded-Proto: https</code>. Then use Copy sign-in link and open it on
                    the other device. Changing this address signs every browser out. Leave it empty
                    to use the app only on this computer.
                  </p>
                </div>

                {status?.browserApplication && (
                  <div className="settings-field">
                    <label>Pairing code</label>
                    <div className="web-access-actions">
                      <button
                        type="button"
                        className="settings-button small"
                        onClick={() => void createPairingCode()}
                      >
                        Generate pairing code
                      </button>
                    </div>
                    {pairing && (
                      <p role="status">
                        Pairing code: <code>{pairing.code}</code> · Expires at{" "}
                        {new Date(pairing.expiresAt).toLocaleTimeString()}
                      </p>
                    )}
                    {pairingError && <p role="alert">{pairingError}</p>}
                    <p className="settings-hint">
                      For a browser that cannot open a link: type the code on its sign-in page.
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
