import { useState, useEffect, useCallback } from "react";
import {
  ChannelData,
  ChannelUserData,
  SecurityMode,
  ContextType,
  ContextPolicy,
} from "../../shared/types";
import { PairingCodeDisplay } from "./PairingCodeDisplay";
import { ContextPolicySettings } from "./ContextPolicySettings";

interface MatrixSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function MatrixSettings({ onStatusChange }: MatrixSettingsProps) {
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
  const [channelName, setChannelName] = useState("Matrix");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [homeserver, setHomeserver] = useState("");
  const [userId, setUserId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [roomIds, setRoomIds] = useState("");

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>(0);
  const [generatingCode, setGeneratingCode] = useState(false);

  // Context policy state
  const [contextPolicies, setContextPolicies] = useState<Record<ContextType, ContextPolicy>>(
    {} as Record<ContextType, ContextPolicy>,
  );
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadChannel = useCallback(async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const matrixChannel = channels.find((c: ChannelData) => c.type === "matrix");

      if (matrixChannel) {
        setChannel(matrixChannel);
        setChannelName(matrixChannel.name);
        setSecurityMode(matrixChannel.securityMode);
        onStatusChange?.(matrixChannel.status === "connected");

        // Load config settings
        if (matrixChannel.config) {
          setHomeserver((matrixChannel.config.homeserver as string) || "");
          setUserId((matrixChannel.config.userId as string) || "");
          setAccessToken((matrixChannel.config.accessToken as string) || "");
          setDeviceId((matrixChannel.config.deviceId as string) || "");
          const rooms = (matrixChannel.config.roomIds as string[]) || [];
          setRoomIds(rooms.join(", "));
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(matrixChannel.id);
        setUsers(channelUsers);

        // Load context policies
        const policies = await window.electronAPI.listContextPolicies(matrixChannel.id);
        const policyMap: Record<ContextType, ContextPolicy> = {} as Record<
          ContextType,
          ContextPolicy
        >;
        for (const policy of policies) {
          policyMap[policy.contextType as ContextType] = policy;
        }
        setContextPolicies(policyMap);
      }
    } catch (error) {
      console.error("Failed to load Matrix channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "matrix") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (!homeserver.trim() || !userId.trim() || !accessToken.trim()) {
      setTestResult({
        success: false,
        error: "Homeserver, User ID, and Access Token are required",
      });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const roomIdList = roomIds
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);

      await window.electronAPI.addGatewayChannel({
        type: "matrix",
        name: channelName,
        securityMode,
        matrixHomeserver: homeserver.trim(),
        matrixUserId: userId.trim(),
        matrixAccessToken: accessToken.trim(),
        matrixDeviceId: deviceId.trim() || undefined,
        matrixRoomIds: roomIdList.length > 0 ? roomIdList : undefined,
      });

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

    if (!confirm("Are you sure you want to remove the Matrix channel?")) {
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

  const handleUpdateSecurityMode = async (newMode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: newMode,
      });
      setSecurityMode(newMode);
      setChannel({ ...channel, securityMode: newMode });
    } catch (error: Any) {
      console.error("Failed to update security mode:", error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      setGeneratingCode(true);
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
      // Default TTL is 5 minutes (300 seconds)
      setPairingExpiresAt(Date.now() + 5 * 60 * 1000);
    } catch (error: Any) {
      console.error("Failed to generate pairing code:", error);
    } finally {
      setGeneratingCode(false);
    }
  };

  const handlePolicyChange = async (contextType: ContextType, updates: Partial<ContextPolicy>) => {
    if (!channel) return;

    try {
      setSavingPolicy(true);
      const updated = await window.electronAPI.updateContextPolicy(channel.id, contextType, {
        securityMode: updates.securityMode,
        toolRestrictions: updates.toolRestrictions,
      });
      setContextPolicies((prev) => ({
        ...prev,
        [contextType]: updated,
      }));
    } catch (error: Any) {
      console.error("Failed to update context policy:", error);
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRevokeAccess = async (channelUserId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, channelUserId);
      await loadChannel();
    } catch (error: Any) {
      console.error("Failed to revoke access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Matrix settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="matrix-settings">
        <div className="settings-section">
          <h3>Connect Matrix</h3>
          <p className="settings-description">
            Connect to a Matrix homeserver to receive and send messages. Matrix is a decentralized,
            open-source communication protocol.
          </p>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My Matrix"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Homeserver URL</label>
            <input
              type="text"
              className="settings-input"
              placeholder="https://matrix.org"
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
            />
            <p className="settings-hint">Your Matrix homeserver URL (include https://)</p>
          </div>

          <div className="settings-field">
            <label>User ID</label>
            <input
              type="text"
              className="settings-input"
              placeholder="@yourname:matrix.org"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <p className="settings-hint">Your Matrix user ID (e.g., @user:matrix.org)</p>
          </div>

          <div className="settings-field">
            <label>Access Token</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Enter your access token"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
            <p className="settings-hint">
              Found in Element: Settings &gt; Help &amp; About &gt; Advanced
            </p>
          </div>

          <div className="settings-field">
            <label>Device ID (Optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="Leave empty to auto-generate"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Room IDs (Optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="!roomid1:matrix.org, !roomid2:matrix.org"
              value={roomIds}
              onChange={(e) => setRoomIds(e.target.value)}
            />
            <p className="settings-hint">
              Comma-separated room IDs to listen to (leave empty for all joined rooms)
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
              {securityMode === "allowlist" && "Only pre-approved Matrix user IDs can use the bot"}
              {securityMode === "open" &&
                "Anyone who messages the bot can use it (not recommended)"}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? "success" : "error"}`}>
              {testResult.success ? (
                <>✓ Connected as {testResult.botUsername}</>
              ) : (
                <>✗ {testResult.error}</>
              )}
            </div>
          )}

          <button
            className="button-primary"
            onClick={handleAddChannel}
            disabled={saving || !homeserver.trim() || !userId.trim() || !accessToken.trim()}
          >
            {saving ? "Adding..." : "Add Matrix"}
          </button>
        </div>

        <div className="settings-section">
          <h4>Setup Instructions</h4>
          <ol className="setup-instructions">
            <li>Open Element or your Matrix client</li>
            <li>Go to Settings &gt; Help & About &gt; Advanced</li>
            <li>Copy your Access Token</li>
            <li>Find your User ID in your profile settings</li>
            <li>Enter the homeserver URL and credentials above</li>
          </ol>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="matrix-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">{channel.botUsername}</span>}
            </h3>
            <div className={`channel-status ${channel.status}`}>
              {channel.status === "connected" && "● Connected"}
              {channel.status === "connecting" && "○ Connecting..."}
              {channel.status === "disconnected" && "○ Disconnected"}
              {channel.status === "error" && "● Error"}
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
            {testResult.success ? <>✓ Connection successful</> : <>✗ {testResult.error}</>}
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
            Generate a one-time code for a user to enter in Matrix to gain access.
          </p>
          {pairingCode && pairingExpiresAt > 0 ? (
            <PairingCodeDisplay
              code={pairingCode}
              expiresAt={pairingExpiresAt}
              onRegenerate={handleGeneratePairingCode}
              isRegenerating={generatingCode}
            />
          ) : (
            <button
              className="button-secondary"
              onClick={handleGeneratePairingCode}
              disabled={generatingCode}
            >
              {generatingCode ? "Generating..." : "Generate Code"}
            </button>
          )}
        </div>
      )}

      {/* Per-Context Security Policies (DM vs Group) */}
      <div className="settings-section">
        <h4>Context Policies</h4>
        <p className="settings-description">
          Configure different security settings for direct messages vs group chats.
        </p>
        <ContextPolicySettings
          channelId={channel.id}
          channelType="matrix"
          policies={contextPolicies}
          onPolicyChange={handlePolicyChange}
          isSaving={savingPolicy}
        />
      </div>

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
                  {user.username && <span className="user-username">{user.username}</span>}
                  <span className={`user-status ${user.allowed ? "allowed" : "pending"}`}>
                    {user.allowed ? "✓ Allowed" : "○ Pending"}
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
    </div>
  );
}
