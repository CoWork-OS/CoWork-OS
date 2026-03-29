import { useEffect, useRef, useState } from "react";
import { GoogleWorkspaceSettingsData } from "../../shared/types";
import { GOOGLE_WORKSPACE_DEFAULT_SCOPES } from "../../shared/google-workspace";

const DEFAULT_TIMEOUT_MS = 20000;

const scopesToText = (scopes?: string[]) =>
  scopes && scopes.length > 0 ? scopes.join(" ") : GOOGLE_WORKSPACE_DEFAULT_SCOPES.join(" ");

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
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const linkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadSettings();
    refreshStatus();
    return () => {
      if (linkPollRef.current !== null) {
        clearInterval(linkPollRef.current);
      }
    };
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
        settings.scopes && settings.scopes.length > 0
          ? settings.scopes
          : GOOGLE_WORKSPACE_DEFAULT_SCOPES;
      const result = await window.electronAPI.startGoogleWorkspaceOAuth({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret || undefined,
        scopes,
        loginHint: settings.loginHint || undefined,
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

  const handleCopyLink = async () => {
    if (!settings?.clientId) {
      setOauthError("Client ID is required to generate the OAuth link.");
      return;
    }

    setLinkBusy(true);
    setLinkCopied(false);
    setOauthError(null);

    try {
      const scopes =
        settings.scopes && settings.scopes.length > 0
          ? settings.scopes
          : GOOGLE_WORKSPACE_DEFAULT_SCOPES;
      const { url } = await window.electronAPI.getGoogleWorkspaceOAuthLink({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret || undefined,
        scopes,
        loginHint: settings.loginHint || undefined,
      });
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      // Poll for status so the UI updates once the browser callback arrives.
      if (linkPollRef.current !== null) {
        clearInterval(linkPollRef.current);
      }
      linkPollRef.current = setInterval(async () => {
        const s = await window.electronAPI.getGoogleWorkspaceStatus();
        if (s?.connected) {
          if (linkPollRef.current !== null) {
            clearInterval(linkPollRef.current);
            linkPollRef.current = null;
          }
          setStatus(s);
          await loadSettings();
        }
      }, 2000);
      // Stop polling after 5 minutes regardless.
      setTimeout(() => {
        if (linkPollRef.current !== null) {
          clearInterval(linkPollRef.current);
          linkPollRef.current = null;
        }
      }, 5 * 60 * 1000);
    } catch (error: Any) {
      setOauthError(error.message || "Failed to generate OAuth link");
    } finally {
      setLinkBusy(false);
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
        {linkCopied && (
          <p className="settings-hint">
            Link copied — paste it into your browser to authorize. This panel will update
            automatically once you complete sign-in.
          </p>
        )}
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() =>
              window.electronAPI.openExternal("https://console.cloud.google.com/apis/credentials")
            }
          >
            Open Google Cloud Console
          </button>
          <button
            className="btn-secondary btn-sm"
            onClick={handleCopyLink}
            disabled={linkBusy || oauthBusy}
            title="Generate the OAuth URL and copy it to clipboard — paste it into any browser to authorize"
          >
            {linkBusy ? "Generating..." : linkCopied ? "Link Copied ✓" : "Copy Auth Link"}
          </button>
          <button className="btn-primary btn-sm" onClick={handleOAuthConnect} disabled={oauthBusy || linkBusy}>
            {oauthBusy ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h4>Setup Guide</h4>
        <ol className="settings-setup-steps">
          <li>
            <strong>Create a Google Cloud project</strong> — open{" "}
            <button
              className="btn-link"
              onClick={() =>
                window.electronAPI.openExternal("https://console.cloud.google.com/projectcreate")
              }
            >
              console.cloud.google.com
            </button>{" "}
            and create (or select) a project.
          </li>
          <li>
            <strong>Enable APIs</strong> — go to{" "}
            <em>APIs &amp; Services → Library</em> and enable{" "}
            <strong>Gmail API</strong>, <strong>Google Drive API</strong>, and{" "}
            <strong>Google Calendar API</strong>.
          </li>
          <li>
            <strong>Configure OAuth consent screen</strong>:
            <ol className="settings-setup-steps settings-setup-steps--nested">
              <li>
                Go to <em>APIs &amp; Services → OAuth consent screen</em>, choose{" "}
                <strong>External</strong>, and fill in the app name and your email. Save.
              </li>
              <li>
                Open the <strong>Audience</strong> tab (sometimes labelled{" "}
                <strong>Test users</strong> in older Console versions).
              </li>
              <li>
                Click <strong>+ Add users</strong> and add the Google account you will sign in
                with (e.g. <em>you@gmail.com</em>).
              </li>
              <li>
                Click <strong>Save</strong>. Without this step you will see a{" "}
                <em>403 access_denied</em> error.
              </li>
            </ol>
          </li>
          <li>
            <strong>Create credentials</strong> — go to{" "}
            <em>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</em>.
            Choose <strong>Web application</strong> as the application type (not Desktop app).
            Under <em>Authorized redirect URIs</em> click <strong>+ ADD URI</strong> and add
            exactly:
            <br />
            <code>http://127.0.0.1:18766/oauth/callback</code>
          </li>
          <li>
            <strong>Copy your credentials</strong> — after creation, Google shows your{" "}
            <strong>Client ID</strong> and <strong>Client Secret</strong>. Paste them into the
            fields below.
          </li>
          <li>
            <strong>Connect</strong> — click the <strong>Connect</strong> button above.
            A browser window will open for you to authorize access. Tokens are saved
            automatically.
          </li>
        </ol>
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
          <p className="settings-hint">
            Found in <em>Google Cloud Console → APIs &amp; Services → Credentials</em> under your
            OAuth 2.0 Client ID. Looks like{" "}
            <code>123456789-abc....apps.googleusercontent.com</code>.
          </p>
        </div>

        <div className="settings-field">
          <label>Google Account Email</label>
          <input
            type="email"
            className="settings-input"
            placeholder="you@gmail.com"
            value={settings.loginHint || ""}
            onChange={(e) => updateSettings({ loginHint: e.target.value || undefined })}
          />
          <p className="settings-hint">
            Optional. Pre-selects this account in the Google sign-in screen so you are not asked to
            pick from multiple logged-in accounts.
          </p>
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
            Shown alongside the Client ID in Google Cloud Console. Required for Web application
            clients to exchange the authorization code for tokens.
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
          <p className="settings-hint">
            Filled automatically after clicking <strong>Connect</strong>. You do not need to enter
            this manually.
          </p>
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
          <p className="settings-hint">
            Filled automatically after connecting. Used to silently renew the access token so you
            stay connected without re-authorizing.
          </p>
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
