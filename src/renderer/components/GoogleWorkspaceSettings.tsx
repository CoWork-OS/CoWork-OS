import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleWorkspaceSettingsData } from "../../shared/types";
import {
  GMAIL_DEFAULT_SCOPES,
  GOOGLE_WORKSPACE_DEFAULT_SCOPES,
  inferGoogleWorkspaceConnectionMode,
  mergeGoogleScopesForMode,
  normalizeGoogleAccountEmail,
  removeGoogleWorkspaceAccount,
  upsertGoogleWorkspaceAccount,
  type GoogleWorkspaceConnectionMode,
} from "../../shared/google-workspace";
import { createRendererLogger } from "../utils/logger";

const DEFAULT_TIMEOUT_MS = 20000;
const logger = createRendererLogger("GoogleWorkspaceSettings");

const textToScopes = (value: string) =>
  value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const modeLabel = (mode: GoogleWorkspaceConnectionMode) =>
  mode === "workspace" ? "Google Workspace" : "Gmail";

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
    missingScopes?: string[];
  } | null>(null);
  const [status, setStatus] = useState<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
    missingScopes?: string[];
    connectionMode?: GoogleWorkspaceConnectionMode;
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

  const currentMode = useMemo<GoogleWorkspaceConnectionMode>(() => {
    return inferGoogleWorkspaceConnectionMode(settings?.connectionMode, settings?.scopes);
  }, [settings?.connectionMode, settings?.scopes]);

  const effectiveScopes = useMemo(
    () => mergeGoogleScopesForMode(settings?.scopes, currentMode),
    [currentMode, settings?.scopes],
  );

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getGoogleWorkspaceSettings();
      const inferred = inferGoogleWorkspaceConnectionMode(loaded.connectionMode, loaded.scopes);
      const mode = inferred === "gmail" && !loaded.builtinOAuthClientAvailable && !loaded.clientId ? "workspace" : inferred;
      setSettings({
        ...loaded,
        connectionMode: mode,
        scopes: mergeGoogleScopesForMode(loaded.scopes, mode),
      });
    } catch (error) {
      logger.error("Failed to load Google Workspace settings:", error);
    }
  };

  const updateSettings = (updates: Partial<GoogleWorkspaceSettingsData>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
  };

  const setConnectionMode = (connectionMode: GoogleWorkspaceConnectionMode) => {
    if (!settings) return;
    const activeEmail = normalizeGoogleAccountEmail(settings.activeAccountEmail);
    const accounts = (settings.accounts || []).map((account) =>
      normalizeGoogleAccountEmail(account.email) === activeEmail
        ? {
            ...account,
            connectionMode,
            scopes: mergeGoogleScopesForMode(
              connectionMode === "workspace"
                ? GOOGLE_WORKSPACE_DEFAULT_SCOPES
                : GMAIL_DEFAULT_SCOPES,
              connectionMode,
            ),
          }
        : account,
    );
    setSettings({
      ...settings,
      accounts,
      connectionMode,
      scopes: mergeGoogleScopesForMode(
        connectionMode === "workspace" ? GOOGLE_WORKSPACE_DEFAULT_SCOPES : GMAIL_DEFAULT_SCOPES,
        connectionMode,
      ),
    });
    setOauthError(null);
    setTestResult(null);
  };

  const buildPayload = (overrides: Partial<GoogleWorkspaceSettingsData> = {}) => {
    const mode = overrides.connectionMode ?? currentMode;
    return {
      ...settings!,
      ...overrides,
      enabled: overrides.enabled ?? true,
      connectionMode: mode,
      scopes: mergeGoogleScopesForMode(overrides.scopes ?? settings?.scopes, mode),
    };
  };

  const handleSelectAccount = async (email: string) => {
    if (!settings) return;
    const account = (settings.accounts || []).find(
      (item) => normalizeGoogleAccountEmail(item.email) === normalizeGoogleAccountEmail(email),
    );
    if (!account) return;
    const mode = inferGoogleWorkspaceConnectionMode(account.connectionMode, account.scopes);
    const payload = {
      ...settings,
      activeAccountEmail: normalizeGoogleAccountEmail(account.email),
      connectionMode: mode,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      tokenExpiresAt: account.tokenExpiresAt,
      scopes: mergeGoogleScopesForMode(account.scopes, mode),
      loginHint: account.email,
    };
    setSettings(payload);
    await window.electronAPI.saveGoogleWorkspaceSettings(payload);
    await refreshStatus();
  };

  const handleRemoveAccount = async (email: string) => {
    if (!settings) return;
    const payload = removeGoogleWorkspaceAccount(settings, email);
    await window.electronAPI.saveGoogleWorkspaceSettings(payload);
    setSettings(payload);
    await refreshStatus();
  };

  const getLegacyConnectedAccountEmail = () =>
    normalizeGoogleAccountEmail(status?.name) ||
    normalizeGoogleAccountEmail(status?.connected ? settings?.loginHint : undefined);

  const materializeLegacyConnectedAccount = (
    baseSettings: GoogleWorkspaceSettingsData,
  ): GoogleWorkspaceSettingsData => {
    if (baseSettings.accounts?.length) return baseSettings;
    if (!baseSettings.accessToken && !baseSettings.refreshToken) return baseSettings;
    const email = getLegacyConnectedAccountEmail();
    if (!email) return baseSettings;
    return upsertGoogleWorkspaceAccount(baseSettings, {
      email,
      name: email,
      accessToken: baseSettings.accessToken,
      refreshToken: baseSettings.refreshToken,
      tokenExpiresAt: baseSettings.tokenExpiresAt,
      scopes: baseSettings.scopes,
      connectionMode: currentMode,
      connectedAt: Date.now(),
    });
  };

  const hasStoredOrLegacyConnection = () =>
    Boolean(settings?.accounts?.length || settings?.accessToken || settings?.refreshToken);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    try {
      const payload = buildPayload({ enabled: settings.enabled });
      await window.electronAPI.saveGoogleWorkspaceSettings(payload);
      setSettings(payload);
      await refreshStatus();
    } catch (error) {
      logger.error("Failed to save Google Workspace settings:", error);
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
      logger.error("Failed to load Google Workspace status:", error);
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

  const hasOAuthClient = () => Boolean(settings?.builtinOAuthClientAvailable || settings?.clientId);

  const ensureOAuthClient = (action: string) => {
    if (hasOAuthClient()) return true;
    setOauthError(
      `${action} needs the official CoWork Google OAuth client or a custom Google OAuth client ID in Advanced setup.`,
    );
    return false;
  };

  const handleOAuthConnect = async () => {
    if (!settings || !ensureOAuthClient(`Connect ${modeLabel(currentMode)}`)) return;

    setOauthBusy(true);
    setOauthError(null);

    try {
      const scopes = mergeGoogleScopesForMode(settings.scopes, currentMode);
      const result = await window.electronAPI.startGoogleWorkspaceOAuth({
        clientId: settings.clientId || undefined,
        clientSecret: settings.clientId ? settings.clientSecret || undefined : undefined,
        scopes,
        connectionMode: currentMode,
        loginHint: hasStoredOrLegacyConnection() ? undefined : settings.loginHint || undefined,
      });

      const tokenExpiresAt = result.expiresIn
        ? Date.now() + result.expiresIn * 1000
        : undefined;
      const baseSettings = materializeLegacyConnectedAccount(settings);
      const email = normalizeGoogleAccountEmail(result.email) || normalizeGoogleAccountEmail(settings.loginHint);
      const payload = email
        ? upsertGoogleWorkspaceAccount(baseSettings, {
            email,
            name: result.email,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            tokenExpiresAt,
            scopes: result.scopes || scopes,
            connectionMode: currentMode,
            connectedAt: Date.now(),
          })
        : {
            ...baseSettings,
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
      setOauthError(error.message || `${modeLabel(currentMode)} OAuth failed`);
    } finally {
      setOauthBusy(false);
    }
  };

  const handleCopyLink = async () => {
    if (!settings || !ensureOAuthClient(`Copy ${modeLabel(currentMode)} auth link`)) return;

    setLinkBusy(true);
    setLinkCopied(false);
    setOauthError(null);

    try {
      const scopes = mergeGoogleScopesForMode(settings.scopes, currentMode);
      const { url } = await window.electronAPI.getGoogleWorkspaceOAuthLink({
        clientId: settings.clientId || undefined,
        clientSecret: settings.clientId ? settings.clientSecret || undefined : undefined,
        scopes,
        connectionMode: currentMode,
        loginHint: hasStoredOrLegacyConnection() ? undefined : settings.loginHint || undefined,
      });
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      if (linkPollRef.current !== null) {
        clearInterval(linkPollRef.current);
      }
      linkPollRef.current = setInterval(async () => {
        const nextStatus = await window.electronAPI.getGoogleWorkspaceStatus();
        if (nextStatus?.connected) {
          if (linkPollRef.current !== null) {
            clearInterval(linkPollRef.current);
            linkPollRef.current = null;
          }
          setStatus(nextStatus);
          await loadSettings();
        }
      }, 2000);
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
    return <div className="settings-loading">Loading Google settings...</div>;
  }

  const connectedLabel = status?.connected ? `Connected${status.name ? ` as ${status.name}` : ""}` : "";
  const accounts = settings.accounts || [];
  const activeAccountEmail = normalizeGoogleAccountEmail(settings.activeAccountEmail);
  const legacyConnectedEmail = accounts.length === 0 ? getLegacyConnectedAccountEmail() : undefined;
  const hasConnectedAccount = accounts.length > 0 || Boolean(legacyConnectedEmail);
  const hasOfficialOAuthClient = Boolean(settings.builtinOAuthClientAvailable);
  const statusLabel = !status?.configured
    ? "Not Connected"
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
            <h3>Connect Gmail</h3>
            {status && (
              <span
                className={`google-workspace-status-badge ${statusClass}`}
                title={
                  !status.configured
                    ? "Gmail is not connected"
                    : status.connected
                      ? connectedLabel || "Connected"
                      : "OAuth credentials are saved but not connected"
                }
              >
                {statusLabel}
              </span>
            )}
            {statusLoading && !status && (
              <span className="google-workspace-status-badge configured">Checking...</span>
            )}
          </div>
          <button className="btn-secondary btn-sm" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? "Checking..." : "Refresh Status"}
          </button>
        </div>

        <p className="settings-description">
          Start with Gmail-only access for inbox search, thread reading, drafts, sending, labels,
          and Inbox Agent workflows. This same connection can be upgraded to full Google Workspace
          access for Drive, Calendar, Docs, Sheets, Slides, Tasks, and Chat.
        </p>

        {hasConnectedAccount && (
          <div className="settings-field">
            <label>Gmail Accounts</label>
            <div className="google-workspace-account-list">
              {legacyConnectedEmail && (
                <div className="google-workspace-account-row">
                  <div>
                    <strong>{legacyConnectedEmail}</strong>
                    <p className="settings-hint">Active account</p>
                  </div>
                </div>
              )}
              {accounts.map((account) => {
                const email = normalizeGoogleAccountEmail(account.email) || account.email;
                const isActive = email === activeAccountEmail;
                return (
                  <div className="google-workspace-account-row" key={email}>
                    <div>
                      <strong>{account.email}</strong>
                      <p className="settings-hint">
                        {isActive ? "Active account" : "Connected account"}
                      </p>
                    </div>
                    <div className="settings-actions">
                      {!isActive && (
                        <button
                          className="btn-secondary btn-sm"
                          type="button"
                          onClick={() => handleSelectAccount(account.email)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        className="btn-secondary btn-sm"
                        type="button"
                        onClick={() => handleRemoveAccount(account.email)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="settings-field">
          <label>Connection Type</label>
          <div className="settings-actions">
            <button
              className={currentMode === "gmail" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
              onClick={() => setConnectionMode("gmail")}
              type="button"
              disabled={!settings?.builtinOAuthClientAvailable && !settings?.clientId}
              title={!settings?.builtinOAuthClientAvailable && !settings?.clientId ? "Gmail Only requires an OAuth client" : undefined}
            >
              Gmail Only
            </button>
            <button
              className={currentMode === "workspace" ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
              onClick={() => setConnectionMode("workspace")}
              type="button"
            >
              Full Workspace
            </button>
          </div>
          <p className="settings-hint">
            {!settings?.clientId
              ? "Gmail Only is temporarily unavailable while OAuth verification is in progress. Use Full Workspace with a custom OAuth client, or set up your own client ID below."
              : "Gmail Only requests Gmail scopes. Full Workspace also requests Drive, Calendar, Docs, Sheets, Slides, Tasks, and Chat scopes."}
          </p>
        </div>

        {status?.error && <p className="settings-hint">Status check: {status.error}</p>}
        {status?.missingScopes?.length ? (
          <p className="settings-hint">Missing scopes: {status.missingScopes.join(", ")}</p>
        ) : null}
        {oauthError && <p className="settings-hint">OAuth error: {oauthError}</p>}
        {linkCopied && (
          <p className="settings-hint">
            Link copied. Paste it into your browser to authorize; this panel updates after sign-in.
          </p>
        )}

        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handleCopyLink}
            disabled={linkBusy || oauthBusy}
            title="Generate an OAuth URL and copy it to clipboard"
          >
            {linkBusy ? "Generating..." : linkCopied ? "Link Copied" : "Copy Auth Link"}
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={handleOAuthConnect}
            disabled={oauthBusy || linkBusy}
          >
            {oauthBusy
              ? "Connecting..."
              : hasConnectedAccount
                ? `Add ${modeLabel(currentMode)} Account`
                : `Connect ${modeLabel(currentMode)}`}
          </button>
        </div>
      </div>

      <details className="settings-section" open={!hasOAuthClient()}>
        <summary>
          <h4>Advanced OAuth Setup</h4>
        </summary>

        <p className="settings-description">
          {hasOfficialOAuthClient
            ? "This build uses CoWork's official Google OAuth client automatically. Use this section only for self-hosted builds or a custom Google Cloud project."
            : "This build does not include CoWork's official Google OAuth client. Add a custom Google OAuth client ID for development or self-hosted use."}
        </p>

        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() =>
              window.electronAPI.openExternal("https://console.cloud.google.com/apis/credentials")
            }
          >
            Open Google Cloud Console
          </button>
        </div>

        <ol className="settings-setup-steps">
          <li>Create or select a Google Cloud project.</li>
          <li>
            Enable APIs: <strong>Gmail API</strong> for Gmail Only. For Full Workspace, also enable
            Drive, Calendar, Docs, Sheets, Slides, Tasks, and Chat APIs.
          </li>
          <li>
            Configure the OAuth consent screen. If the app is in testing mode, add every Gmail
            account you want to connect as a test user.
          </li>
          <li>
            Create an OAuth client ID. For desktop builds, use <strong>Desktop app</strong>. If you
            use a web client for local development, add this redirect URI:
            <br />
            <code>http://127.0.0.1:18766/oauth/callback</code>
          </li>
          <li>Paste the Client ID below. Client Secret is optional and should be left blank for desktop clients.</li>
        </ol>

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
          <p className="settings-hint">Optional. Pre-selects this account on Google's sign-in page.</p>
        </div>

        <div className="settings-field">
          <label>Scopes</label>
          <textarea
            className="settings-input"
            rows={4}
            value={effectiveScopes.join(" ")}
            onChange={(e) => updateSettings({ scopes: textToScopes(e.target.value) })}
          />
          <p className="settings-hint">Space-separated scopes used during OAuth.</p>
        </div>

        <div className="settings-field">
          <label>Access Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Filled automatically after OAuth"
            value={settings.accessToken || ""}
            onChange={(e) => updateSettings({ accessToken: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>Refresh Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Filled automatically after OAuth"
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
      </details>

      <div className="settings-section">
        <h4>Quick Usage</h4>
        <pre className="settings-info-box">{`// Find the latest received Gmail message
gmail_search_emails({
  query: "in:inbox -in:trash",
  label_ids: ["INBOX"],
  max_results: 1
});

// Read a shortlisted message
gmail_batch_read_email({
  message_ids: ["<message id>"]
});

// Full Workspace mode also enables:
google_drive_action({ action: "list_files", page_size: 10 });
calendar_action({ action: "list_events", max_results: 10 });`}</pre>
      </div>
    </div>
  );
}
