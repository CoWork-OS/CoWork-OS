import { useEffect, useState } from "react";
import type {
  BoxBrainSettings,
  BoxBrainStatus,
  BoxSettingsData,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";

const DEFAULT_BRAIN_SETTINGS: BoxBrainSettings = {
  enabled: false,
  rootFolderId: "0",
  syncIntervalMinutes: 60,
  maxItemsPerRun: 200,
  includeContent: true,
  useBoxAiSummaries: false,
  improvementEnabled: true,
  maxContentChars: 10000,
};

export function BoxSettings() {
  const [settings, setSettings] = useState<BoxSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
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
    mcpConfigured?: boolean;
    mcpConnected?: boolean;
    mcpError?: string;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [brainStatus, setBrainStatus] = useState<BoxBrainStatus | null>(null);
  const [brainSyncing, setBrainSyncing] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    loadSettings();
    loadWorkspaces();
    refreshStatus();
    refreshBrainStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getBoxSettings();
      setSettings(loaded);
      await refreshBrainStatus(loaded.brain?.workspaceId);
    } catch (error) {
      console.error("Failed to load Box settings:", error);
    }
  };

  const loadWorkspaces = async () => {
    try {
      const loaded = await window.electronAPI.listWorkspaces();
      setWorkspaces(
        loaded.filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)),
      );
    } catch (error) {
      console.error("Failed to load workspaces for Box Brain:", error);
    }
  };

  const updateSettings = (updates: Partial<BoxSettingsData>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
  };

  const brainSettings = settings?.brain || DEFAULT_BRAIN_SETTINGS;

  const updateBrainSettings = (updates: Partial<BoxBrainSettings>) => {
    updateSettings({ brain: { ...brainSettings, ...updates } });
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setTestResult(null);
    setOauthError(null);
    try {
      const payload: BoxSettingsData = { ...settings };
      await window.electronAPI.saveBoxSettings(payload);
      setSettings(payload);
      await refreshStatus();
      await refreshBrainStatus(payload.brain?.workspaceId);
    } catch (error) {
      console.error("Failed to save Box settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const refreshBrainStatus = async (workspaceId?: string) => {
    try {
      const result = await window.electronAPI.getBoxBrainStatus(workspaceId);
      setBrainStatus(result);
    } catch (error) {
      console.error("Failed to load Box Brain status:", error);
    }
  };

  const handleBrainSync = async () => {
    const workspaceId = brainSettings.workspaceId || workspaces[0]?.id;
    if (!workspaceId) {
      setBrainError("Create or select a non-temporary workspace before syncing Box Brain.");
      return;
    }
    setBrainSyncing(true);
    setBrainError(null);
    try {
      const result = await window.electronAPI.syncBoxBrainNow(workspaceId);
      if (!result.success) setBrainError(result.error || "Box Brain sync failed");
      await refreshBrainStatus(workspaceId);
    } catch (error: unknown) {
      setBrainError(error instanceof Error ? error.message : "Box Brain sync failed");
    } finally {
      setBrainSyncing(false);
    }
  };

  const formatTimestamp = (timestamp?: number) =>
    timestamp ? new Date(timestamp).toLocaleString() : "Not run yet";

  const refreshStatus = async () => {
    try {
      setStatusLoading(true);
      const result = await window.electronAPI.getBoxStatus();
      setStatus(result);
    } catch (error) {
      console.error("Failed to load Box status:", error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testBoxConnection();
      setTestResult(result);
      await refreshStatus();
    } catch (error: unknown) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : "Failed to test connection",
      });
    } finally {
      setTesting(false);
    }
  };

  const parseScopes = (value: string) =>
    value
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);

  const handleBoxOAuth = async () => {
    const currentSettings = settings;
    if (!currentSettings) return;

    if (!currentSettings.clientId || !currentSettings.clientSecret) {
      setOauthError("Enter the Box OAuth client ID and client secret first.");
      return;
    }

    setOauthBusy(true);
    setOauthError(null);
    try {
      const scopes = currentSettings.scopes?.length
        ? currentSettings.scopes
        : ["root_readwrite", "ai.readwrite"];
      const result = await window.electronAPI.startConnectorOAuth({
        provider: "box",
        clientId: currentSettings.clientId,
        clientSecret: currentSettings.clientSecret,
        scopes,
      });
      const payload: BoxSettingsData = {
        ...currentSettings,
        enabled: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        tokenExpiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
        scopes: result.scopes || scopes,
        mcpEnabled: true,
      };
      const saveResult = await window.electronAPI.saveBoxSettings(payload);
      setSettings(payload);
      if (saveResult?.mcp?.error) {
        setOauthError(`Box connected, but Box MCP could not connect: ${saveResult.mcp.error}`);
      }
      await refreshStatus();
      await refreshBrainStatus(payload.brain?.workspaceId);
    } catch (error: unknown) {
      setOauthError(error instanceof Error ? error.message : "Box OAuth failed");
    } finally {
      setOauthBusy(false);
    }
  };

  if (!settings) {
    return <div className="settings-loading">Loading Box settings...</div>;
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
    <div className="box-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <div className="settings-title-with-badge">
            <h3>Connect Box</h3>
            {status && (
              <span
                className={`box-status-badge ${statusClass}`}
                title={
                  !status.configured
                    ? "Access token not configured"
                    : status.connected
                      ? "Connected to Box"
                      : "Configured"
                }
              >
                {statusLabel}
              </span>
            )}
            {statusLoading && !status && (
              <span className="box-status-badge configured">Checking…</span>
            )}
          </div>
          <button className="btn-secondary btn-sm" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? "Checking..." : "Refresh Status"}
          </button>
        </div>
        <p className="settings-description">
          Connect the agent to Box with OAuth or an access token. The native `box_action` tool
          handles basic file operations; hosted Box MCP adds Box AI, Hubs, citations, and the
          broader Box toolset.
        </p>
        {status?.error && <p className="settings-hint">Status check: {status.error}</p>}
        {status?.mcpError && <p className="settings-hint">Box MCP: {status.mcpError}</p>}
        {status?.mcpConnected && <p className="settings-hint">Box MCP is connected.</p>}
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() =>
              window.electronAPI.openExternal("https://app.box.com/developers/console")
            }
          >
            Open Box Console
          </button>
          <button
            className="btn-secondary btn-sm"
            onClick={() =>
              window.electronAPI.openExternal("https://developer.box.com/guides/box-mcp")
            }
          >
            Box MCP Setup
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
            placeholder="Box access token"
            value={settings.accessToken || ""}
            onChange={(e) =>
              updateSettings({
                accessToken: e.target.value || undefined,
                refreshToken: undefined,
                tokenExpiresAt: undefined,
              })
            }
          />
          <p className="settings-hint">
            Use a developer token or OAuth access token with required scopes.
          </p>
        </div>

        <div className="settings-field">
          <label>OAuth Client ID</label>
          <input
            type="text"
            className="settings-input"
            placeholder="Box Integration Credentials client ID"
            value={settings.clientId || ""}
            onChange={(e) => updateSettings({ clientId: e.target.value || undefined })}
          />
        </div>

        <div className="settings-field">
          <label>OAuth Client Secret</label>
          <input
            type="password"
            className="settings-input"
            placeholder="Box Integration Credentials client secret"
            value={settings.clientSecret || ""}
            onChange={(e) => updateSettings({ clientSecret: e.target.value || undefined })}
          />
          <p className="settings-hint">
            In Box Admin Console, add <code>http://127.0.0.1:18765/oauth/callback</code> to the
            app's redirect URIs before starting OAuth.
          </p>
        </div>

        <div className="settings-field">
          <label>OAuth Scopes</label>
          <input
            type="text"
            className="settings-input"
            placeholder="root_readwrite ai.readwrite"
            value={(settings.scopes || ["root_readwrite", "ai.readwrite"]).join(" ")}
            onChange={(e) => updateSettings({ scopes: parseScopes(e.target.value) })}
          />
          <p className="settings-hint">
            Add <code>docgen.readwrite</code> only when your Box plan supports Doc Gen.
          </p>
        </div>

        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handleBoxOAuth}
            disabled={oauthBusy || !settings.clientId || !settings.clientSecret}
          >
            {oauthBusy ? "Opening Box..." : "Connect with Box OAuth"}
          </button>
        </div>
        {oauthError && <p className="settings-hint">{oauthError}</p>}

        <div className="settings-field">
          <label>Enable Hosted Box MCP</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.mcpEnabled ?? false}
              onChange={(e) => updateSettings({ mcpEnabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
          <p className="settings-hint">
            Uses <code>https://mcp.box.com</code> for Box AI, Hubs, search, citations, and advanced
            Box operations. Saving reconnects the MCP server.
          </p>
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
        <div className="settings-section-header">
          <div>
            <h3>Box Brain</h3>
            <p className="settings-description">
              Keep a bounded, local company index from one Box folder. Changed files are synced
              incrementally, cited with their Box URLs, and reviewed by the existing improvement
              loop before anything becomes durable curated memory.
            </p>
          </div>
          <span className={`box-status-badge ${brainStatus?.enabled ? "connected" : "configured"}`}>
            {brainStatus?.enabled ? "Enabled" : "Off"}
          </span>
        </div>

        <div className="settings-field">
          <label>Enable background company-brain sync</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={brainSettings.enabled}
              onChange={(e) => updateBrainSettings({ enabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
          <p className="settings-hint">
            This is opt-in. It reads Box through Hosted MCP and writes only private local memory; it
            never writes back to Box.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="box-brain-workspace">Local index workspace</label>
          <select
            id="box-brain-workspace"
            className="settings-input"
            value={brainSettings.workspaceId || workspaces[0]?.id || ""}
            onChange={(e) => updateBrainSettings({ workspaceId: e.target.value || undefined })}
            disabled={workspaces.length === 0}
          >
            {workspaces.length === 0 ? (
              <option value="">No non-temporary workspace available</option>
            ) : (
              workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.path}
                </option>
              ))
            )}
          </select>
          <p className="settings-hint">
            Imported Box memories remain available to other workspaces through global imported
            recall, while this workspace owns the source and sync state.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="box-brain-folder">Box folder ID</label>
          <input
            id="box-brain-folder"
            type="text"
            className="settings-input"
            placeholder="0 (Box root)"
            value={brainSettings.rootFolderId}
            onChange={(e) => updateBrainSettings({ rootFolderId: e.target.value })}
          />
          <p className="settings-hint">
            Use <code>0</code> for the Box root or paste a specific folder ID.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="box-brain-interval">Sync interval (minutes)</label>
          <input
            id="box-brain-interval"
            type="number"
            className="settings-input"
            min={5}
            max={10080}
            value={brainSettings.syncIntervalMinutes}
            onChange={(e) => updateBrainSettings({ syncIntervalMinutes: Number(e.target.value) })}
          />
          <p className="settings-hint">
            Minimum 5 minutes; the first run starts after CoWork connects to Box MCP.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="box-brain-max-items">Maximum files per run</label>
          <input
            id="box-brain-max-items"
            type="number"
            className="settings-input"
            min={1}
            max={1000}
            value={brainSettings.maxItemsPerRun}
            onChange={(e) => updateBrainSettings({ maxItemsPerRun: Number(e.target.value) })}
          />
        </div>

        <div className="settings-field">
          <label>Index document text</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={brainSettings.includeContent}
              onChange={(e) => updateBrainSettings({ includeContent: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
          <p className="settings-hint">
            When off, the index keeps metadata and source links only. Large files are bounded and
            never downloaded as arbitrary binaries.
          </p>
        </div>

        <div className="settings-field">
          <label>Use Box AI summaries</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={brainSettings.useBoxAiSummaries}
              onChange={(e) => updateBrainSettings({ useBoxAiSummaries: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
          <p className="settings-hint">
            Uses Box AI when available, then falls back to Box file content. AI calls are paced and
            capped per run.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="box-brain-max-chars">Maximum text per file</label>
          <input
            id="box-brain-max-chars"
            type="number"
            className="settings-input"
            min={500}
            max={10000}
            value={brainSettings.maxContentChars}
            onChange={(e) => updateBrainSettings({ maxContentChars: Number(e.target.value) })}
          />
        </div>

        <div className="settings-field">
          <label>Run reviewable improvement pass</label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={brainSettings.improvementEnabled}
              onChange={(e) => updateBrainSettings({ improvementEnabled: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
          <p className="settings-hint">
            New or changed files can produce reviewable Dreaming candidates for facts, conflicts,
            stale policies, workflows, and open loops. Candidates are not silently promoted.
          </p>
        </div>

        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handleBrainSync}
            disabled={
              brainSyncing ||
              !brainSettings.enabled ||
              !status?.mcpConnected ||
              workspaces.length === 0
            }
          >
            {brainSyncing ? "Syncing Box Brain..." : "Sync Box Brain Now"}
          </button>
          <button
            className="btn-secondary btn-sm"
            onClick={() => refreshBrainStatus(brainSettings.workspaceId || workspaces[0]?.id)}
            disabled={brainSyncing}
          >
            Refresh Brain Status
          </button>
        </div>

        {brainError && <p className="settings-hint warning">Box Brain: {brainError}</p>}
        {brainStatus && (
          <p className="settings-hint">
            Last run: {formatTimestamp(brainStatus.lastRunAt)} · indexed{" "}
            {brainStatus.lastIndexedCount} · unchanged {brainStatus.lastUnchangedCount} · deleted{" "}
            {brainStatus.lastDeletedCount}
            {brainStatus.lastError ? ` · error: ${brainStatus.lastError}` : ""}
          </p>
        )}
        {!status?.mcpConnected && (
          <p className="settings-hint">
            Connect and save Hosted Box MCP above before starting the background index.
          </p>
        )}
      </div>

      <div className="settings-section">
        <h4>Quick Usage</h4>
        <pre className="settings-info-box">{`// List root folder items
box_action({
  action: "list_folder_items",
  folder_id: "0",
  limit: 25
});

// Upload a file to root
box_action({
  action: "upload_file",
  file_path: "reports/summary.pdf",
  parent_id: "0"
});`}</pre>
      </div>
    </div>
  );
}
