import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface BlueBubblesSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function BlueBubblesSettings({ onStatusChange }: BlueBubblesSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState('BlueBubbles');
  const [securityMode, setSecurityMode] = useState<SecurityMode>('pairing');
  const [serverUrl, setServerUrl] = useState('');
  const [password, setPassword] = useState('');
  const [webhookPort, setWebhookPort] = useState(3101);
  const [allowedContacts, setAllowedContacts] = useState('');

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  useEffect(() => {
    loadChannel();
  }, []);

  const loadChannel = async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const bbChannel = channels.find((c: ChannelData) => c.type === 'bluebubbles');

      if (bbChannel) {
        setChannel(bbChannel);
        setChannelName(bbChannel.name);
        setSecurityMode(bbChannel.securityMode);
        onStatusChange?.(bbChannel.status === 'connected');

        // Load config settings
        if (bbChannel.config) {
          setServerUrl(bbChannel.config.serverUrl as string || '');
          setPassword(bbChannel.config.password as string || '');
          setWebhookPort(bbChannel.config.webhookPort as number || 3101);
          const contacts = bbChannel.config.allowedContacts as string[] || [];
          setAllowedContacts(contacts.join(', '));
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(bbChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load BlueBubbles channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!serverUrl.trim() || !password.trim()) {
      setTestResult({ success: false, error: 'Server URL and password are required' });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const contactList = allowedContacts
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);

      await window.electronAPI.addGatewayChannel({
        type: 'bluebubbles',
        name: channelName,
        securityMode,
        blueBubblesServerUrl: serverUrl.trim(),
        blueBubblesPassword: password.trim(),
        blueBubblesWebhookPort: webhookPort,
        blueBubblesAllowedContacts: contactList.length > 0 ? contactList : undefined,
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

    if (!confirm('Are you sure you want to remove the BlueBubbles channel?')) {
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
    return <div className="settings-loading">Loading BlueBubbles settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="bluebubbles-settings">
        <div className="settings-section">
          <h3>Connect BlueBubbles</h3>
          <p className="settings-description">
            Connect to iMessage via BlueBubbles server. Enables iMessage integration on any platform.
          </p>

          <div className="settings-callout info">
            <strong>Prerequisites:</strong>
            <ol style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
              <li style={{ marginBottom: '8px' }}>
                <strong>Set up BlueBubbles Server:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  Download and install <a href="https://bluebubbles.app/" target="_blank" rel="noopener noreferrer">BlueBubbles Server</a> on a Mac with iMessage
                </span>
              </li>
              <li style={{ marginBottom: '8px' }}>
                <strong>Configure the Server:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  Set up the server and note the URL and password
                </span>
              </li>
              <li style={{ marginBottom: '8px' }}>
                <strong>Ensure Network Access:</strong><br />
                <span style={{ fontSize: '13px' }}>
                  The BlueBubbles server must be accessible from this machine
                </span>
              </li>
            </ol>
          </div>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="iMessage via BlueBubbles"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Server URL *</label>
            <input
              type="text"
              className="settings-input"
              placeholder="http://192.168.1.100:1234"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
            <p className="settings-hint">
              URL of your BlueBubbles server (found in server settings)
            </p>
          </div>

          <div className="settings-field">
            <label>Server Password *</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Your BlueBubbles server password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="settings-hint">
              The password configured in BlueBubbles server
            </p>
          </div>

          <div className="settings-field">
            <label>Webhook Port</label>
            <input
              type="number"
              className="settings-input"
              placeholder="3101"
              value={webhookPort}
              onChange={(e) => setWebhookPort(parseInt(e.target.value) || 3101)}
            />
            <p className="settings-hint">
              Port for receiving notifications (default: 3101)
            </p>
          </div>

          <div className="settings-field">
            <label>Allowed Contacts (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="+1234567890, email@example.com"
              value={allowedContacts}
              onChange={(e) => setAllowedContacts(e.target.value)}
            />
            <p className="settings-hint">
              Comma-separated phone numbers or emails (leave empty for all)
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
              Controls who can interact with your bot via iMessage
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
            disabled={saving || !channelName.trim() || !serverUrl.trim() || !password.trim()}
          >
            {saving ? 'Connecting...' : 'Connect BlueBubbles'}
          </button>
        </div>

        <div className="settings-section">
          <h4>BlueBubbles Features</h4>
          <ul style={{ margin: '8px 0', paddingLeft: '20px', fontSize: '13px' }}>
            <li>Full iMessage integration via REST API</li>
            <li>Send and receive iMessage/SMS</li>
            <li>Supports webhooks for real-time notifications</li>
            <li>Works from any platform (not just Mac)</li>
            <li>Group chat support</li>
          </ul>
        </div>
      </div>
    );
  }

  // Channel exists - show management UI
  return (
    <div className="bluebubbles-settings">
      <div className="settings-section">
        <h3>BlueBubbles</h3>
        <p className="settings-description">
          Manage your BlueBubbles/iMessage connection and access settings.
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
              <span className="status-label">Server:</span>
              <span className="status-value">{channel.botUsername}</span>
            </div>
          )}
          <div className="status-row">
            <span className="status-label">Server URL:</span>
            <span className="status-value">{channel.config?.serverUrl as string || 'N/A'}</span>
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
