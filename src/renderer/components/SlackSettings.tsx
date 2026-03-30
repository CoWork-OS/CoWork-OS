import { useState, useEffect, useCallback, useMemo } from "react";
import { ChannelData, ChannelUserData, SecurityMode } from "../../shared/types";

interface SlackSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function SlackSettings({ onStatusChange }: SlackSettingsProps) {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    botUsername?: string;
  } | null>(null);

  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [channelName, setChannelName] = useState("Slack Workspace");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const selectedChannel = useMemo(
    () => channels.find((entry) => entry.id === selectedChannelId) || null,
    [channels, selectedChannelId],
  );

  const loadChannels = useCallback(
    async (preferredChannelId?: string) => {
      try {
        setLoading(true);
        const gatewayChannels = await window.electronAPI.getGatewayChannels();
        const slackChannels = gatewayChannels.filter((c: ChannelData) => c.type === "slack");
        setChannels(slackChannels);
        onStatusChange?.(slackChannels.some((entry: ChannelData) => entry.status === "connected"));

        const nextSelectedId =
          preferredChannelId && slackChannels.some((entry: ChannelData) => entry.id === preferredChannelId)
            ? preferredChannelId
            : selectedChannelId && slackChannels.some((entry: ChannelData) => entry.id === selectedChannelId)
              ? selectedChannelId
              : slackChannels[0]?.id || null;
        setSelectedChannelId(nextSelectedId);
      } catch (error) {
        console.error("Failed to load Slack channels:", error);
      } finally {
        setLoading(false);
      }
    },
    [onStatusChange, selectedChannelId],
  );

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "slack") return;
      if (selectedChannelId && data?.channelId && data.channelId !== selectedChannelId) return;
      void loadChannels(selectedChannelId || undefined);
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [loadChannels, selectedChannelId]);

  useEffect(() => {
    const loadUsers = async () => {
      if (!selectedChannel) {
        setUsers([]);
        return;
      }
      try {
        const channelUsers = await window.electronAPI.getGatewayUsers(selectedChannel.id);
        setUsers(channelUsers);
      } catch (error) {
        console.error("Failed to load Slack users:", error);
      }
    };
    void loadUsers();
  }, [selectedChannel]);

  const handleAddChannel = async () => {
    if (!botToken.trim() || !appToken.trim()) return;

    try {
      setSaving(true);
      setTestResult(null);
      const created = await window.electronAPI.addGatewayChannel({
        type: "slack",
        name: channelName.trim() || "Slack Workspace",
        botToken: botToken.trim(),
        appToken: appToken.trim(),
        signingSecret: signingSecret.trim() || undefined,
        securityMode,
      });

      setBotToken("");
      setAppToken("");
      setSigningSecret("");
      setChannelName("Slack Workspace");
      await loadChannels(created.id);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedChannel) return;
    try {
      setTesting(true);
      setTestResult(null);
      const result = await window.electronAPI.testGatewayChannel(selectedChannel.id);
      setTestResult(result);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!selectedChannel) return;
    try {
      setSaving(true);
      if (selectedChannel.enabled) {
        await window.electronAPI.disableGatewayChannel(selectedChannel.id);
      } else {
        await window.electronAPI.enableGatewayChannel(selectedChannel.id);
      }
      await loadChannels(selectedChannel.id);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!selectedChannel) return;
    if (!confirm(`Remove Slack workspace "${selectedChannel.name}"?`)) return;

    try {
      setSaving(true);
      await window.electronAPI.removeGatewayChannel(selectedChannel.id);
      setPairingCode(null);
      await loadChannels();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!selectedChannel) return;
    try {
      await window.electronAPI.updateGatewayChannel({
        id: selectedChannel.id,
        securityMode: mode,
      });
      setChannels((prev) =>
        prev.map((entry) => (entry.id === selectedChannel.id ? { ...entry, securityMode: mode } : entry)),
      );
    } catch (error) {
      console.error("Failed to update Slack security mode:", error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!selectedChannel) return;
    try {
      const code = await window.electronAPI.generateGatewayPairing(selectedChannel.id, "");
      setPairingCode(code);
    } catch (error) {
      console.error("Failed to generate Slack pairing code:", error);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!selectedChannel) return;
    try {
      await window.electronAPI.revokeGatewayAccess(selectedChannel.id, userId);
      const channelUsers = await window.electronAPI.getGatewayUsers(selectedChannel.id);
      setUsers(channelUsers);
    } catch (error) {
      console.error("Failed to revoke Slack access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Slack settings...</div>;
  }

  return (
    <div className="slack-settings">
      <div className="settings-section">
        <h3>Add Slack Workspace</h3>
        <p className="settings-description">
          Connect one or more Slack workspaces with separate bot and app token sets.
        </p>

        <div className="settings-field">
          <label>Workspace Label</label>
          <input
            type="text"
            className="settings-input"
            placeholder="Support Workspace"
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label>Bot Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="xoxb-..."
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label>App-Level Token</label>
          <input
            type="password"
            className="settings-input"
            placeholder="xapp-..."
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label>Signing Secret (Optional)</label>
          <input
            type="password"
            className="settings-input"
            placeholder="abc123..."
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label>Security Mode</label>
          <select
            className="settings-select"
            value={securityMode}
            onChange={(e) => setSecurityMode(e.target.value as SecurityMode)}
          >
            <option value="pairing">Pairing Code (Recommended)</option>
            <option value="allowlist">Allowlist Only</option>
            <option value="open">Open</option>
          </select>
        </div>

        <button
          className="button-primary"
          onClick={handleAddChannel}
          disabled={saving || !botToken.trim() || !appToken.trim()}
        >
          {saving ? "Adding..." : "Add Slack Workspace"}
        </button>

        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? (
              <>Connected as {testResult.botUsername}</>
            ) : (
              <>{testResult.error}</>
            )}
          </div>
        )}
      </div>

      {channels.length > 0 && (
        <div className="settings-section">
          <h4>Connected Workspaces</h4>
          <div className="users-list">
            {channels.map((entry) => (
              <button
                key={entry.id}
                className={`user-item ${selectedChannel?.id === entry.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedChannelId(entry.id);
                  setPairingCode(null);
                }}
              >
                <div className="user-info">
                  <span className="user-name">{entry.name}</span>
                  {entry.botUsername && <span className="user-username">@{entry.botUsername}</span>}
                  <span className={`user-status ${entry.status === "connected" ? "allowed" : "pending"}`}>
                    {entry.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedChannel && (
        <>
          <div className="settings-section">
            <div className="channel-header">
              <div className="channel-info">
                <h3>
                  {selectedChannel.name}
                  {selectedChannel.botUsername && (
                    <span className="bot-username">@{selectedChannel.botUsername}</span>
                  )}
                </h3>
                <div className={`channel-status ${selectedChannel.status}`}>
                  {selectedChannel.status === "connected" && "Connected"}
                  {selectedChannel.status === "connecting" && "Connecting..."}
                  {selectedChannel.status === "disconnected" && "Disconnected"}
                  {selectedChannel.status === "error" && "Error"}
                </div>
              </div>
              <div className="channel-actions">
                <button
                  className={selectedChannel.enabled ? "button-secondary" : "button-primary"}
                  onClick={handleToggleEnabled}
                  disabled={saving}
                >
                  {selectedChannel.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="button-secondary"
                  onClick={handleTestConnection}
                  disabled={testing || !selectedChannel.enabled}
                >
                  {testing ? "Testing..." : "Test"}
                </button>
                <button className="button-danger" onClick={handleRemoveChannel} disabled={saving}>
                  Remove
                </button>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h4>Security Mode</h4>
            <select
              className="settings-select"
              value={selectedChannel.securityMode}
              onChange={(e) => handleUpdateSecurityMode(e.target.value as SecurityMode)}
            >
              <option value="pairing">Pairing Code</option>
              <option value="allowlist">Allowlist Only</option>
              <option value="open">Open</option>
            </select>
          </div>

          {selectedChannel.securityMode === "pairing" && (
            <div className="settings-section">
              <h4>Generate Pairing Code</h4>
              <button className="button-secondary" onClick={handleGeneratePairingCode}>
                Generate Code
              </button>
              {pairingCode && (
                <div className="pairing-code-display">
                  <span className="pairing-code">{pairingCode}</span>
                  <p className="settings-hint">Ask the user to send `/pair &lt;code&gt;` in Slack.</p>
                </div>
              )}
            </div>
          )}

          <div className="settings-section">
            <h4>Authorized Users</h4>
            {users.length === 0 ? (
              <p className="settings-description">No users have connected to this workspace yet.</p>
            ) : (
              <div className="users-list">
                {users.map((user) => (
                  <div key={user.id} className="user-item">
                    <div className="user-info">
                      <span className="user-name">{user.displayName}</span>
                      {user.username && <span className="user-username">@{user.username}</span>}
                      <span className={`user-status ${user.allowed ? "allowed" : "pending"}`}>
                        {user.allowed ? "Allowed" : "Pending"}
                      </span>
                    </div>
                    {user.allowed && (
                      <button
                        className="button-small button-danger"
                        onClick={() => handleRevokeAccess(user.channelUserId)}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="settings-section">
        <h4>Setup Instructions</h4>
        <ol className="setup-instructions">
          <li>
            Go to{" "}
            <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
              Slack API Apps
            </a>
          </li>
          <li>Create a new app for each workspace you want CoWork to join.</li>
          <li>Enable Socket Mode and create an app token with `connections:write`.</li>
          <li>Add `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, and `files:write` bot scopes.</li>
          <li>Subscribe to `app_mention` and `message.im`, then install the app to the workspace.</li>
        </ol>
      </div>
    </div>
  );
}
