import { useEffect, useState } from "react";
import { SharePointSettingsData } from "../../shared/types";

export function SharePointSettings() {
  const [settings, setSettings] = useState<SharePointSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
  } | null>(null);
  const [status, setStatus] = useState<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  useEffect(() => {
    loadSettings();
    refreshStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getSharePointSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load SharePoint settings:", error);
    }
  };

  const updateSettings = (updates: Partial<SharePointSettingsData>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    try {
      const payload: SharePointSettingsData = { ...settings };
      await window.electronAPI.saveSharePointSettings(payload);
      setSettings(payload);
      await refreshStatus();
    } catch (error) {
      console.error("Failed to save SharePoint settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const refreshStatus = async () => {
    try {
      setStatusLoading(true);
      const result = await window.electronAPI.getSharePointStatus();
      setStatus(result);
    } catch (error) {
      console.error("Failed to load SharePoint status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testSharePointConnection();
      setTestResult(result);
      await refreshStatus();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message || "Failed to test connection" });
    } finally {
      setTesting(false);
    }
  };

  if (!settings) {
    return <div className="settings-loading">Loading SharePoint settings...</div>;
  }

  const statusLabel = !status?.configured
    ? "Missing Token"
    : status.connected
      ? "Connected"
      : "Configured";

  const statusClass = !status?.configured
    ? "missing"
    : status.connected
      ? "connected"
      : "configured";

  return (
    <div className="sharepoint-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-title-with-badge">
            <h3>Connect SharePoint</h3>
            {status && (
              <span
                className={`sharepoint-status-badge ${statusClass}`}
                title={
                  !status.configured
                    ? "Access token not configured"
                    : status.connected
                      ? "Connected to SharePoint"
                      : "Configured"
                }
              >
                {statusLabel}
              </span>
            )}
            {statusLoading && !status && (
              <span className="sharepoint-status-badge configured">Checking…</span>
            )}
          </div>
          <button className="btn-secondary btn-sm" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? "Checking..." : "Refresh Status"}
          </button>
        </div>
        <p className="settings-description">
          Connect the agent to SharePoint using a Microsoft Graph access token, then use the
          built-in `sharepoint_action` tool to search sites and manage drive items.
        </p>
        {status?.error && <p className="settings-hint">Status check: {status.error}</p>}
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() => window.electronAPI.openExternal("https://portal.azure.com")}
          >
            Open Azure Portal
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-field">
          <label>Enable Integration</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => updateSettings({ enabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-field">
          <label>Access Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Microsoft Graph access token"
            value={settings.accessToken || ""}
            onChange={(e) => updateSettings({ accessToken: e.target.value || undefined })}
          />
          <p className="settings-hint">
            Use a token with Sites.ReadWrite.All or Files.ReadWrite.All scope.
          </p>
        </div>

        <div className="settings-field">
          <label>Site ID (optional)</label>
          <input
            type="text"
            className="settings-input"
            placeholder="SharePoint site ID"
            value={settings.siteId || ""}
            onChange={(e) => updateSettings({ siteId: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>Drive ID (optional)</label>
          <input
            type="text"
            className="settings-input"
            placeholder="Default drive ID"
            value={settings.driveId || ""}
            onChange={(e) => updateSettings({ driveId: e.target.value || undefined })}
          />
          <p className="settings-hint">Set a default drive to simplify tool calls.</p>
        </div>

        <div className="settings-field">
          <label>Timeout (ms)</label>
          <input
            type="number"
            className="settings-input"
            min={1000}
            max={120000}
            value={settings.timeoutMs ?? 20000}
            onChange={(e) => updateSettings({ timeoutMs: Number(e.target.value) })}
          />
        </div>

        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handleTestConnection}
            disabled={testing}
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? (
              <span>Connected{testResult.name ? ` as ${testResult.name}` : ""}</span>
            ) : (
              <span>Connection failed: {testResult.error}</span>
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Quick Usage</h4>
        <pre className="settings-info-box">{`// Search sites
sharepoint_action({
  action: "search_sites",
  query: "Marketing"
});

// Upload a file to the default drive
sharepoint_action({
  action: "upload_file",
  file_path: "reports/summary.pdf"
});`}</pre>
      </div>
    </div>
  );
}
