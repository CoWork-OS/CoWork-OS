import { useEffect, useState } from "react";
import { GoogleWorkspaceSettingsData } from "../../shared/types";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
];

const DEFAULT_TIMEOUT_MS = 20000;

const scopesToText = (scopes?: string[]) =>
  scopes && scopes.length > 0 ? scopes.join(" ") : DEFAULT_SCOPES.join(" ");

const textToScopes = (value: string) =>
  value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

export function GoogleWorkspaceSettings() {
  const [settings, setSettings] = useState<GoogleWorkspaceSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
    email?: string;
  } | null>(null);
  const [status, setStatus] = useState<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
    refreshStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getGoogleWorkspaceSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load Google Workspace settings:", error);
    }
  };

  const updateSettings = (updates: Partial<GoogleWorkspaceSettingsData>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    try {
      const payload: GoogleWorkspaceSettingsData = { ...settings };
      await window.electronAPI.saveGoogleWorkspaceSettings(payload);
      setSettings(payload);
      await refreshStatus();
    } catch (error) {
      console.error("Failed to save Google Workspace settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const refreshStatus = async () => {
    try {
      setStatusLoading(true);
      const result = await window.electronAPI.getGoogleWorkspaceStatus();
      setStatus(result);
    } catch (error) {
      console.error("Failed to load Google Workspace status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testGoogleWorkspaceConnection();
      setTestResult(result);
      await refreshStatus();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message || "Failed to test connection" });
    } finally {
      setTesting(false);
    }
  };

  const handleOAuthConnect = async () => {
    if (!settings?.clientId) {
      setOauthError("Client ID is required to start OAuth.");
      return;
    }

    setOauthBusy(true);
    setOauthError(null);

    try {
      const scopes =
        settings.scopes && settings.scopes.length > 0 ? settings.scopes : DEFAULT_SCOPES;
      const result = await window.electronAPI.startGoogleWorkspaceOAuth({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret || undefined,
        scopes,
      });

      const tokenExpiresAt = result.expiresIn
        ? Date.now() + result.expiresIn * 1000
        : settings.tokenExpiresAt;

      const payload: GoogleWorkspaceSettingsData = {
        ...settings,
        enabled: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || settings.refreshToken,
        tokenExpiresAt,
        scopes: result.scopes || scopes,
      };

      await window.electronAPI.saveGoogleWorkspaceSettings(payload);
      setSettings(payload);
      await refreshStatus();
    } catch (error: Any) {
      setOauthError(error.message || "Google Workspace OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  if (!settings) {
    return <div className="settings-loading">Loading Google Workspace settings...</div>;
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
    <div className="google-workspace-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-title-with-badge">
            <h3>Connect Google Workspace</h3>
            {status && (
              <span
                className={`google-workspace-status-badge ${statusClass}`}
                title={
                  !status.configured
                    ? "Tokens not configured"
                    : status.connected
                      ? "Connected to Google Workspace"
                      : "Configured"
                }
              >
                {statusLabel}
              </span>
            )}
            {statusLoading && !status && (
              <span className="google-workspace-status-badge configured">Checking…</span>
            )}
          </div>
          <button className="btn-secondary btn-sm" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? "Checking..." : "Refresh Status"}
          </button>
        </div>
        <p className="settings-description">
          Connect Gmail, Calendar, and Drive with a single Google Workspace OAuth flow. After
          connecting, use `google_drive_action`, `gmail_action`, and `calendar_action` tools in
          tasks.
        </p>
        {status?.error && <p className="settings-hint">Status check: {status.error}</p>}
        {oauthError && <p className="settings-hint">OAuth error: {oauthError}</p>}
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() =>
              window.electronAPI.openExternal("https://console.cloud.google.com/apis/credentials")
            }
          >
            Open Google Cloud Console
          </button>
          <button className="btn-primary btn-sm" onClick={handleOAuthConnect} disabled={oauthBusy}>
            {oauthBusy ? "Connecting..." : "Connect"}
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
          <label>Client ID</label>
          <input
            type="text"
            className="settings-input"
            placeholder="Google OAuth client ID"
            value={settings.clientId || ""}
            onChange={(e) => updateSettings({ clientId: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>Client Secret (optional)</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Google OAuth client secret"
            value={settings.clientSecret || ""}
            onChange={(e) => updateSettings({ clientSecret: e.target.value || undefined })}
          />
          <p className="settings-hint">
            Use an OAuth client configured for Desktop or Web applications.
          </p>
        </div>

        <div className="settings-field">
          <label>Scopes</label>
          <textarea
            className="settings-input"
            rows={3}
            value={scopesToText(settings.scopes)}
            onChange={(e) => updateSettings({ scopes: textToScopes(e.target.value) })}
          />
          <p className="settings-hint">Space-separated scopes used during OAuth.</p>
        </div>

        <div className="settings-field">
          <label>Access Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Google OAuth access token"
            value={settings.accessToken || ""}
            onChange={(e) => updateSettings({ accessToken: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>Refresh Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Google OAuth refresh token"
            value={settings.refreshToken || ""}
            onChange={(e) => updateSettings({ refreshToken: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>Token Expires At (ms)</label>
          <input
            type="number"
            className="settings-input"
            min={0}
            value={settings.tokenExpiresAt ?? ""}
            onChange={(e) =>
              updateSettings({ tokenExpiresAt: Number(e.target.value) || undefined })
            }
          />
          <p className="settings-hint">Used for auto-refresh; set automatically after OAuth.</p>
        </div>

        <div className="settings-field">
          <label>Timeout (ms)</label>
          <input
            type="number"
            className="settings-input"
            min={1000}
            max={120000}
            value={settings.timeoutMs ?? DEFAULT_TIMEOUT_MS}
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
        <pre className="settings-info-box">{`// Search Drive files
google_drive_action({
  action: "list_files",
  query: "modifiedTime > '2026-02-01T00:00:00Z'",
  page_size: 10
});

// Search Gmail
gmail_action({
  action: "list_messages",
  query: "from:me newer_than:7d"
});

// List upcoming calendar events
calendar_action({
  action: "list_events",
  time_min: "2026-02-05T00:00:00Z",
  max_results: 10
});`}</pre>
      </div>
    </div>
  );
}
