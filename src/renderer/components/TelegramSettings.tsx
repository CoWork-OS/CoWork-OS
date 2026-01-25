import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface TelegramSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function TelegramSettings({ onStatusChange }: TelegramSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; botUsername?: string } | null>(null);

  // Form state
  const [botToken, setBotToken] = useState('');
  const [channelName, setChannelName] = useState('Telegram Bot');
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
      const telegramChannel = channels.find((c: ChannelData) => c.type === 'telegram');

      if (telegramChannel) {
        setChannel(telegramChannel);
        setChannelName(telegramChannel.name);
        setSecurityMode(telegramChannel.securityMode);
        onStatusChange?.(telegramChannel.status === 'connected');

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(telegramChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load Telegram channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!botToken.trim()) return;

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: 'telegram',
        name: channelName,
        botToken: botToken.trim(),
        securityMode,
      });

      setBotToken('');
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

    if (!confirm('Are you sure you want to remove the Telegram channel?')) {
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
    return <div className="settings-loading">Loading Telegram settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="telegram-settings">
        <div className="settings-section">
          <h3>Connect Telegram Bot</h3>
          <p className="settings-description">
            Create a bot with @BotFather on Telegram, then enter the bot token here.
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
              placeholder="1234567890:ABCdefGHI..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="settings-hint">
              Get this from @BotFather after creating your bot
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
              {securityMode === 'allowlist' && 'Only pre-approved Telegram user IDs can use the bot'}
              {securityMode === 'open' && 'Anyone who messages the bot can use it (not recommended)'}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? (
                <>✓ Connected as @{testResult.botUsername}</>
              ) : (
                <>✗ {testResult.error}</>
              )}
            </div>
          )}

          <button
            className="button-primary"
            onClick={handleAddChannel}
            disabled={saving || !botToken.trim()}
          >
            {saving ? 'Adding...' : 'Add Telegram Bot'}
          </button>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="telegram-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">@{channel.botUsername}</span>}
            </h3>
            <div className={`channel-status ${channel.status}`}>
              {channel.status === 'connected' && '● Connected'}
              {channel.status === 'connecting' && '○ Connecting...'}
              {channel.status === 'disconnected' && '○ Disconnected'}
              {channel.status === 'error' && '● Error'}
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
              <>✓ Connection successful</>
            ) : (
              <>✗ {testResult.error}</>
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
            Generate a one-time code for a user to enter in Telegram to gain access.
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
                User should send this code to the bot within 5 minutes
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
                    {user.allowed ? '✓ Allowed' : '○ Pending'}
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
