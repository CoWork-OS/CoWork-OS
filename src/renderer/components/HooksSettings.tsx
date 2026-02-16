import { useState, useEffect } from 'react';
import type {
  HooksSettingsData,
  HooksStatus,
  GmailHooksSettingsData,
  ResendHooksSettingsData,
} from '../../shared/types';

export function HooksSettings() {
  const [settings, setSettings] = useState<HooksSettingsData | null>(null);
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [gmailStatus, setGmailStatus] = useState<{
    configured: boolean;
    running: boolean;
    account?: string;
    topic?: string;
    gogAvailable: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Gmail configuration state
  const [gmailAccount, setGmailAccount] = useState('');
  const [gmailTopic, setGmailTopic] = useState('');
  const [resendWebhookSecret, setResendWebhookSecret] = useState('');
  const [resendAllowUnsafe, setResendAllowUnsafe] = useState(false);

  useEffect(() => {
    loadSettings();
    loadStatus();
    loadGmailStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await window.electronAPI.getHooksSettings();
      setSettings(data);
      if (data.gmail) {
        setGmailAccount(data.gmail.account || '');
        setGmailTopic(data.gmail.topic || '');
      }
      if (data.resend) {
        setResendWebhookSecret(data.resend.webhookSecret || '');
        setResendAllowUnsafe(Boolean(data.resend.allowUnsafeExternalContent));
      }
    } catch (err) {
      console.error('Failed to load hooks settings:', err);
      setError('Failed to load hooks settings');
    } finally {
      setLoading(false);
    }
  };

  const loadStatus = async () => {
    try {
      const data = await window.electronAPI.getHooksStatus();
      setStatus(data);
    } catch (err) {
      console.error('Failed to load hooks status:', err);
    }
  };

  const loadGmailStatus = async () => {
    try {
      const data = await window.electronAPI.getGmailHooksStatus();
      setGmailStatus(data);
    } catch (err) {
      console.error('Failed to load Gmail status:', err);
    }
  };

  const handleEnableHooks = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.enableHooks();
      if (result.gmailWatcherError) {
        setSuccess(`Webhooks enabled, but Gmail watcher failed: ${result.gmailWatcherError}`);
      } else {
        setSuccess('Webhooks enabled successfully');
      }
      await loadSettings();
      await loadStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to enable webhooks');
    } finally {
      setSaving(false);
    }
  };

  const handleDisableHooks = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.disableHooks();
      setSuccess('Webhooks disabled');
      await loadSettings();
      await loadStatus();
      await loadGmailStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to disable webhooks');
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!confirm('This will invalidate all existing webhook clients. Continue?')) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.regenerateHookToken();
      // Show the new token in an alert so user can copy it (it won't be visible after refresh)
      alert(`New token generated:\n\n${result.token}\n\nCopy this token now - it won't be shown again.`);
      setSuccess('Token regenerated successfully.');
      await loadSettings();
    } catch (err: any) {
      setError(err.message || 'Failed to regenerate token');
    } finally {
      setSaving(false);
    }
  };

  const handleConfigureGmail = async () => {
    if (!gmailAccount.trim()) {
      setError('Gmail account is required');
      return;
    }
    if (!gmailTopic.trim()) {
      setError('Pub/Sub topic is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const config: GmailHooksSettingsData = {
        account: gmailAccount.trim(),
        topic: gmailTopic.trim(),
      };
      await window.electronAPI.configureGmailHooks(config);
      setSuccess('Gmail hooks configured');
      await loadSettings();
      await loadGmailStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to configure Gmail hooks');
    } finally {
      setSaving(false);
    }
  };

  const handleConfigureResend = async () => {
    if (!settings?.enabled) {
      setError('Enable webhooks first');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const resendConfig: ResendHooksSettingsData = {
        allowUnsafeExternalContent: resendAllowUnsafe,
      };

      const secret = resendWebhookSecret.trim();
      if (secret !== '***configured***') {
        resendConfig.webhookSecret = secret;
      }

      const presetSet = new Set(settings.presets || []);
      presetSet.add('resend');

      await window.electronAPI.saveHooksSettings({
        presets: Array.from(presetSet),
        resend: resendConfig,
      });

      setSuccess('Resend inbound webhook preset configured');
      await loadSettings();
      await loadStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to configure Resend webhook preset');
    } finally {
      setSaving(false);
    }
  };

  const handleStartGmailWatcher = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await window.electronAPI.startGmailWatcher();
      if (result.ok) {
        setSuccess('Gmail watcher started');
      } else {
        setError(result.error || 'Failed to start Gmail watcher');
      }
      await loadGmailStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to start Gmail watcher');
    } finally {
      setSaving(false);
    }
  };

  const handleStopGmailWatcher = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.stopGmailWatcher();
      setSuccess('Gmail watcher stopped');
      await loadGmailStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to stop Gmail watcher');
    } finally {
      setSaving(false);
    }
  };

  // Clear success/error messages after delay
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  if (loading) {
    return <div className="settings-loading">Loading hooks settings...</div>;
  }

  const isEnabled = settings?.enabled && status?.serverRunning;

  return (
    <div className="settings-subsection">
      {/* Status Messages */}
      {success && (
        <div className="settings-message success">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          {success}
        </div>
      )}
      {error && (
        <div className="settings-message error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {/* Webhooks Section */}
      <div className="settings-section">
        <h3>Webhooks</h3>
        <p className="settings-description">
          Enable webhook endpoints to trigger tasks from external services. The webhook server
          listens for HTTP requests and can create tasks based on incoming data.
        </p>

        {/* Status Indicator */}
        <div className="hooks-status">
          <div className="status-indicator">
            <span className={`status-dot ${isEnabled ? 'connected' : 'disconnected'}`} />
            <span>{isEnabled ? 'Server Running' : 'Server Stopped'}</span>
          </div>
          {status?.serverAddress && (
            <span className="status-address">
              http://{status.serverAddress.host}:{status.serverAddress.port}
            </span>
          )}
        </div>

        {/* Enable/Disable Button */}
        <div className="settings-row">
          <button
            className={`settings-button ${isEnabled ? 'danger' : 'primary'}`}
            onClick={isEnabled ? handleDisableHooks : handleEnableHooks}
            disabled={saving}
          >
            {saving ? 'Processing...' : isEnabled ? 'Disable Webhooks' : 'Enable Webhooks'}
          </button>
        </div>

        {/* Token Configuration */}
        {settings?.enabled && (
          <div className="hooks-token-section">
            <div className="settings-row">
              <label>Authentication Token</label>
              <div className="token-display">
                <code>{settings.token || '(not configured)'}</code>
                <button
                  className="settings-button small"
                  onClick={handleRegenerateToken}
                  disabled={saving}
                >
                  Regenerate
                </button>
              </div>
            </div>
            <p className="settings-hint">
              Include this token in webhook requests via <code>Authorization: Bearer &lt;token&gt;</code> header
              or <code>X-CoWork-Token</code> header.
            </p>
          </div>
        )}
      </div>

      {/* Webhook Endpoints */}
      {settings?.enabled && (
        <div className="settings-section">
          <h3>Available Endpoints</h3>
          <div className="endpoints-list">
            <div className="endpoint-item">
              <code>POST /hooks/wake</code>
              <span className="endpoint-desc">Enqueue a system event</span>
            </div>
            <div className="endpoint-item">
              <code>POST /hooks/agent</code>
              <span className="endpoint-desc">Run an isolated agent task</span>
            </div>
            {settings.presets.includes('gmail') && (
              <div className="endpoint-item">
                <code>POST /hooks/gmail</code>
                <span className="endpoint-desc">Gmail Pub/Sub notifications (preset)</span>
              </div>
            )}
            {settings.presets.includes('resend') && (
              <div className="endpoint-item">
                <code>POST /hooks/resend</code>
                <span className="endpoint-desc">Inbound email events via Resend webhook preset</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gmail Pub/Sub Section */}
      <div className="settings-section">
        <h3>Gmail Pub/Sub</h3>
        <p className="settings-description">
          Receive notifications when emails arrive in your Gmail inbox. Requires{' '}
          <a href="https://gogcli.sh/" target="_blank" rel="noopener noreferrer">
            gog (gogcli)
          </a>{' '}
          to be installed and configured.
        </p>

        {/* gog availability status */}
        <div className="hooks-status">
          <div className="status-indicator">
            <span className={`status-dot ${gmailStatus?.gogAvailable ? 'connected' : 'error'}`} />
            <span>
              {gmailStatus?.gogAvailable
                ? 'gog CLI available'
                : 'gog CLI not found (install from gogcli.sh)'}
            </span>
          </div>
        </div>

        {/* Gmail Watcher Status */}
        {gmailStatus?.running && (
          <div className="hooks-status">
            <div className="status-indicator">
              <span className="status-dot connected" />
              <span>Gmail watcher running for {gmailStatus.account}</span>
            </div>
          </div>
        )}

        {/* Gmail Configuration */}
        <div className="settings-row">
          <label>Gmail Account</label>
          <input
            type="email"
            value={gmailAccount}
            onChange={(e) => setGmailAccount(e.target.value)}
            placeholder="your-email@gmail.com"
            disabled={saving || !settings?.enabled}
          />
        </div>

        <div className="settings-row">
          <label>Pub/Sub Topic</label>
          <input
            type="text"
            value={gmailTopic}
            onChange={(e) => setGmailTopic(e.target.value)}
            placeholder="projects/your-project/topics/gmail-watch"
            disabled={saving || !settings?.enabled}
          />
          <p className="settings-hint">
            Full topic path from your GCP project.
          </p>
        </div>

        {/* Gmail Actions */}
        <div className="settings-row button-row">
          <button
            className="settings-button"
            onClick={handleConfigureGmail}
            disabled={saving || !settings?.enabled || !gmailAccount.trim() || !gmailTopic.trim()}
          >
            {saving ? 'Saving...' : 'Save Gmail Configuration'}
          </button>

          {gmailStatus?.configured && (
            <>
              {gmailStatus.running ? (
                <button
                  className="settings-button danger"
                  onClick={handleStopGmailWatcher}
                  disabled={saving}
                >
                  Stop Watcher
                </button>
              ) : (
                <button
                  className="settings-button primary"
                  onClick={handleStartGmailWatcher}
                  disabled={saving || !settings?.enabled || !gmailStatus.gogAvailable}
                >
                  Start Watcher
                </button>
              )}
            </>
          )}
        </div>

        {!settings?.enabled && (
          <p className="settings-hint warning">
            Enable webhooks first to configure Gmail Pub/Sub.
          </p>
        )}
      </div>

      {/* Resend Inbound Section */}
      <div className="settings-section">
        <h3>Resend Inbound Webhook</h3>
        <p className="settings-description">
          Configure a preset mapping for inbound email webhooks. Use this endpoint when creating a webhook:
        </p>
        <div className="hooks-status">
          <div className="status-indicator">
            <span className={`status-dot ${settings?.presets.includes('resend') ? 'connected' : 'disconnected'}`} />
            <span>{settings?.presets.includes('resend') ? 'Preset enabled' : 'Preset not enabled'}</span>
          </div>
          <span className="status-address">
            POST /hooks/resend
          </span>
        </div>

        <p className="settings-hint">
          For provider setup, append your hooks token in the URL query:
          <br />
          <code>
            https://YOUR_HOST/hooks/resend?token=YOUR_TOKEN
          </code>
        </p>

        <div className="settings-row">
          <label>Webhook Signing Secret (optional)</label>
          <input
            type="password"
            value={resendWebhookSecret}
            onChange={(e) => setResendWebhookSecret(e.target.value)}
            placeholder="whsec_..."
            disabled={saving || !settings?.enabled}
          />
          <p className="settings-hint">
            If provided, CoWork verifies Svix signature headers before processing webhook events.
          </p>
        </div>

        <div className="settings-row">
          <label className="registry-verified-checkbox">
            <input
              type="checkbox"
              checked={resendAllowUnsafe}
              onChange={(e) => setResendAllowUnsafe(e.target.checked)}
              disabled={saving || !settings?.enabled}
            />
            Allow unsafe external content in mapped tasks
          </label>
        </div>

        <div className="settings-row button-row">
          <button
            className="settings-button"
            onClick={handleConfigureResend}
            disabled={saving || !settings?.enabled}
          >
            {saving ? 'Saving...' : 'Save Resend Configuration'}
          </button>
        </div>

        {!settings?.enabled && (
          <p className="settings-hint warning">
            Enable webhooks first to configure the Resend preset.
          </p>
        )}
      </div>

      {/* Usage Examples */}
      <div className="settings-section">
        <h3>Usage Examples</h3>
        <div className="code-example">
          <p className="example-title">Trigger an agent task:</p>
          <pre>
{`curl -X POST http://127.0.0.1:${settings?.port || 9877}/hooks/agent \\
  -H 'Authorization: Bearer YOUR_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"message": "Summarize my inbox", "name": "Email"}'`}
          </pre>
        </div>

        <div className="code-example">
          <p className="example-title">Wake the agent:</p>
          <pre>
{`curl -X POST http://127.0.0.1:${settings?.port || 9877}/hooks/wake \\
  -H 'X-CoWork-Token: YOUR_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"text": "New event received", "mode": "now"}'`}
          </pre>
        </div>

        <div className="code-example">
          <p className="example-title">Inbound email webhook (Resend preset):</p>
          <pre>
{`curl -X POST "http://127.0.0.1:${settings?.port || 9877}/hooks/resend?token=YOUR_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"email.received","data":{"from":"sender@example.com","to":"inbox@example.com","subject":"Hello","email_id":"abc123","text":"Hi there"}}'`}
          </pre>
        </div>
      </div>

      <style>{`
        .hooks-status {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 16px;
          padding: 8px 12px;
          background: var(--color-bg-secondary);
          border-radius: 6px;
        }

        .status-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-dot.connected {
          background: #10b981;
        }

        .status-dot.disconnected {
          background: #6b7280;
        }

        .status-dot.error {
          background: #ef4444;
        }

        .status-address {
          font-family: monospace;
          font-size: 12px;
          color: var(--color-text-secondary);
        }

        .hooks-token-section {
          margin-top: 16px;
          padding: 12px;
          background: var(--color-bg-secondary);
          border-radius: 6px;
        }

        .token-display {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .token-display code {
          flex: 1;
          padding: 6px 10px;
          background: var(--color-bg-primary);
          border-radius: 4px;
          font-size: 12px;
          word-break: break-all;
        }

        .endpoints-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .endpoint-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          background: var(--color-bg-secondary);
          border-radius: 6px;
        }

        .endpoint-item code {
          font-family: monospace;
          font-size: 13px;
          color: var(--color-accent);
        }

        .endpoint-desc {
          font-size: 13px;
          color: var(--color-text-secondary);
        }

        .button-row {
          display: flex;
          gap: 12px;
        }

        .settings-button.small {
          padding: 4px 12px;
          font-size: 12px;
        }

        .settings-button.danger {
          background: #ef4444;
          color: white;
        }

        .settings-button.danger:hover {
          background: #dc2626;
        }

        .settings-hint.warning {
          color: #f59e0b;
        }

        .code-example {
          margin-bottom: 16px;
          padding: 12px;
          background: var(--color-bg-secondary);
          border-radius: 6px;
        }

        .example-title {
          margin-bottom: 8px;
          font-size: 13px;
          color: var(--color-text-secondary);
        }

        .code-example pre {
          margin: 0;
          padding: 10px;
          background: var(--color-bg-primary);
          border-radius: 4px;
          font-size: 12px;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-all;
        }

        .settings-message {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          margin-bottom: 16px;
          border-radius: 6px;
          font-size: 13px;
        }

        .settings-message.success {
          background: rgba(16, 185, 129, 0.1);
          color: #10b981;
        }

        .settings-message.error {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
        }
      `}</style>
    </div>
  );
}
