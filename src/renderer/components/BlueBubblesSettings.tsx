import { useState, useEffect, useCallback } from 'react';
import { ChannelData, ChannelUserData, SecurityMode, ContextType, ContextPolicy } from '../../shared/types';
import { PairingCodeDisplay } from './PairingCodeDisplay';
import { ContextPolicySettings } from './ContextPolicySettings';

interface BlueBubblesSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function BlueBubblesSettings({ onStatusChange }: BlueBubblesSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; botUsername?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState('BlueBubbles');
  const [securityMode, setSecurityMode] = useState<SecurityMode>('pairing');
  const [serverUrl, setServerUrl] = useState('');
  const [password, setPassword] = useState('');
  const [webhookPort, setWebhookPort] = useState(3101);
  const [allowedContacts, setAllowedContacts] = useState('');
  const [ambientMode, setAmbientMode] = useState(false);
  const [captureSelfMessages, setCaptureSelfMessages] = useState(false);
  const [silentUnauthorized, setSilentUnauthorized] = useState(false);

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number>(0);
  const [generatingCode, setGeneratingCode] = useState(false);

  // Context policy state
  const [contextPolicies, setContextPolicies] = useState<Record<ContextType, ContextPolicy>>({} as Record<ContextType, ContextPolicy>);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadChannel = useCallback(async () => {
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
          setAmbientMode(Boolean(bbChannel.config.ambientMode));
          setCaptureSelfMessages(Boolean(bbChannel.config.captureSelfMessages));
          setSilentUnauthorized(Boolean(bbChannel.config.silentUnauthorized));
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(bbChannel.id);
        setUsers(channelUsers);

        // Load context policies
        const policies = await window.electronAPI.listContextPolicies(bbChannel.id);
        const policyMap: Record<ContextType, ContextPolicy> = {} as Record<ContextType, ContextPolicy>;
        for (const policy of policies) {
          policyMap[policy.contextType as ContextType] = policy;
        }
        setContextPolicies(policyMap);
      }
    } catch (error) {
      console.error('Failed to load BlueBubbles channel:', error);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGatewayUsersUpdated?.((data) => {
      if (data?.channelType !== 'bluebubbles') return;
      if (channel && data?.channelId && data.channelId !== channel.id) return;
      loadChannel();
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [channel?.id, loadChannel]);

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
        ambientMode,
        silentUnauthorized,
        captureSelfMessages,
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

  const handleUpdateConfig = async (updates: Record<string, unknown>) => {
    if (!channel) return;
    try {
      setSaving(true);
      await window.electronAPI.updateGatewayChannel({
        id: channel.id,
        config: {
          ...(channel.config || {}),
          ...updates,
        },
      });
      await loadChannel();
    } catch (error: any) {
      console.error('Failed to update BlueBubbles config:', error);
      setTestResult({ success: false, error: error.message });
    } finally {
      setSaving(false);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!channel) return;

    try {
      setGeneratingCode(true);
      const code = await window.electronAPI.generateGatewayPairing(channel.id, '');
      setPairingCode(code);
      // Default TTL is 5 minutes (300 seconds)
      setPairingExpiresAt(Date.now() + 5 * 60 * 1000);
    } catch (error: any) {
      console.error('Failed to generate pairing code:', error);
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
      setContextPolicies(prev => ({
        ...prev,
        [contextType]: updated,
      }));
    } catch (error: any) {
      console.error('Failed to update context policy:', error);
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
            <label>Server URL</label>
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
            <label>Server Password</label>
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
            <label>Allowed Contacts (Optional)</label>
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
            <label className="settings-checkbox-label">
              <input
                type="checkbox"
                checked={ambientMode}
                onChange={(e) => setAmbientMode(e.target.checked)}
              />
              <span>Ambient Mode (Log-Only)</span>
            </label>
            <p className="settings-hint">
              When enabled, messages are ingested into the local log but only commands (messages starting with "/") are processed.
            </p>
          </div>

          <div className="settings-field">
            <label className="settings-checkbox-label">
              <input
                type="checkbox"
                checked={captureSelfMessages}
                onChange={(e) => setCaptureSelfMessages(e.target.checked)}
              />
              <span>Capture Self Messages</span>
            </label>
            <p className="settings-hint">
              Ingest messages sent by your iMessage account into the log (as outgoing_user) for better follow-up extraction.
            </p>
          </div>

          <div className="settings-field">
            <label className="settings-checkbox-label">
              <input
                type="checkbox"
                checked={silentUnauthorized}
                onChange={(e) => setSilentUnauthorized(e.target.checked)}
              />
              <span>Silent Unauthorized</span>
            </label>
            <p className="settings-hint">
              Do not send "pairing required" or "unauthorized" replies (useful for ambient ingestion).
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
              {securityMode === 'allowlist' && 'Only pre-approved contacts can use the bot'}
              {securityMode === 'open' && 'Anyone who messages the bot can use it (not recommended)'}
            </p>
          </div>

          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? (
                <>✓ Connected to {testResult.botUsername}</>
              ) : (
                <>✗ {testResult.error}</>
              )}
            </div>
          )}

          <button
            className="button-primary"
            onClick={handleAddChannel}
            disabled={saving || !serverUrl.trim() || !password.trim()}
          >
            {saving ? 'Adding...' : 'Add BlueBubbles'}
          </button>
        </div>

        <div className="settings-section">
          <h4>Prerequisites</h4>
          <ol className="setup-instructions">
            <li>Download and install <a href="https://bluebubbles.app/" target="_blank" rel="noopener noreferrer">BlueBubbles Server</a> on a Mac with iMessage</li>
            <li>Configure the server and note the URL and password</li>
            <li>Ensure the BlueBubbles server is accessible from this machine</li>
          </ol>
        </div>

        <div className="settings-section">
          <h4>BlueBubbles Features</h4>
          <ul className="setup-instructions">
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

  // Channel is configured
  return (
    <div className="bluebubbles-settings">
      <div className="settings-section">
        <div className="channel-header">
          <div className="channel-info">
            <h3>
              {channel.name}
              {channel.botUsername && <span className="bot-username">{channel.botUsername}</span>}
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

      <div className="settings-section">
        <h4>Ambient Inbox</h4>
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={ambientMode}
              onChange={async (e) => {
                const checked = e.target.checked;
                setAmbientMode(checked);
                await handleUpdateConfig({ ambientMode: checked });
              }}
              disabled={saving}
            />
            <span>Ambient Mode (Log-Only)</span>
          </label>
          <p className="settings-hint">
            When enabled, messages are ingested into the local log but only commands (messages starting with "/") are processed.
          </p>
        </div>

        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={captureSelfMessages}
              onChange={async (e) => {
                const checked = e.target.checked;
                setCaptureSelfMessages(checked);
                await handleUpdateConfig({ captureSelfMessages: checked });
              }}
              disabled={saving}
            />
            <span>Capture Self Messages</span>
          </label>
          <p className="settings-hint">
            Ingest messages sent by your iMessage account into the log (as outgoing_user) for better follow-up extraction.
          </p>
        </div>

        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={silentUnauthorized}
              onChange={async (e) => {
                const checked = e.target.checked;
                setSilentUnauthorized(checked);
                await handleUpdateConfig({ silentUnauthorized: checked });
              }}
              disabled={saving}
            />
            <span>Silent Unauthorized</span>
          </label>
          <p className="settings-hint">
            Do not send "pairing required" or "unauthorized" replies (useful for ambient ingestion).
          </p>
        </div>
      </div>

      {securityMode === 'pairing' && (
        <div className="settings-section">
          <h4>Generate Pairing Code</h4>
          <p className="settings-description">
            Generate a one-time code for a user to enter in iMessage to gain access.
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
              {generatingCode ? 'Generating...' : 'Generate Code'}
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
          channelType="bluebubbles"
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
