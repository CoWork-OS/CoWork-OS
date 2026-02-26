import { useState, useEffect, useCallback } from "react";
import { ChannelData, ChannelUserData, SecurityMode } from "../../shared/types";

interface SlackSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function SlackSettings({ onStatusChange }: SlackSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    botUsername?: string;
  } | null>(null);

  // Form state
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [channelName, setChannelName] = useState("Slack Bot");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const slackChannel = channels.find((c: ChannelData) => c.type === "slack");

      if (slackChannel) {
        setChannel(slackChannel);
        setChannelName(slackChannel.name);
        setSecurityMode(slackChannel.securityMode);
        onStatusChange?.(slackChannel.status === "connected");

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(slackChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error("Failed to load Slack channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "slack") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (!botToken.trim() || !appToken.trim()) return;

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: "slack",
        name: channelName,
        botToken: botToken.trim(),
        appToken: appToken.trim(),
        signingSecret: signingSecret.trim() || undefined,
        securityMode,
      });

      setBotToken("");
      setAppToken("");
      setSigningSecret("");
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!channel) return;

    try {
      setTesting(true);
      setTestResult(null);

      const result = await window.electronAPI.testGatewayChannel(channel.id);
      setTestResult(result);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setTesting(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!channel) return;

    try {
      setSaving(true);
      if (channel.enabled) {
        await window.electronAPI.disableGatewayChannel(channel.id);
      } else {
        await window.electronAPI.enableGatewayChannel(channel.id);
      }
      await loadChannel();
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channel) return;

    if (!confirm("Are you sure you want to remove the Slack channel?")) {
      return;
    }

    try {
      setSaving(true);
      await window.electronAPI.removeGatewayChannel(channel.id);
      setChannel(null);
      setUsers([]);
      onStatusChange?.(false);
    } catch (error: Any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: mode,
      });
      setSecurityMode(mode);
      setChannel({ ...channel, securityMode: mode });
    } catch (error: Any) {
      console.error("Failed to update security mode:", error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
    } catch (error: Any) {
      console.error("Failed to generate pairing code:", error);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, userId);
      await loadChannel();
    } catch (error: Any) {
      console.error("Failed to revoke access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Slack settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="slack-settings">
        <div className="settings-section">
          <h3>Connect Slack Bot</h3>
          <p className="settings-description">
            Create a Slack App, then enter the credentials here. Socket Mode is required.
          </p>

          <div className="settings-field">
            <label>Bot Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My CoWork Bot"
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
            <p className="settings-hint">
              Found in OAuth & Permissions section (starts with xoxb-)
            </p>
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
            <p className="settings-hint">
              Required for Socket Mode. Found in Basic Information &gt; App-Level Tokens (starts
              with xapp-)
            </p>
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
            <p className="settings-hint">
              Found in Basic Information section. Optional for Socket Mode.
            </p>
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
              <option value="open">Open (Anyone can use)</option>
            </select>
            <p className="settings-hint">
              {securityMode === "pairing" &&
                "Users must enter a code generated in this app to use the bot"}
              {securityMode === "allowlist" && "Only pre-approved Slack user IDs can use the bot"}
              {securityMode === "open" &&
                "Anyone who messages the bot can use it (not recommended)"}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? (
                <>Connected as {testResult.botUsername}</>
              ) : (
                <>{testResult.error}</>
              )}
            </div>
          )}

          <button
            className="button-primary"
            onClick={handleAddChannel}
            disabled={saving || !botToken.trim() || !appToken.trim()}
          >
            {saving ? "Adding..." : "Add Slack Bot"}
          </button>
        </div>

        <div className="settings-section">
          <h4>Setup Instructions</h4>
          <ol className="setup-instructions">
            <li>
              Go to{" "}
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">
                Slack API Apps
              </a>
            </li>
            <li>Click "Create New App" and choose "From scratch"</li>
            <li>
              In "Socket Mode", enable it and create an App-Level Token with{" "}
              <code>connections:write</code> scope
            </li>
            <li>
              In "OAuth & Permissions", add these Bot Token Scopes:
              <ul>
                <li>
                  <code>app_mentions:read</code>
                </li>
                <li>
                  <code>chat:write</code>
                </li>
                <li>
                  <code>im:history</code>
                </li>
                <li>
                  <code>im:read</code>
                </li>
                <li>
                  <code>im:write</code>
                </li>
                <li>
                  <code>users:read</code>
                </li>
                <li>
                  <code>files:write</code>
                </li>
              </ul>
            </li>
            <li>
              In "Event Subscriptions", enable events and subscribe to:
              <ul>
                <li>
                  <code>app_mention</code>
                </li>
                <li>
                  <code>message.im</code>
                </li>
              </ul>
            </li>
            <li>Install the app to your workspace</li>
            <li>Copy the Bot User OAuth Token (xoxb-...) and App-Level Token (xapp-...)</li>
          </ol>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="slack-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">@{channel.botUsername}</span>}
            </h3>
            <div className={`channel-status ${channel.status}`}>
              {channel.status === "connected" && "Connected"}
              {channel.status === "connecting" && "Connecting..."}
              {channel.status === "disconnected" && "Disconnected"}
              {channel.status === "error" && "Error"}
            </div>
          </div>
          <div className="channel-actions">
            <button
              className={channel.enabled ? "button-secondary" : "button-primary"}
              onClick={handleToggleEnabled}
              disabled={saving}
            >
              {channel.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="button-secondary"
              onClick={handleTestConnection}
              disabled={testing || !channel.enabled}
            >
              {testing ? "Testing..." : "Test"}
            </button>
            <button className="button-danger" onClick={handleRemoveChannel} disabled={saving}>
              Remove
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? <>Connection successful</> : <>{testResult.error}</>}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Security Mode</h4>
        <select
          className="settings-select"
          value={securityMode}
          onChange={(e) => handleUpdateSecurityMode(e.target.value as SecurityMode)}
        >
          <option value="pairing">Pairing Code</option>
          <option value="allowlist">Allowlist Only</option>
          <option value="open">Open</option>
        </select>
      </div>

      {securityMode === "pairing" && (
        <div className="settings-section">
          <h4>Generate Pairing Code</h4>
          <p className="settings-description">
            Generate a one-time code for a user to enter in Slack to gain access.
          </p>
          <button className="button-secondary" onClick={handleGeneratePairingCode}>
            Generate Code
          </button>
          {pairingCode && (
            <div className="pairing-code-display">
              <span className="pairing-code">{pairingCode}</span>
              <p className="settings-hint">
                User should send /pair with this code within 5 minutes
              </p>
            </div>
          )}
        </div>
      )}

      <div className="settings-section">
        <h4>Authorized Users</h4>
        {users.length === 0 ? (
          <p className="settings-description">No users have connected yet.</p>
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

      <div className="settings-section">
        <h4>How to Use</h4>
        <div className="commands-list">
          <p className="settings-description">
            Direct message the bot or mention it (@BotName) in a channel to start a task.
          </p>
          <div className="command-item">
            <code>/start</code> - Start the bot and get help
          </div>
          <div className="command-item">
            <code>/help</code> - Show available commands
          </div>
          <div className="command-item">
            <code>/workspaces</code> - List available workspaces
          </div>
          <div className="command-item">
            <code>/workspace</code> - Select or show current workspace
          </div>
          <div className="command-item">
            <code>/newtask</code> - Start a fresh task/conversation
          </div>
          <div className="command-item">
            <code>/status</code> - Check bot status
          </div>
          <div className="command-item">
            <code>/cancel</code> - Cancel current task
          </div>
          <div className="command-item">
            <code>/pair</code> - Pair with a pairing code
          </div>
        </div>
      </div>
    </div>
  );
}
