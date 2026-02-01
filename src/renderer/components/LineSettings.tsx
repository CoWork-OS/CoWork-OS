import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface LineSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function LineSettings({ onStatusChange }: LineSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState('LINE');
  const [securityMode, setSecurityMode] = useState<SecurityMode>('pairing');
  const [channelAccessToken, setChannelAccessToken] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [webhookPort, setWebhookPort] = useState(3100);

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  useEffect(() => {
    loadChannel();
  }, []);

  const loadChannel = async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const lineChannel = channels.find((c: ChannelData) => c.type === 'line');

      if (lineChannel) {
        setChannel(lineChannel);
        setChannelName(lineChannel.name);
        setSecurityMode(lineChannel.securityMode);
        onStatusChange?.(lineChannel.status === 'connected');

        // Load config settings
        if (lineChannel.config) {
          setChannelAccessToken(lineChannel.config.channelAccessToken as string || '');
          setChannelSecret(lineChannel.config.channelSecret as string || '');
          setWebhookPort(lineChannel.config.webhookPort as number || 3100);
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(lineChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load LINE channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!channelAccessToken.trim() || !channelSecret.trim()) {
      setTestResult({ success: false, error: 'Channel access token and channel secret are required' });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: 'line',
        name: channelName,
        securityMode,
        lineChannelAccessToken: channelAccessToken.trim(),
        lineChannelSecret: channelSecret.trim(),
        lineWebhookPort: webhookPort,
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

    if (!confirm('Are you sure you want to remove the LINE channel?')) {
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

  const handleRevokeAccess = async (channelUserId: string) => {
    if (!channel) return;

    try {
      await window.electronAPI.revokeGatewayAccess(channel.id, channelUserId);
      await loadChannel();
    } catch (error: any) {
      console.error('Failed to revoke access:', error);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading LINE settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="line-settings">
        <div className="settings-section">
          <h3>Connect LINE</h3>
          <p className="settings-description">
            Connect to LINE Messaging API to receive and send messages. Popular in Asia with 200M+ users.
          </p>

          <div className="settings-callout info">
            <strong>Setup Instructions:</strong>
            <ol style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
              <li style={{ marginBottom: '8px' }}>
                <strong>Create a LINE Channel:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  Go to <a href="https://developers.line.biz/" target="_blank" rel="noopener noreferrer">LINE Developers Console</a> and create a Messaging API channel
                </span>
              </li>
              <li style={{ marginBottom: '8px' }}>
                <strong>Get Channel Credentials:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  Copy the Channel Access Token and Channel Secret from your channel settings
                </span>
              </li>
              <li style={{ marginBottom: '8px' }}>
                <strong>Configure Webhook:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  Set your webhook URL to: your-server/line/webhook (use ngrok for development)
                </span>
              </li>
            </ol>
          </div>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My LINE Bot"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Channel Access Token *</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Your long-lived channel access token"
              value={channelAccessToken}
              onChange={(e) => setChannelAccessToken(e.target.value)}
            />
            <p className="settings-hint">
              Found in LINE Developers Console under Messaging API settings
            </p>
          </div>

          <div className="settings-field">
            <label>Channel Secret *</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Your channel secret"
              value={channelSecret}
              onChange={(e) => setChannelSecret(e.target.value)}
            />
            <p className="settings-hint">
              Used to verify webhook signatures
            </p>
          </div>

          <div className="settings-field">
            <label>Webhook Port</label>
            <input
              type="number"
              className="settings-input"
              placeholder="3100"
              value={webhookPort}
              onChange={(e) => setWebhookPort(parseInt(e.target.value) || 3100)}
            />
            <p className="settings-hint">
              Port for the webhook server (default: 3100)
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
              <option value="allowlist">Allowlist (specific users only)</option>
              <option value="pairing">Pairing (require code to connect)</option>
            </select>
            <p className="settings-hint">
              Controls who can interact with your bot via LINE
            </p>
          </div>

          {testResult && (
            <div className={`settings-callout ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? 'Connection successful!' : testResult.error}
            </div>
          )}

          <button
            className="settings-button primary"
            onClick={handleAddChannel}
            disabled={saving || !channelName.trim() || !channelAccessToken.trim() || !channelSecret.trim()}
          >
            {saving ? 'Connecting...' : 'Connect LINE'}
          </button>
        </div>

        <div className="settings-section">
          <h4>LINE Features</h4>
          <ul style={{ margin: '8px 0', paddingLeft: '20px', fontSize: '13px' }}>
            <li>Real-time messaging via webhooks</li>
            <li>Support for text, stickers, and rich messages</li>
            <li>Reply tokens for fast, free responses</li>
            <li>Group and room support</li>
          </ul>
        </div>
      </div>
    );
  }

  // Channel exists - show management UI
  return (
    <div className="line-settings">
      <div className="settings-section">
        <h3>LINE</h3>
        <p className="settings-description">
          Manage your LINE connection and access settings.
        </p>

        <div className="settings-status">
          <div className="status-row">
            <span className="status-label">Status:</span>
            <span className={`status-value status-${channel.status}`}>
              {channel.status === 'connected' ? 'Connected' :
               channel.status === 'connecting' ? 'Connecting...' :
               channel.status === 'error' ? 'Error' : 'Disconnected'}
            </span>
          </div>
          {channel.botUsername && (
            <div className="status-row">
              <span className="status-label">Bot Name:</span>
              <span className="status-value">{channel.botUsername}</span>
            </div>
          )}
          <div className="status-row">
            <span className="status-label">Webhook Port:</span>
            <span className="status-value">{String(channel.config?.webhookPort || 3100)}</span>
          </div>
        </div>

        <div className="settings-actions">
          <button
            className={`settings-button ${channel.enabled ? 'danger' : 'primary'}`}
            onClick={handleToggleEnabled}
            disabled={saving}
          >
            {saving ? 'Updating...' : channel.enabled ? 'Disable' : 'Enable'}
          </button>

          <button
            className="settings-button"
            onClick={handleTestConnection}
            disabled={testing || !channel.enabled}
          >
            {testing ? 'Testing...' : 'Test Connection'}
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
          <div className={`settings-callout ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? 'Connection test successful!' : testResult.error}
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
            <option value="allowlist">Allowlist (specific users only)</option>
            <option value="pairing">Pairing (require code to connect)</option>
          </select>
        </div>

        {securityMode === 'pairing' && (
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
              <button
                className="settings-button"
                onClick={handleGeneratePairingCode}
              >
                Generate Pairing Code
              </button>
            )}
          </div>
        )}
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
