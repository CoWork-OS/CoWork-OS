import { useEffect, useState } from "react";
import { XSettingsData } from "../../shared/types";

export function XSettings() {
  const [settings, setSettings] = useState<XSettingsData | null>(null);
  const [cookieSourcesInput, setCookieSourcesInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    username?: string;
    userId?: string;
  } | null>(null);
  const [status, setStatus] = useState<{
    installed: boolean;
    connected: boolean;
    username?: string;
    error?: string;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  useEffect(() => {
    loadSettings();
    refreshStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getXSettings();
      setSettings(loaded);
      setCookieSourcesInput((loaded.cookieSource || []).join(", "));
    } catch (error) {
      console.error("Failed to load X settings:", error);
    }
  };

  const updateSettings = (updates: Partial<XSettingsData>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    try {
      const cookieSource = cookieSourcesInput
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      const payload: XSettingsData = {
        ...settings,
        cookieSource,
      };

      await window.electronAPI.saveXSettings(payload);
      setSettings(payload);
      await refreshStatus();
    } catch (error) {
      console.error("Failed to save X settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const refreshStatus = async () => {
    try {
      setStatusLoading(true);
      const result = await window.electronAPI.getXStatus();
      setStatus(result);
    } catch (error) {
      console.error("Failed to load X status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testXConnection();
      setTestResult(result);
      await refreshStatus();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message || "Failed to test connection" });
    } finally {
      setTesting(false);
    }
  };

  if (!settings) {
    return <div className="settings-loading">Loading X settings...</div>;
  }

  return (
    <div className="x-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-title-with-badge">
            <h3>Connect X (Twitter)</h3>
            {status && (
              <span
                className={`x-status-badge ${!status.installed ? "missing" : status.connected ? "connected" : "installed"}`}
                title={
                  !status.installed
                    ? "Bird CLI not installed"
                    : status.connected
                      ? "Connected to X"
                      : "Bird CLI installed"
                }
              >
                {!status.installed ? "Missing CLI" : status.connected ? "Connected" : "Installed"}
              </span>
            )}
            {statusLoading && !status && (
              <span className="x-status-badge installed">Checking…</span>
            )}
          </div>
          <button className="btn-secondary btn-sm" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? "Checking..." : "Refresh Status"}
          </button>
        </div>
        <p className="settings-description">
          Connect the agent to an X account using the Bird CLI. Log in via your browser or provide
          cookie tokens, then use the built-in `x_action` tool for reading and posting. If a request
          is blocked (rate limit/challenge), the tool now attempts browser fallback automation for
          read and post/reply/follow steps where possible, with manual fallback details when full
          automation is not possible.
        </p>
        {status?.error && <p className="settings-hint">Status check: {status.error}</p>}
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() => window.electronAPI.openExternal("https://x.com")}
          >
            Open X.com
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
          <label>Auth Method</label>
          <select
            className="settings-select"
            value={settings.authMethod}
            onChange={(e) =>
              updateSettings({ authMethod: e.target.value as XSettingsData["authMethod"] })
            }
          >
            <option value="browser">Browser Cookies (Recommended)</option>
            <option value="manual">Manual Cookies (auth_token + ct0)</option>
          </select>
        </div>

        {settings.authMethod === "browser" ? (
          <>
            <div className="settings-field">
              <label>Cookie Sources</label>
              <input
                type="text"
                className="settings-input"
                placeholder="chrome, arc, brave, firefox"
                value={cookieSourcesInput}
                onChange={(e) => setCookieSourcesInput(e.target.value)}
              />
              <p className="settings-hint">
                Comma-separated browser sources used for cookie extraction.
              </p>
            </div>

            <div className="settings-field">
              <label>Chrome/Arc Profile Name (optional)</label>
              <input
                type="text"
                className="settings-input"
                placeholder="Default"
                value={settings.chromeProfile || ""}
                onChange={(e) => updateSettings({ chromeProfile: e.target.value || undefined })}
              />
            </div>

            <div className="settings-field">
              <label>Chrome/Arc Profile Dir (optional)</label>
              <input
                type="text"
                className="settings-input"
                placeholder="/path/to/Browser/Profile"
                value={settings.chromeProfileDir || ""}
                onChange={(e) => updateSettings({ chromeProfileDir: e.target.value || undefined })}
              />
            </div>

            <div className="settings-field">
              <label>Firefox Profile (optional)</label>
              <input
                type="text"
                className="settings-input"
                placeholder="default-release"
                value={settings.firefoxProfile || ""}
                onChange={(e) => updateSettings({ firefoxProfile: e.target.value || undefined })}
              />
            </div>
          </>
        ) : (
          <>
            <div className="settings-field">
              <label>auth_token</label>
              <input
                type="password"
                className="settings-input"
                placeholder="auth_token cookie"
                value={settings.authToken || ""}
                onChange={(e) => updateSettings({ authToken: e.target.value || undefined })}
              />
            </div>

            <div className="settings-field">
              <label>ct0</label>
              <input
                type="password"
                className="settings-input"
                placeholder="ct0 cookie"
                value={settings.ct0 || ""}
                onChange={(e) => updateSettings({ ct0: e.target.value || undefined })}
              />
            </div>
          </>
        )}

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

        <div className="settings-field">
          <label>Cookie Timeout (ms)</label>
          <input
            type="number"
            className="settings-input"
            min={1000}
            max={120000}
            value={settings.cookieTimeoutMs ?? 20000}
            onChange={(e) => updateSettings({ cookieTimeoutMs: Number(e.target.value) })}
          />
        </div>

        <div className="settings-field">
          <label>Quote Depth</label>
          <input
            type="number"
            className="settings-input"
            min={0}
            max={5}
            value={settings.quoteDepth ?? 1}
            onChange={(e) => updateSettings({ quoteDepth: Number(e.target.value) })}
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
              <span>Connected{testResult.username ? ` as @${testResult.username}` : ""}</span>
            ) : (
              <span>Connection failed: {testResult.error}</span>
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Login Help</h4>
        <ol className="settings-hint">
          <li>Install the Bird CLI.</li>
          <li>Log in to X.com in your browser.</li>
          <li>Choose cookie sources and optional profile info, then click “Test Connection”.</li>
        </ol>
        <p className="settings-hint">
          Common cookie sources: <code>chrome</code>, <code>arc</code>, <code>brave</code>,{" "}
          <code>edge</code>, <code>firefox</code>.
        </p>
        <p className="settings-hint">
          Manual auth is supported using the <code>auth_token</code> and <code>ct0</code> cookies.
        </p>
      </div>

      <div className="settings-section">
        <h4>CLI Requirements</h4>
        <p className="settings-description">
          Install the Bird CLI for X access. If posting is blocked, try using the browser tool
          instead.
        </p>
        <pre className="settings-info-box">{`brew install steipete/tap/bird\n# or\nnpm install -g @steipete/bird`}</pre>
      </div>
    </div>
  );
}
