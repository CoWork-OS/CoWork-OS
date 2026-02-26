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

  useEffect(() => {
    loadSettings();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadSettings = async () => {
    try {
      const settings = await (window as any).electronAPI.getWebAccessSettings();
      if (settings) setConfig(settings);
      await loadStatus();
    } catch {
      // Not available
    }
  };

  const loadStatus = async () => {
    try {
      const s = await (window as any).electronAPI.getWebAccessStatus();
      if (s) setStatus(s);
    } catch {
      // Not available
    }
  };

  const saveSettings = async (updates: Partial<WebAccessConfig>) => {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    try {
      await (window as any).electronAPI.saveWebAccessSettings(updates);
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

  return (
    <div className="settings-section">
      <h2 className="settings-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Globe size={18} />
        Web Access
      </h2>
      <p className="settings-description">
        Access CoWork OS from any browser on your network. When enabled, the UI is served over HTTP
        with token authentication.
      </p>

      <div className="settings-group">
        <label className="settings-toggle-row">
          <span>Enable Web Access</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => saveSettings({ enabled: e.target.checked })}
          />
        </label>

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
                style={{ width: 100 }}
              />
            </div>

            <div className="settings-field">
              <label>Access URL</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <code
                  style={{
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: "var(--surface-secondary, #1a1a1a)",
                  }}
                >
                  {accessUrl}
                </code>
                {status?.running && <span style={{ color: "#22c55e", fontSize: 11 }}>Running</span>}
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
                      background: "var(--surface-secondary, #1a1a1a)",
                      fontSize: 12,
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {config.token.slice(0, 8)}...{config.token.slice(-4)}
                  </code>
                  <button
                    onClick={copyToken}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 8px",
                      border: "1px solid var(--border-color, #333)",
                      borderRadius: 4,
                      background: "none",
                      color: "var(--text-secondary, #999)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}

            {status && (
              <div className="settings-field">
                <label>Status</label>
                <div style={{ fontSize: 12, color: "var(--text-tertiary, #666)" }}>
                  {status.connectedClients} connected client(s)
                  {status.startedAt && (
                    <> &middot; Started {new Date(status.startedAt).toLocaleTimeString()}</>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
