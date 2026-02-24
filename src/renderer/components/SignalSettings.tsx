import { useState, useEffect, useCallback } from "react";
import { ChannelData, ChannelUserData, SecurityMode } from "../../shared/types";

interface SignalSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

type DmPolicy = "open" | "allowlist" | "pairing" | "disabled";
type GroupPolicy = "open" | "allowlist" | "disabled";
type TrustMode = "tofu" | "always" | "manual";
type SignalMode = "native" | "daemon";

export function SignalSettings({ onStatusChange }: SignalSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState("Signal");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [cliPath, setCliPath] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [mode, setMode] = useState<SignalMode>("native");
  const [trustMode, setTrustMode] = useState<TrustMode>("tofu");
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>("pairing");
  const [groupPolicy, setGroupPolicy] = useState<GroupPolicy>("allowlist");
  const [allowedNumbers, setAllowedNumbers] = useState("");
  const [sendReadReceipts, setSendReadReceipts] = useState(true);
  const [sendTypingIndicators, setSendTypingIndicators] = useState(true);

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const signalChannel = channels.find((c: ChannelData) => c.type === "signal");

      if (signalChannel) {
        setChannel(signalChannel);
        setChannelName(signalChannel.name);
        setSecurityMode(signalChannel.securityMode);
        onStatusChange?.(signalChannel.status === "connected");

        // Load config settings
        if (signalChannel.config) {
          setPhoneNumber((signalChannel.config.phoneNumber as string) || "");
          setCliPath((signalChannel.config.cliPath as string) || "");
          setDataDir((signalChannel.config.dataDir as string) || "");
          setMode((signalChannel.config.mode as SignalMode) || "native");
          setTrustMode((signalChannel.config.trustMode as TrustMode) || "tofu");
          setDmPolicy((signalChannel.config.dmPolicy as DmPolicy) || "pairing");
          setGroupPolicy((signalChannel.config.groupPolicy as GroupPolicy) || "allowlist");
          setSendReadReceipts((signalChannel.config.sendReadReceipts as boolean) ?? true);
          setSendTypingIndicators((signalChannel.config.sendTypingIndicators as boolean) ?? true);
          const numbers = (signalChannel.config.allowedNumbers as string[]) || [];
          setAllowedNumbers(numbers.join(", "));
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(signalChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error("Failed to load Signal channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "signal") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (!phoneNumber.trim()) {
      setTestResult({ success: false, error: "Phone number is required" });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: "signal",
        name: channelName,
        securityMode,
        phoneNumber: phoneNumber.trim(),
        cliPath: cliPath || undefined,
        dataDir: dataDir || undefined,
        mode,
        trustMode,
        dmPolicy,
        groupPolicy,
        sendReadReceipts,
        sendTypingIndicators,
        allowedNumbers: allowedNumbers
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
      });

      await loadChannel();
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveChannel = async () => {
    if (!channel) return;

    if (!confirm("Are you sure you want to remove the Signal channel?")) {
      return;
    }

    try {
      setSaving(true);
      await window.electronAPI.removeGatewayChannel(channel.id);
      setChannel(null);
      setUsers([]);
      onStatusChange?.(false);
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecurityMode = async (newMode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: newMode,
      });
      setSecurityMode(newMode);
      setChannel({ ...channel, securityMode: newMode });
    } catch (error: any) {
      console.error("Failed to update security mode:", error);
    }
  };

  const handleUpdateConfig = async () => {
    if (!channel) return;

    try {
      setSaving(true);
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: {
          ...channel.config,
          sendReadReceipts,
          sendTypingIndicators,
          trustMode,
          dmPolicy,
          groupPolicy,
          allowedNumbers: allowedNumbers
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean),
        },
      });
      setTestResult({ success: true, error: undefined });
      await loadChannel();
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
    } catch (error: any) {
      console.error("Failed to generate pairing code:", error);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, userId);
      await loadChannel();
    } catch (error: any) {
      console.error("Failed to revoke access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Signal settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="signal-settings">
        <div className="settings-section">
          <h3>Connect Signal</h3>
          <p className="settings-description">
            Connect Signal to receive and send end-to-end encrypted messages. Requires signal-cli to
            be installed and registered with your phone number.
          </p>

          <div className="settings-callout info">
            <strong>Setup Instructions:</strong>
            <ol style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
              <li style={{ marginBottom: "8px" }}>
                <strong>Install signal-cli:</strong>
                <br />
                <code style={{ display: "inline-block", marginTop: "4px" }}>
                  brew install signal-cli
                </code>
                <span style={{ fontSize: "13px", display: "block", marginTop: "4px" }}>
                  Or download from{" "}
                  <a
                    href="https://github.com/AsamK/signal-cli"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    github.com/AsamK/signal-cli
                  </a>
                </span>
              </li>
              <li style={{ marginBottom: "8px" }}>
                <strong>Register your phone number:</strong>
                <br />
                <code style={{ display: "inline-block", marginTop: "4px" }}>
                  signal-cli -u +1YOURNUMBER register
                </code>
                <br />
                <code style={{ display: "inline-block", marginTop: "4px" }}>
                  signal-cli -u +1YOURNUMBER verify CODE
                </code>
              </li>
              <li style={{ marginBottom: "8px" }}>
                <strong>Or link to existing device:</strong>
                <br />
                <code style={{ display: "inline-block", marginTop: "4px" }}>
                  signal-cli link -n "CoWork OS"
                </code>
                <br />
                <span style={{ fontSize: "13px" }}>Scan the QR code with your Signal app</span>
              </li>
            </ol>
          </div>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My Signal"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Phone Number *</label>
            <input
              type="text"
              className="settings-input"
              placeholder="+14155551234"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <p className="settings-hint">
              Your registered Signal phone number in E.164 format (with + prefix)
            </p>
          </div>

          <div className="settings-field">
            <label>Security Mode</label>
            <select
              className="settings-select"
              value={securityMode}
              onChange={(e) => setSecurityMode(e.target.value as SecurityMode)}
            >
              <option value="open">Open (anyone can message)</option>
              <option value="allowlist">Allowlist (specific numbers only)</option>
              <option value="pairing">Pairing (require code to connect)</option>
            </select>
            <p className="settings-hint">Controls who can interact with your bot via Signal</p>
          </div>

          <div className="settings-field">
            <label>DM Policy</label>
            <select
              className="settings-select"
              value={dmPolicy}
              onChange={(e) => setDmPolicy(e.target.value as DmPolicy)}
            >
              <option value="open">Open</option>
              <option value="allowlist">Allowlist</option>
              <option value="pairing">Pairing (default)</option>
              <option value="disabled">Disabled</option>
            </select>
            <p className="settings-hint">How to handle direct messages</p>
          </div>

          <div className="settings-field">
            <label>Group Policy</label>
            <select
              className="settings-select"
              value={groupPolicy}
              onChange={(e) => setGroupPolicy(e.target.value as GroupPolicy)}
            >
              <option value="open">Open</option>
              <option value="allowlist">Allowlist (default)</option>
              <option value="disabled">Disabled</option>
            </select>
            <p className="settings-hint">How to handle group messages</p>
          </div>

          {(securityMode === "allowlist" ||
            dmPolicy === "allowlist" ||
            groupPolicy === "allowlist") && (
            <div className="settings-field">
              <label>Allowed Phone Numbers</label>
              <input
                type="text"
                className="settings-input"
                placeholder="+14155551234, +14155555678"
                value={allowedNumbers}
                onChange={(e) => setAllowedNumbers(e.target.value)}
              />
              <p className="settings-hint">
                Comma-separated phone numbers in E.164 format (with + prefix)
              </p>
            </div>
          )}

          <div className="settings-field">
            <label>Trust Mode</label>
            <select
              className="settings-select"
              value={trustMode}
              onChange={(e) => setTrustMode(e.target.value as TrustMode)}
            >
              <option value="tofu">Trust on first use (default)</option>
              <option value="always">Always trust</option>
              <option value="manual">Manual verification</option>
            </select>
            <p className="settings-hint">How to handle new contact identity keys</p>
          </div>

          <div className="settings-field">
            <label>Communication Mode</label>
            <select
              className="settings-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as SignalMode)}
            >
              <option value="native">Native (default)</option>
              <option value="daemon">Daemon (JSON-RPC)</option>
            </select>
            <p className="settings-hint">How to communicate with signal-cli</p>
          </div>

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Send Read Receipts</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={sendReadReceipts}
                  onChange={(e) => setSendReadReceipts(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Send Typing Indicators</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={sendTypingIndicators}
                  onChange={(e) => setSendTypingIndicators(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-field">
            <label>CLI Path (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="signal-cli (default)"
              value={cliPath}
              onChange={(e) => setCliPath(e.target.value)}
            />
            <p className="settings-hint">
              Path to the signal-cli executable. Leave empty to use default.
            </p>
          </div>

          <div className="settings-field">
            <label>Data Directory (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="~/.local/share/signal-cli (default)"
              value={dataDir}
              onChange={(e) => setDataDir(e.target.value)}
            />
            <p className="settings-hint">
              signal-cli data directory. Leave empty for default location.
            </p>
          </div>

          {testResult && (
            <div className={`settings-callout ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? "Connection successful!" : testResult.error}
            </div>
          )}

          <button
            className="settings-button primary"
            onClick={handleAddChannel}
            disabled={saving || !channelName.trim() || !phoneNumber.trim()}
          >
            {saving ? "Connecting..." : "Connect Signal"}
          </button>
        </div>
      </div>
    );
  }

  // Channel exists - show management UI
  return (
    <div className="signal-settings">
      <div className="settings-section">
        <h3>Signal</h3>
        <p className="settings-description">Manage your Signal connection and access settings.</p>

        <div className="settings-status">
          <div className="status-row">
            <span className="status-label">Status:</span>
            <span className={`status-value status-${channel.status}`}>
              {channel.status === "connected"
                ? "Connected"
                : channel.status === "connecting"
                  ? "Connecting..."
                  : channel.status === "error"
                    ? "Error"
                    : "Disconnected"}
            </span>
          </div>
          {channel.botUsername && (
            <div className="status-row">
              <span className="status-label">Phone:</span>
              <span className="status-value">{channel.botUsername}</span>
            </div>
          )}
        </div>

        <div className="settings-actions">
          <button
            className={`settings-button ${channel.enabled ? "danger" : "primary"}`}
            onClick={handleToggleEnabled}
            disabled={saving}
          >
            {saving ? "Updating..." : channel.enabled ? "Disable" : "Enable"}
          </button>

          <button
            className="settings-button"
            onClick={handleTestConnection}
            disabled={testing || !channel.enabled}
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>

          <button
            className="settings-button danger"
            onClick={handleRemoveChannel}
            disabled={saving}
          >
            Remove Channel
          </button>
        </div>

        {testResult && (
          <div className={`settings-callout ${testResult.success ? "success" : "error"}`}>
            {testResult.success ? "Connection test successful!" : testResult.error}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Security Settings</h4>

        <div className="settings-field">
          <label>Security Mode</label>
          <select
            className="settings-select"
            value={securityMode}
            onChange={(e) => handleUpdateSecurityMode(e.target.value as SecurityMode)}
          >
            <option value="open">Open (anyone can message)</option>
            <option value="allowlist">Allowlist (specific numbers only)</option>
            <option value="pairing">Pairing (require code to connect)</option>
          </select>
        </div>

        {securityMode === "pairing" && (
          <div className="settings-field">
            <label>Pairing Code</label>
            {pairingCode ? (
              <div className="pairing-code">
                <code>{pairingCode}</code>
                <p className="settings-hint">
                  Share this code with users who want to connect. It expires in 5 minutes.
                </p>
              </div>
            ) : (
              <button className="settings-button" onClick={handleGeneratePairingCode}>
                Generate Pairing Code
              </button>
            )}
          </div>
        )}
      </div>

      <div className="settings-section">
        <h4>Message Settings</h4>

        <div className="settings-field">
          <label>DM Policy</label>
          <select
            className="settings-select"
            value={dmPolicy}
            onChange={(e) => setDmPolicy(e.target.value as DmPolicy)}
          >
            <option value="open">Open</option>
            <option value="allowlist">Allowlist</option>
            <option value="pairing">Pairing</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="settings-field">
          <label>Group Policy</label>
          <select
            className="settings-select"
            value={groupPolicy}
            onChange={(e) => setGroupPolicy(e.target.value as GroupPolicy)}
          >
            <option value="open">Open</option>
            <option value="allowlist">Allowlist</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        {(dmPolicy === "allowlist" || groupPolicy === "allowlist") && (
          <div className="settings-field">
            <label>Allowed Phone Numbers</label>
            <input
              type="text"
              className="settings-input"
              placeholder="+14155551234, +14155555678"
              value={allowedNumbers}
              onChange={(e) => setAllowedNumbers(e.target.value)}
            />
            <p className="settings-hint">Comma-separated phone numbers in E.164 format</p>
          </div>
        )}

        <div className="settings-field">
          <label>Trust Mode</label>
          <select
            className="settings-select"
            value={trustMode}
            onChange={(e) => setTrustMode(e.target.value as TrustMode)}
          >
            <option value="tofu">Trust on first use</option>
            <option value="always">Always trust</option>
            <option value="manual">Manual verification</option>
          </select>
        </div>

        <div className="settings-field">
          <div className="settings-checkbox-label">
            <span>Send Read Receipts</span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={sendReadReceipts}
                onChange={(e) => setSendReadReceipts(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className="settings-field">
          <div className="settings-checkbox-label">
            <span>Send Typing Indicators</span>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={sendTypingIndicators}
                onChange={(e) => setSendTypingIndicators(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <button className="settings-button primary" onClick={handleUpdateConfig} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {users.length > 0 && (
        <div className="settings-section">
          <h4>Authorized Users</h4>
          <div className="users-list">
            {users.map((user) => (
              <div key={user.id} className="user-item">
                <div className="user-info">
                  <span className="user-name">{user.displayName}</span>
                  <span className="user-id">{user.channelUserId}</span>
                </div>
                <button
                  className="settings-button small danger"
                  onClick={() => handleRevokeAccess(user.channelUserId)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
