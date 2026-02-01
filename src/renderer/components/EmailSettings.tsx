import { useState, useEffect } from 'react';
import { ChannelData, ChannelUserData, SecurityMode } from '../../shared/types';

interface EmailSettingsProps {
  onStatusChange?: (connected: boolean) => void;
}

export function EmailSettings({ onStatusChange }: EmailSettingsProps) {
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [users, setUsers] = useState<ChannelUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Form state
  const [channelName, setChannelName] = useState('Email');
  const [securityMode, setSecurityMode] = useState<SecurityMode>('pairing');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [displayName, setDisplayName] = useState('');
  const [allowedSenders, setAllowedSenders] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');

  // Pairing code state
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  useEffect(() => {
    loadChannel();
  }, []);

  const loadChannel = async () => {
    try {
      setLoading(true);
      const channels = await window.electronAPI.getGatewayChannels();
      const emailChannel = channels.find((c: ChannelData) => c.type === 'email');

      if (emailChannel) {
        setChannel(emailChannel);
        setChannelName(emailChannel.name);
        setSecurityMode(emailChannel.securityMode);
        onStatusChange?.(emailChannel.status === 'connected');

        // Load config settings
        if (emailChannel.config) {
          setEmail(emailChannel.config.email as string || '');
          setPassword(emailChannel.config.password as string || '');
          setImapHost(emailChannel.config.imapHost as string || '');
          setImapPort(emailChannel.config.imapPort as number || 993);
          setSmtpHost(emailChannel.config.smtpHost as string || '');
          setSmtpPort(emailChannel.config.smtpPort as number || 587);
          setDisplayName(emailChannel.config.displayName as string || '');
          const senders = emailChannel.config.allowedSenders as string[] || [];
          setAllowedSenders(senders.join(', '));
          setSubjectFilter(emailChannel.config.subjectFilter as string || '');
        }

        // Load users for this channel
        const channelUsers = await window.electronAPI.getGatewayUsers(emailChannel.id);
        setUsers(channelUsers);
      }
    } catch (error) {
      console.error('Failed to load Email channel:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = async () => {
    if (!email.trim() || !password.trim() || !imapHost.trim() || !smtpHost.trim()) {
      setTestResult({ success: false, error: 'Email, password, IMAP host, and SMTP host are required' });
      return;
    }

    try {
      setSaving(true);
      setTestResult(null);

      const senderList = allowedSenders
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      await window.electronAPI.addGatewayChannel({
        type: 'email',
        name: channelName,
        securityMode,
        emailAddress: email.trim(),
        emailPassword: password.trim(),
        emailImapHost: imapHost.trim(),
        emailImapPort: imapPort,
        emailSmtpHost: smtpHost.trim(),
        emailSmtpPort: smtpPort,
        emailDisplayName: displayName.trim() || undefined,
        emailAllowedSenders: senderList.length > 0 ? senderList : undefined,
        emailSubjectFilter: subjectFilter.trim() || undefined,
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

    if (!confirm('Are you sure you want to remove the Email channel?')) {
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

  // Common email provider presets
  const applyPreset = (provider: string) => {
    switch (provider) {
      case 'gmail':
        setImapHost('imap.gmail.com');
        setImapPort(993);
        setSmtpHost('smtp.gmail.com');
        setSmtpPort(587);
        break;
      case 'outlook':
        setImapHost('outlook.office365.com');
        setImapPort(993);
        setSmtpHost('smtp.office365.com');
        setSmtpPort(587);
        break;
      case 'yahoo':
        setImapHost('imap.mail.yahoo.com');
        setImapPort(993);
        setSmtpHost('smtp.mail.yahoo.com');
        setSmtpPort(465);
        break;
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Email settings...</div>;
  }

  // No channel configured yet
  if (!channel) {
    return (
      <div className="email-settings">
        <div className="settings-section">
          <h3>Connect Email</h3>
          <p className="settings-description">
            Connect via IMAP/SMTP to receive and send emails. Universal fallback for notifications and communication.
          </p>

          <div className="settings-callout info">
            <strong>Quick Setup:</strong>
            <div style={{ margin: '8px 0', display: 'flex', gap: '8px' }}>
              <button className="settings-button small" onClick={() => applyPreset('gmail')}>Gmail</button>
              <button className="settings-button small" onClick={() => applyPreset('outlook')}>Outlook</button>
              <button className="settings-button small" onClick={() => applyPreset('yahoo')}>Yahoo</button>
            </div>
            <p style={{ fontSize: '13px', marginTop: '8px' }}>
              Note: For Gmail/Outlook, you may need to use an App Password instead of your regular password.
            </p>
          </div>

          <div className="settings-field">
            <label>Channel Name</label>
            <input
              type="text"
              className="settings-input"
              placeholder="My Email Bot"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Email Address *</label>
            <input
              type="email"
              className="settings-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <label>Password *</label>
            <input
              type="password"
              className="settings-input"
              placeholder="Your password or app password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="settings-hint">
              For Gmail/Outlook, use an App Password (2FA must be enabled)
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="settings-field">
              <label>IMAP Host *</label>
              <input
                type="text"
                className="settings-input"
                placeholder="imap.example.com"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label>IMAP Port</label>
              <input
                type="number"
                className="settings-input"
                placeholder="993"
                value={imapPort}
                onChange={(e) => setImapPort(parseInt(e.target.value) || 993)}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="settings-field">
              <label>SMTP Host *</label>
              <input
                type="text"
                className="settings-input"
                placeholder="smtp.example.com"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
            </div>

            <div className="settings-field">
              <label>SMTP Port</label>
              <input
                type="number"
                className="settings-input"
                placeholder="587"
                value={smtpPort}
                onChange={(e) => setSmtpPort(parseInt(e.target.value) || 587)}
              />
            </div>
          </div>

          <div className="settings-field">
            <label>Display Name (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="CoWork Bot"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="settings-hint">
              Name shown in outgoing emails
            </p>
          </div>

          <div className="settings-field">
            <label>Allowed Senders (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="user@example.com, other@example.com"
              value={allowedSenders}
              onChange={(e) => setAllowedSenders(e.target.value)}
            />
            <p className="settings-hint">
              Comma-separated email addresses to accept messages from (leave empty for all)
            </p>
          </div>

          <div className="settings-field">
            <label>Subject Filter (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="[CoWork]"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
            />
            <p className="settings-hint">
              Only process emails containing this text in the subject
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
          </div>

          {testResult && (
            <div className={`settings-callout ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? 'Connection successful!' : testResult.error}
            </div>
          )}

          <button
            className="settings-button primary"
            onClick={handleAddChannel}
            disabled={saving || !email.trim() || !password.trim() || !imapHost.trim() || !smtpHost.trim()}
          >
            {saving ? 'Connecting...' : 'Connect Email'}
          </button>
        </div>

        <div className="settings-section">
          <h4>Email Features</h4>
          <ul style={{ margin: '8px 0', paddingLeft: '20px', fontSize: '13px' }}>
            <li>Receive emails via IMAP (polling)</li>
            <li>Send emails via SMTP</li>
            <li>Reply threading support</li>
            <li>Filter by sender or subject</li>
            <li>Universal - works with any email provider</li>
          </ul>
        </div>
      </div>
    );
  }

  // Channel exists - show management UI
  return (
    <div className="email-settings">
      <div className="settings-section">
        <h3>Email</h3>
        <p className="settings-description">
          Manage your email connection and access settings.
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
          {Boolean(channel.config?.email) && (
            <div className="status-row">
              <span className="status-label">Email:</span>
              <span className="status-value">{String(channel.config?.email)}</span>
            </div>
          )}
          <div className="status-row">
            <span className="status-label">IMAP:</span>
            <span className="status-value">{String(channel.config?.imapHost || 'N/A')}</span>
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
