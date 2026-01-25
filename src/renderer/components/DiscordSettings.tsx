import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface DiscordSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function DiscordSettings({ onStatusChange }: DiscordSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; botUsername?: string } | null>(null);

  // Form state
  const [botToken, setBotToken] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [guildIds, setGuildIds] = useState('');
  const [channelName, setChannelName] = useState('Discord Bot');
  const [securityMode, setSecurityMode] = useState<SecurityMode>('pairing');

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  useEffect(() => {
    loadChannel();
  }, []);

  const loadChannel = async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const discordChannel = channels.find((c: ChannelData) => c.type === 'discord');

      if (discordChannel) {
        setChannel(discordChannel);
        setChannelName(discordChannel.name);
        setSecurityMode(discordChannel.securityMode);
        onStatusChange?.(discordChannel.status === 'connected');

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(discordChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load Discord channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!botToken.trim() || !applicationId.trim()) return;

    try {
      setSaving(true);
      setTestResult(null);

      // Parse guild IDs (comma-separated, optional)
      const parsedGuildIds = guildIds.trim()
        ? guildIds.split(',').map(id => id.trim()).filter(id => id)
        : undefined;

      await window.electronAPI.addGatewayChannel({
        type: 'discord',
        name: channelName,
        botToken: botToken.trim(),
        applicationId: applicationId.trim(),
        guildIds: parsedGuildIds,
        securityMode,
      });

      setBotToken('');
      setApplicationId('');
      setGuildIds('');
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

    if (!confirm('Are you sure you want to remove the Discord channel?')) {
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

  const handleUpdateSecurityMode = async (mode: SecurityMode) => {
    if (!channel) return;

    try {
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        securityMode: mode,
      });
      setSecurityMode(mode);
      setChannel({ ...channel, securityMode: mode });
    } catch (error: any) {
      console.error('Failed to update security mode:', error);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      const code = await window.electronAPI.generateGatewayPairing(channel.id, '');
      setPairingCode(code);
    } catch (error: any) {
      console.error('Failed to generate pairing code:', error);
    }
  };

  const handleRevokeAccess = async (userId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, userId);
      await loadChannel();
    } catch (error: any) {
      console.error('Failed to revoke access:', error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Discord settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="discord-settings">
        <div className="settings-section">
          <h3>Connect Discord Bot</h3>
          <p className="settings-description">
            Create a bot in the Discord Developer Portal, then enter the credentials here.
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
            <label>Application ID</label>
            <input
              type="text"
              className="settings-input"
              placeholder="123456789012345678"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
            />
            <p className="settings-hint">
              Found in Discord Developer Portal under your application's General Information
            </p>
          </div>

          <div className="settings-field">
            <label>Bot Token</label>
            <input
              type="password"
              className="settings-input"
              placeholder="MTIz..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="settings-hint">
              Found in Discord Developer Portal under your application's Bot section
            </p>
          </div>

          <div className="settings-field">
            <label>Guild IDs (Optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="123456789012345678, 987654321098765432"
              value={guildIds}
              onChange={(e) => setGuildIds(e.target.value)}
            />
            <p className="settings-hint">
              Comma-separated server IDs for instant slash command registration. Leave empty for global commands (takes up to 1 hour to propagate).
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
              {securityMode === 'pairing' && 'Users must enter a code generated in this app to use the bot'}
              {securityMode === 'allowlist' && 'Only pre-approved Discord user IDs can use the bot'}
              {securityMode === 'open' && 'Anyone who messages the bot can use it (not recommended)'}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
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
            disabled={saving || !botToken.trim() || !applicationId.trim()}
          >
            {saving ? 'Adding...' : 'Add Discord Bot'}
          </button>
        </div>

        <div className="settings-section">
          <h4>Setup Instructions</h4>
          <ol className="setup-instructions">
            <li>Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a></li>
            <li>Click "New Application" and give it a name</li>
            <li>Copy the Application ID from General Information</li>
            <li>Go to the Bot section and click "Add Bot"</li>
            <li>Click "Reset Token" and copy the bot token</li>
            <li>Under Privileged Gateway Intents, enable "Message Content Intent"</li>
            <li>Go to OAuth2 &gt; URL Generator, select "bot" and "applications.commands"</li>
            <li>Select permissions: Send Messages, Read Message History, Use Slash Commands</li>
            <li>Copy the generated URL and open it to add the bot to your server</li>
          </ol>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="discord-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">{channel.botUsername}</span>}
            </h3>
            <div className={`channel-status ${channel.status}`}>
              {channel.status === 'connected' && 'Connected'}
              {channel.status === 'connecting' && 'Connecting...'}
              {channel.status === 'disconnected' && 'Disconnected'}
              {channel.status === 'error' && 'Error'}
            </div>
          </div>
          <div className="channel-actions">
            <button
              className={channel.enabled ? 'button-secondary' : 'button-primary'}
              onClick={handleToggleEnabled}
              disabled={saving}
            >
              {channel.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="button-secondary"
              onClick={handleTestConnection}
              disabled={testing || !channel.enabled}
            >
              {testing ? 'Testing...' : 'Test'}
            </button>
            <button
              className="button-danger"
              onClick={handleRemoveChannel}
              disabled={saving}
            >
              Remove
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? (
              <>Connection successful</>
            ) : (
              <>{testResult.error}</>
            )}
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

      {securityMode === 'pairing' && (
        <div className="settings-section">
          <h4>Generate Pairing Code</h4>
          <p className="settings-description">
            Generate a one-time code for a user to enter in Discord to gain access.
          </p>
          <button
            className="button-secondary"
            onClick={handleGeneratePairingCode}
          >
            Generate Code
          </button>
          {pairingCode && (
            <div className="pairing-code-display">
              <span className="pairing-code">{pairingCode}</span>
              <p className="settings-hint">
                User should use /pair command with this code within 5 minutes
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
                  <span className={`user-status ${user.allowed ? 'allowed' : 'pending'}`}>
                    {user.allowed ? 'Allowed' : 'Pending'}
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
        <h4>Available Commands</h4>
        <div className="commands-list">
          <div className="command-item"><code>/start</code> - Start the bot and get help</div>
          <div className="command-item"><code>/help</code> - Show available commands</div>
          <div className="command-item"><code>/workspaces</code> - List available workspaces</div>
          <div className="command-item"><code>/workspace</code> - Select or show current workspace</div>
          <div className="command-item"><code>/addworkspace</code> - Add a new workspace by path</div>
          <div className="command-item"><code>/newtask</code> - Start a fresh task/conversation</div>
          <div className="command-item"><code>/provider</code> - Change or show current LLM provider</div>
          <div className="command-item"><code>/models</code> - List available AI models</div>
          <div className="command-item"><code>/model</code> - Change or show current model</div>
          <div className="command-item"><code>/status</code> - Check bot status</div>
          <div className="command-item"><code>/cancel</code> - Cancel current task</div>
          <div className="command-item"><code>/task</code> - Run a task directly</div>
          <div className="command-item"><code>/pair</code> - Pair with a pairing code</div>
        </div>
      </div>
    </div>
  );
}
