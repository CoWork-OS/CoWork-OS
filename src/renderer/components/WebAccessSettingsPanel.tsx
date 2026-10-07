import React, { useState, useEffect } from "react";
import { Globe, Copy, Check } from "lucide-react";

interface WebAccessConfig {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  allowedOrigins: string[];
}

interface WebAccessStatus {
  running: boolean;
  browserApplication: boolean;
  url?: string;
  port?: number;
  connectedClients: number;
  startedAt?: number;
}

export const WebAccessSettingsPanel: React.FC = () => {
  const [config, setConfig] = useState<WebAccessConfig>({
    enabled: false,
    port: 3847,
    host: "127.0.0.1",
    token: "",
    allowedOrigins: [],
  });
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);

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

  const loadSettings = async () => {
    try {
      const settings = await (window as Any).electronAPI.getWebAccessSettings();
      if (settings) setConfig(settings);
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
      await (window as Any).electronAPI.saveWebAccessSettings(updates);
      await loadStatus();
    } catch {
      // Save failed
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
      setPairingError(error instanceof Error ? error.message : "Could not create a pairing code.");
    }
  };

  return (
    <div className="settings-section">
      <h2 className="settings-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Globe size={18} />
        Web Access
      </h2>
      <p className="settings-description">
        Manage the local Web Access listener. Browser pairing requires the browser application to be
        enabled on this host with <code>COWORK_WEB_ENABLED=1</code> at startup.
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

            {status?.browserApplication && (
              <div className="settings-field">
                <label>Browser application</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <code>{new URL("/app/", accessUrl).toString()}</code>
                  <button type="button" onClick={() => void createPairingCode()}>
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
              </div>
            )}
            {status?.running && !status.browserApplication && (
              <p role="status">The browser application is not active on this listener.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
