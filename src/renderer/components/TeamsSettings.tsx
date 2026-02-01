import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface TeamsSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function TeamsSettings({ onStatusChange }: TeamsSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; botUsername?: string } | null>(null);

  // Form state
  const [appId, setAppId] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [webhookPort, setWebhookPort] = useState('3978');
  const [channelName, setChannelName] = useState('Teams Bot');
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
      const teamsChannel = channels.find((c: ChannelData) => c.type === 'teams');

      if (teamsChannel) {
        setChannel(teamsChannel);
        setChannelName(teamsChannel.name);
        setSecurityMode(teamsChannel.securityMode);
        onStatusChange?.(teamsChannel.status === 'connected');

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(teamsChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load Teams channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!appId.trim() || !appPassword.trim()) return;

    try {
      setSaving(true);
      setTestResult(null);

      await window.electronAPI.addGatewayChannel({
        type: 'teams',
        name: channelName,
        appId: appId.trim(),
        appPassword: appPassword.trim(),
        tenantId: tenantId.trim() || undefined,
        webhookPort: parseInt(webhookPort) || 3978,
        securityMode,
      });

      setAppId('');
      setAppPassword('');
      setTenantId('');
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

    if (!confirm('Are you sure you want to remove the Microsoft Teams channel?')) {
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
    return <div className="settings-loading">Loading Microsoft Teams settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="teams-settings">
        <div className="settings-section">
          <h3>Connect Microsoft Teams Bot</h3>
          <p className="settings-description">
            Create an Azure Bot resource, then enter the credentials here. A public webhook URL is required.
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
            <label>Microsoft App ID</label>
            <input
              type="text"
              className="settings-input"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <p className="settings-hint">
              Found in Azure Portal &gt; Bot Services &gt; Configuration
            </p>
          </div>

          <div className="settings-field">
            <label>Microsoft App Password</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Client Secret"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
            />
            <p className="settings-hint">
              Create in Azure Portal &gt; App Registrations &gt; Certificates & secrets
            </p>
          </div>

          <div className="settings-field">
            <label>Tenant ID (Optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="Leave empty for multi-tenant"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            />
            <p className="settings-hint">
              Required only for single-tenant apps. Leave empty for multi-tenant.
            </p>
          </div>

          <div className="settings-field">
            <label>Webhook Port</label>
            <input
              type="number"
              className="settings-input"
              placeholder="3978"
              value={webhookPort}
              onChange={(e) => setWebhookPort(e.target.value)}
            />
            <p className="settings-hint">
              Local port for receiving Teams messages (default: 3978)
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
              {securityMode === 'allowlist' && 'Only pre-approved Teams user IDs can use the bot'}
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
            disabled={saving || !appId.trim() || !appPassword.trim()}
          >
            {saving ? 'Adding...' : 'Add Teams Bot'}
          </button>
        </div>

        <div className="settings-section">
          <h4>Setup Instructions</h4>
          <ol className="setup-instructions">
            <li>Go to <a href="https://portal.azure.com/#create/Microsoft.AzureBot" target="_blank" rel="noopener noreferrer">Azure Portal - Create Bot</a></li>
            <li>Create a new Azure Bot resource with Multi-tenant or Single-tenant type</li>
            <li>In the Bot resource, go to <strong>Configuration</strong> to find the Microsoft App ID</li>
            <li>Click "Manage Password" to go to App Registration, then create a new client secret</li>
            <li>In <strong>Channels</strong>, add Microsoft Teams as a channel</li>
            <li>Set up ngrok or a tunnel to expose your local webhook:
              <ul>
                <li><code>ngrok http 3978</code></li>
                <li>Set messaging endpoint to: <code>https://your-ngrok-url/api/messages</code></li>
              </ul>
            </li>
            <li>In Azure Bot &gt; Configuration, set the Messaging endpoint to your public URL + <code>/api/messages</code></li>
          </ol>
        </div>

        <div className="settings-section">
          <h4>Required Permissions</h4>
          <p className="settings-description">
            Ensure your Azure Bot has these Microsoft Graph permissions:
          </p>
          <ul className="permissions-list">
            <li><code>User.Read</code> - Read user profile</li>
            <li><code>ChannelMessage.Send</code> - Send messages in channels</li>
            <li><code>Chat.ReadWrite</code> - Read and write chats</li>
          </ul>
        </div>
      </div>
    );
  }

  // Channel is configured
  return (
    <div className="teams-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">@{channel.botUsername}</span>}
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
            Generate a one-time code for a user to enter in Teams to gain access.
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
        <h4>How to Use</h4>
        <div className="commands-list">
          <p className="settings-description">
            Direct message the bot or mention it (@BotName) in a Teams channel to start a task.
          </p>
          <div className="command-item"><code>/start</code> - Start the bot and get help</div>
          <div className="command-item"><code>/help</code> - Show available commands</div>
          <div className="command-item"><code>/workspaces</code> - List available workspaces</div>
          <div className="command-item"><code>/workspace</code> - Select or show current workspace</div>
          <div className="command-item"><code>/newtask</code> - Start a fresh task/conversation</div>
          <div className="command-item"><code>/status</code> - Check bot status</div>
          <div className="command-item"><code>/cancel</code> - Cancel current task</div>
          <div className="command-item"><code>/pair</code> - Pair with a pairing code</div>
        </div>
      </div>
    </div>
  );
}
