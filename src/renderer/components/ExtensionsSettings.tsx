import { useState, useEffect, type ReactNode } from "react";
import { MessageCircle, Wrench, Bot, Plug, Package } from "lucide-react";
import { ExtensionData, TunnelStatusData } from "../../shared/types";

type ExtensionType = "channel" | "tool" | "provider" | "integration";
type ExtensionState = "loading" | "loaded" | "registered" | "active" | "error" | "disabled";

export function ExtensionsSettings() {
  const [extensions, setExtensions] = useState<ExtensionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedExtension, setSelectedExtension] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Tunnel state
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatusData | null>(null);
  const [tunnelProvider, setTunnelProvider] = useState<"ngrok" | "localtunnel">("ngrok");
  const [tunnelPort, setTunnelPort] = useState(3000);
  const [ngrokAuthToken, setNgrokAuthToken] = useState("");

  useEffect(() => {
    loadExtensions();
    loadTunnelStatus();
  }, []);

  const loadExtensions = async () => {
    try {
      setLoading(true);
      const data = await window.electronAPI.getExtensions();
      setExtensions(data || []);
    } catch (error) {
      console.error("Failed to load extensions:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadTunnelStatus = async () => {
    try {
      const status = await window.electronAPI.getTunnelStatus();
      setTunnelStatus(status);
    } catch (error) {
      console.error("Failed to load tunnel status:", error);
    }
  };

  const handleSelectExtension = (name: string) => {
    setSelectedExtension(selectedExtension === name ? null : name);
  };

  const handleEnableExtension = async (name: string) => {
    try {
      setSaving(true);
      const result = await window.electronAPI.enableExtension(name);
      if (result.success) {
        setMessage({ type: "success", text: `Extension "${name}" enabled` });
        await loadExtensions();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to enable extension" });
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisableExtension = async (name: string) => {
    try {
      setSaving(true);
      const result = await window.electronAPI.disableExtension(name);
      if (result.success) {
        setMessage({ type: "success", text: `Extension "${name}" disabled` });
        await loadExtensions();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to disable extension" });
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleReloadExtension = async (name: string) => {
    try {
      setSaving(true);
      const result = await window.electronAPI.reloadExtension(name);
      if (result.success) {
        setMessage({ type: "success", text: `Extension "${name}" reloaded` });
        await loadExtensions();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to reload extension" });
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscoverExtensions = async () => {
    try {
      setSaving(true);
      await window.electronAPI.discoverExtensions();
      setMessage({ type: "success", text: "Extensions discovered and loaded" });
      await loadExtensions();
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleStartTunnel = async () => {
    try {
      setSaving(true);
      const result = await window.electronAPI.startTunnel({
        provider: tunnelProvider,
        port: tunnelPort,
        ngrokAuthToken: ngrokAuthToken || undefined,
      });
      if (result.success) {
        setMessage({ type: "success", text: `Tunnel started: ${result.url}` });
        await loadTunnelStatus();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to start tunnel" });
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleStopTunnel = async () => {
    try {
      setSaving(true);
      const result = await window.electronAPI.stopTunnel();
      if (result.success) {
        setMessage({ type: "success", text: "Tunnel stopped" });
        await loadTunnelStatus();
      } else {
        setMessage({ type: "error", text: result.error || "Failed to stop tunnel" });
      }
    } catch (error: any) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const getStateColor = (state: ExtensionState): string => {
    switch (state) {
      case "active":
        return "var(--color-success)";
      case "registered":
      case "loaded":
        return "var(--color-warning)";
      case "error":
        return "var(--color-error)";
      case "disabled":
        return "var(--color-text-secondary)";
      default:
        return "var(--color-text-secondary)";
    }
  };

  const getTypeIcon = (type: ExtensionType): ReactNode => {
    const p = { size: 16, strokeWidth: 1.5 } as const;
    switch (type) {
      case "channel":
        return <MessageCircle {...p} />;
      case "tool":
        return <Wrench {...p} />;
      case "provider":
        return <Bot {...p} />;
      case "integration":
        return <Plug {...p} />;
      default:
        return <Package {...p} />;
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading extensions...</div>;
  }

  return (
    <div className="extensions-settings">
      <div className="settings-section">
        <h3>Extensions</h3>
        <p className="settings-description">
          Manage installed extensions that add new channels, tools, and integrations.
        </p>

        {message && <div className={`settings-callout ${message.type}`}>{message.text}</div>}

        <div className="settings-field">
          <button className="settings-button" onClick={handleDiscoverExtensions} disabled={saving}>
            {saving ? "Scanning..." : "Scan for Extensions"}
          </button>
          <p className="settings-hint">Scan extension directories for new plugins</p>
        </div>

        {extensions.length === 0 ? (
          <div className="settings-callout info">
            <strong>No extensions installed</strong>
            <p style={{ marginTop: "8px" }}>Extensions can be installed in:</p>
            <ul style={{ margin: "8px 0 0 20px", padding: 0 }}>
              <li>
                <code>~/.cowork/extensions/</code>
              </li>
              <li>
                <code>~/Library/Application Support/cowork-os/extensions/</code>
              </li>
            </ul>
            <p style={{ marginTop: "8px", fontSize: "13px" }}>
              Each extension should have a <code>cowork.plugin.json</code> manifest file.
            </p>
          </div>
        ) : (
          <div className="extensions-list">
            {extensions.map((ext) => (
              <div
                key={ext.name}
                className={`extension-item ${selectedExtension === ext.name ? "selected" : ""}`}
                onClick={() => handleSelectExtension(ext.name)}
              >
                <div className="extension-icon">{getTypeIcon(ext.type)}</div>
                <div className="extension-info">
                  <div className="extension-name">
                    {ext.displayName || ext.name}
                    <span className="extension-version">v{ext.version}</span>
                  </div>
                  <div className="extension-description">{ext.description}</div>
                  <div className="extension-meta">
                    <span className="extension-state" style={{ color: getStateColor(ext.state) }}>
                      {ext.state}
                    </span>
                    <span className="extension-type">{ext.type}</span>
                    {ext.author && <span className="extension-author">by {ext.author}</span>}
                  </div>
                </div>
                <div className="extension-actions">
                  {ext.state === "active" || ext.state === "registered" ? (
                    <button
                      className="settings-button small"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDisableExtension(ext.name);
                      }}
                      disabled={saving}
                    >
                      Disable
                    </button>
                  ) : ext.state === "disabled" ? (
                    <button
                      className="settings-button small primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEnableExtension(ext.name);
                      }}
                      disabled={saving}
                    >
                      Enable
                    </button>
                  ) : null}
                  <button
                    className="settings-button small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReloadExtension(ext.name);
                    }}
                    disabled={saving}
                  >
                    Reload
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>Webhook Tunnel</h3>
        <p className="settings-description">
          Create a public URL for webhook-based channels (Telegram, Discord, Slack).
        </p>

        {tunnelStatus && tunnelStatus.status !== "stopped" && (
          <div className="settings-status">
            <div className="status-row">
              <span className="status-label">Status:</span>
              <span className={`status-value status-${tunnelStatus.status}`}>
                {tunnelStatus.status === "running"
                  ? "Running"
                  : tunnelStatus.status === "starting"
                    ? "Starting..."
                    : tunnelStatus.status === "error"
                      ? "Error"
                      : "Stopped"}
              </span>
            </div>
            {tunnelStatus.url && (
              <div className="status-row">
                <span className="status-label">URL:</span>
                <code className="status-value">{tunnelStatus.url}</code>
              </div>
            )}
            {tunnelStatus.provider && (
              <div className="status-row">
                <span className="status-label">Provider:</span>
                <span className="status-value">{tunnelStatus.provider}</span>
              </div>
            )}
            {tunnelStatus.error && (
              <div className="status-row">
                <span className="status-label">Error:</span>
                <span className="status-value error">{tunnelStatus.error}</span>
              </div>
            )}
          </div>
        )}

        {(!tunnelStatus || tunnelStatus.status === "stopped") && (
          <>
            <div className="settings-field">
              <label>Tunnel Provider</label>
              <select
                className="settings-select"
                value={tunnelProvider}
                onChange={(e) => setTunnelProvider(e.target.value as "ngrok" | "localtunnel")}
              >
                <option value="ngrok">ngrok</option>
                <option value="localtunnel">localtunnel</option>
              </select>
              <p className="settings-hint">
                ngrok requires an account for persistent URLs. localtunnel is free but less
                reliable.
              </p>
            </div>

            <div className="settings-field">
              <label>Local Port</label>
              <input
                type="number"
                className="settings-input"
                value={tunnelPort}
                onChange={(e) => setTunnelPort(parseInt(e.target.value) || 3000)}
              />
              <p className="settings-hint">The local port to tunnel (default: 3000)</p>
            </div>

            {tunnelProvider === "ngrok" && (
              <div className="settings-field">
                <label>ngrok Auth Token (optional)</label>
                <input
                  type="password"
                  className="settings-input"
                  value={ngrokAuthToken}
                  onChange={(e) => setNgrokAuthToken(e.target.value)}
                  placeholder="Your ngrok auth token"
                />
                <p className="settings-hint">
                  Get your auth token from{" "}
                  <a
                    href="https://dashboard.ngrok.com/get-started/your-authtoken"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ngrok dashboard
                  </a>
                </p>
              </div>
            )}
          </>
        )}

        <div className="settings-actions">
          {tunnelStatus?.status === "running" ? (
            <button className="settings-button danger" onClick={handleStopTunnel} disabled={saving}>
              {saving ? "Stopping..." : "Stop Tunnel"}
            </button>
          ) : (
            <button
              className="settings-button primary"
              onClick={handleStartTunnel}
              disabled={saving}
            >
              {saving ? "Starting..." : "Start Tunnel"}
            </button>
          )}
        </div>
      </div>

      <style>{`
        .extensions-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-top: 16px;
        }

        .extension-item {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 16px;
          background: var(--color-bg-secondary);
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.2s;
        }

        .extension-item:hover {
          background: var(--color-bg-tertiary);
        }

        .extension-item.selected {
          border: 1px solid var(--color-accent);
        }

        .extension-icon {
          font-size: 24px;
          line-height: 1;
        }

        .extension-info {
          flex: 1;
          min-width: 0;
        }

        .extension-name {
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .extension-version {
          font-size: 12px;
          color: var(--color-text-secondary);
          font-weight: normal;
        }

        .extension-description {
          font-size: 13px;
          color: var(--color-text-secondary);
          margin-top: 4px;
        }

        .extension-meta {
          display: flex;
          gap: 12px;
          margin-top: 8px;
          font-size: 12px;
        }

        .extension-state {
          font-weight: 500;
          text-transform: capitalize;
        }

        .extension-type {
          color: var(--color-text-secondary);
          text-transform: capitalize;
        }

        .extension-author {
          color: var(--color-text-secondary);
        }

        .extension-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        .settings-button.small {
          padding: 4px 12px;
          font-size: 12px;
        }

        .settings-status {
          background: var(--color-bg-secondary);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 16px;
        }

        .status-row {
          display: flex;
          gap: 12px;
          margin-bottom: 8px;
        }

        .status-row:last-child {
          margin-bottom: 0;
        }

        .status-label {
          color: var(--color-text-secondary);
          min-width: 80px;
        }

        .status-value {
          font-weight: 500;
        }

        .status-value.status-running {
          color: var(--color-success);
        }

        .status-value.status-starting {
          color: var(--color-warning);
        }

        .status-value.status-error {
          color: var(--color-error);
        }

        .status-value.error {
          color: var(--color-error);
        }

        .settings-actions {
          display: flex;
          gap: 12px;
          margin-top: 16px;
        }
      `}</style>
    </div>
  );
}
