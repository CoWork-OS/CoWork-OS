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

interface TwitchSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function TwitchSettings({ onStatusChange }: TwitchSettingsProps) {
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
  const [channelName, setChannelName] = useState("Twitch");
  const [securityMode, setSecurityMode] = useState<SecurityMode>("pairing");
  const [username, setUsername] = useState("");
  const [oauthToken, setOauthToken] = useState("");
  const [twitchChannels, setTwitchChannels] = useState("");
  const [allowWhispers, setAllowWhispers] = useState(false);

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
      const twitchChannel = channels.find((c: ChannelData) => c.type === "twitch");

      if (twitchChannel) {
        setChannel(twitchChannel);
        setChannelName(twitchChannel.name);
        setSecurityMode(twitchChannel.securityMode);
        onStatusChange?.(twitchChannel.status === "connected");

        // Load config settings
        if (twitchChannel.config) {
          setUsername((twitchChannel.config.username as string) || "");
          setOauthToken((twitchChannel.config.oauthToken as string) || "");
          const chans = (twitchChannel.config.channels as string[]) || [];
          setTwitchChannels(chans.join(", "));
          setAllowWhispers((twitchChannel.config.allowWhispers as boolean) || false);
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(twitchChannel.id);
        setUsers(channelUsers);

        // Load context policies
        const policies = await window.electronAPI.listContextPolicies(twitchChannel.id);
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
      console.error("Failed to load Twitch channel:", error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== "twitch") return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

  const handleAddChannel = async () => {
    if (!username.trim() || !oauthToken.trim() || !twitchChannels.trim()) {
      setTestResult({
        success: false,
        error: "Username, OAuth token, and at least one channel are required",
      });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const channelList = twitchChannels
        .split(",")
        .map((c) => c.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean);

      if (channelList.length === 0) {
        setTestResult({ success: false, error: "At least one Twitch channel is required" });
        setSaving(false);
        return;
      }

      await window.electronAPI.addGatewayChannel({
        type: "twitch",
        name: channelName,
        securityMode,
        twitchUsername: username.trim().toLowerCase(),
        twitchOauthToken: oauthToken.trim(),
        twitchChannels: channelList,
        twitchAllowWhispers: allowWhispers,
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

    if (!confirm("Are you sure you want to remove the Twitch channel?")) {
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

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      setGeneratingCode(true);
      const code = await window.electronAPI.generateGatewayPairing(channel.id, "");
      setPairingCode(code);
      // Default TTL is 5 minutes (300 seconds)
      setPairingExpiresAt(Date.now() + 5 * 60 * 1000);
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      console.error("Failed to revoke access:", error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Twitch settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="twitch-settings">
        <div className="settings-section">
          <h3>Connect Twitch</h3>
          <p className="settings-description">
            Connect to Twitch chat to receive and send messages in channels. Great for stream
            interactions and chat commands.
          </p>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My Twitch Bot"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Twitch Username</label>
            <input
              type="text"
              className="settings-input"
              placeholder="your_twitch_username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <p className="settings-hint">
              Your Twitch login name (the account that will send messages)
            </p>
          </div>

          <div className="settings-field">
            <label>OAuth Token</label>
            <input
              type="password"
              className="settings-input"
              placeholder="oauth:xxxxxxxxxxxxxxx"
              value={oauthToken}
              onChange={(e) => setOauthToken(e.target.value)}
            />
            <p className="settings-hint">
              Get a token from{" "}
              <a href="https://twitchtokengenerator.com/" target="_blank" rel="noopener noreferrer">
                twitchtokengenerator.com
              </a>
            </p>
          </div>

          <div className="settings-field">
            <label>Twitch Channels</label>
            <input
              type="text"
              className="settings-input"
              placeholder="channel1, channel2, channel3"
              value={twitchChannels}
              onChange={(e) => setTwitchChannels(e.target.value)}
            />
            <p className="settings-hint">Comma-separated channel names to join (without #)</p>
          </div>

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Allow Whispers (DMs)</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={allowWhispers}
                  onChange={(e) => setAllowWhispers(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">Enable receiving and responding to Twitch whispers</p>
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
              {securityMode === "allowlist" && "Only pre-approved Twitch user IDs can use the bot"}
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
            disabled={saving || !username.trim() || !oauthToken.trim() || !twitchChannels.trim()}
          >
            {saving ? "Adding..." : "Add Twitch"}
          </button>
        </div>

        <div className="settings-section">
          <h4>Setup Instructions</h4>
          <ol className="setup-instructions">
            <li>
              Visit{" "}
              <a href="https://twitchtokengenerator.com/" target="_blank" rel="noopener noreferrer">
                twitchtokengenerator.com
              </a>
            </li>
            <li>Generate a Chat Bot token</li>
            <li>Enter your Twitch username and the OAuth token above</li>
            <li>Add the channel names you want to monitor</li>
          </ol>
        </div>

        <div className="settings-section">
          <h4>Twitch Limitations</h4>
          <ul className="setup-instructions">
            <li>Rate limited to 20 messages per 30 seconds</li>
            <li>No file/image attachments (text only)</li>
            <li>Messages limited to 500 characters</li>
            <li>Whispers may require verified accounts</li>
          </ul>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="twitch-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">@{channel.botUsername}</span>}
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
            Generate a one-time code for a user to enter in Twitch to gain access.
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
          channelType="twitch"
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
                  {user.username && <span className="user-username">@{user.username}</span>}
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
