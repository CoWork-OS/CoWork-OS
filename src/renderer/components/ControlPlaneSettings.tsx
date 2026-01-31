import { useState, useEffect, useCallback } from 'react';
import type {
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  TailscaleAvailability,
  RemoteGatewayStatus,
  ControlPlaneConnectionMode,
  SSHTunnelStatus,
  SSHTunnelConfig,
} from '../../shared/types';

export function ControlPlaneSettings() {
  const [settings, setSettings] = useState<ControlPlaneSettingsData | null>(null);
  const [status, setStatus] = useState<ControlPlaneStatus | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<RemoteGatewayStatus | null>(null);
  const [tailscaleAvailability, setTailscaleAvailability] = useState<TailscaleAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; latencyMs?: number } | null>(null);
  const [connectionMode, setConnectionMode] = useState<ControlPlaneConnectionMode>('local');
  const [showToken, setShowToken] = useState(false);
  const [showRemoteToken, setShowRemoteToken] = useState(false);

  // Remote config form state
  const [remoteUrl, setRemoteUrl] = useState('ws://127.0.0.1:18789');
  const [remoteToken, setRemoteToken] = useState('');
  const [remoteDeviceName, setRemoteDeviceName] = useState('CoWork Remote Client');

  // SSH Tunnel state
  const [sshTunnelStatus, setSshTunnelStatus] = useState<SSHTunnelStatus | null>(null);
  const [sshTunnelEnabled, setSshTunnelEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshUsername, setSshUsername] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshLocalPort, setSshLocalPort] = useState(18789);
  const [sshRemotePort, setSshRemotePort] = useState(18789);
  const [testingSshTunnel, setTestingSshTunnel] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<{ success: boolean; message: string; latencyMs?: number } | null>(null);

  // Helper to build SSH tunnel config
  const getSshTunnelConfig = useCallback((): SSHTunnelConfig => ({
    enabled: sshTunnelEnabled,
    host: sshHost,
    username: sshUsername,
    sshPort: sshPort,
    keyPath: sshKeyPath || undefined,
    localPort: sshLocalPort,
    remotePort: sshRemotePort,
    autoReconnect: true,
    reconnectDelayMs: 5000,
    maxReconnectAttempts: 10,
  }), [sshTunnelEnabled, sshHost, sshUsername, sshPort, sshKeyPath, sshLocalPort, sshRemotePort]);

  const loadData = useCallback(async () => {
    try {
      const [settingsData, statusData, tailscale, remoteStatusData, sshStatus] = await Promise.all([
        window.electronAPI?.getControlPlaneSettings?.() || null,
        window.electronAPI?.getControlPlaneStatus?.() || null,
        window.electronAPI?.checkTailscaleAvailability?.() || null,
        window.electronAPI?.getRemoteGatewayStatus?.() || null,
        window.electronAPI?.getSSHTunnelStatus?.() || null,
      ]);

      setSettings(settingsData);
      setStatus(statusData);
      setTailscaleAvailability(tailscale);
      setRemoteStatus(remoteStatusData);
      setSshTunnelStatus(sshStatus);

      // Set connection mode from settings
      if (settingsData?.connectionMode) {
        setConnectionMode(settingsData.connectionMode);
      }

      // Set remote config from settings
      if (settingsData?.remote) {
        setRemoteUrl(settingsData.remote.url || 'ws://127.0.0.1:18789');
        setRemoteToken(settingsData.remote.token || '');
        setRemoteDeviceName(settingsData.remote.deviceName || 'CoWork Remote Client');

        // Set SSH tunnel config from settings
        const remoteSshTunnel = (settingsData.remote as { sshTunnel?: SSHTunnelConfig }).sshTunnel;
        if (remoteSshTunnel) {
          const tunnel = remoteSshTunnel;
          setSshTunnelEnabled(tunnel.enabled || false);
          setSshHost(tunnel.host || '');
          setSshUsername(tunnel.username || '');
          setSshPort(tunnel.sshPort || 22);
          setSshKeyPath(tunnel.keyPath || '');
          setSshLocalPort(tunnel.localPort || 18789);
          setSshRemotePort(tunnel.remotePort || 18789);
        }
      }
    } catch (error) {
      console.error('Failed to load control plane data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Poll status every 5 seconds
    const interval = setInterval(() => {
      loadData();
    }, 5000);

    return () => clearInterval(interval);
  }, [loadData]);

  const handleToggleEnabled = async () => {
    if (!settings) return;

    setSaving(true);
    try {
      if (settings.enabled) {
        await window.electronAPI?.disableControlPlane?.();
      } else {
        await window.electronAPI?.enableControlPlane?.();
      }
      await loadData();
    } catch (error) {
      console.error('Failed to toggle control plane:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleStartStop = async () => {
    setSaving(true);
    try {
      if (status?.running) {
        await window.electronAPI?.stopControlPlane?.();
      } else {
        await window.electronAPI?.startControlPlane?.();
      }
      await loadData();
    } catch (error) {
      console.error('Failed to start/stop control plane:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateToken = async () => {
    setSaving(true);
    try {
      await window.electronAPI?.regenerateControlPlaneToken?.();
      await loadData();
    } catch (error) {
      console.error('Failed to regenerate token:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleTailscaleModeChange = async (mode: 'off' | 'serve' | 'funnel') => {
    setSaving(true);
    try {
      await window.electronAPI?.setTailscaleMode?.(mode);
      await loadData();
    } catch (error) {
      console.error('Failed to set Tailscale mode:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleConnectionModeChange = async (mode: ControlPlaneConnectionMode) => {
    setConnectionMode(mode);

    if (mode === 'local') {
      // Disconnect from remote if connected
      if (remoteStatus?.state === 'connected') {
        await window.electronAPI?.disconnectRemoteGateway?.();
      }
    }
  };

  const handleSaveRemoteConfig = async () => {
    setSaving(true);
    try {
      await window.electronAPI?.saveRemoteGatewayConfig?.({
        url: remoteUrl,
        token: remoteToken,
        deviceName: remoteDeviceName,
      });
      await loadData();
    } catch (error) {
      console.error('Failed to save remote config:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestRemoteConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI?.testRemoteGatewayConnection?.({
        url: remoteUrl,
        token: remoteToken,
        deviceName: remoteDeviceName,
      });

      if (result?.ok) {
        setTestResult({
          success: true,
          message: `Connection successful`,
          latencyMs: result.latencyMs,
        });
      } else {
        setTestResult({
          success: false,
          message: result?.error || 'Connection failed',
        });
      }
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.message || 'Connection failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleConnectRemote = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI?.connectRemoteGateway?.({
        url: remoteUrl,
        token: remoteToken,
        deviceName: remoteDeviceName,
      });

      if (!result?.ok) {
        setTestResult({
          success: false,
          message: result?.error || 'Connection failed',
        });
      }
      await loadData();
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.message || 'Connection failed',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnectRemote = async () => {
    setSaving(true);
    try {
      await window.electronAPI?.disconnectRemoteGateway?.();
      await loadData();
    } catch (error) {
      console.error('Failed to disconnect:', error);
    } finally {
      setSaving(false);
    }
  };

  // SSH Tunnel Handlers
  const handleTestSshTunnel = async () => {
    setTestingSshTunnel(true);
    setSshTestResult(null);
    try {
      const result = await window.electronAPI?.testSSHTunnelConnection?.(getSshTunnelConfig());
      if (result?.ok) {
        setSshTestResult({
          success: true,
          message: 'SSH connection successful',
          latencyMs: result.latencyMs,
        });
      } else {
        setSshTestResult({
          success: false,
          message: result?.error || 'SSH connection failed',
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'SSH connection failed';
      setSshTestResult({
        success: false,
        message: errorMessage,
      });
    } finally {
      setTestingSshTunnel(false);
    }
  };

  const handleConnectSshTunnel = async () => {
    setSaving(true);
    setSshTestResult(null);
    try {
      const config = getSshTunnelConfig();
      config.enabled = true;

      const result = await window.electronAPI?.connectSSHTunnel?.(config);
      if (!result?.ok) {
        setSshTestResult({
          success: false,
          message: result?.error || 'Failed to create SSH tunnel',
        });
      } else {
        // Update the remote URL to use the local tunnel endpoint
        setRemoteUrl(`ws://127.0.0.1:${sshLocalPort}`);
        setSshTunnelEnabled(true);
      }
      await loadData();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create SSH tunnel';
      setSshTestResult({
        success: false,
        message: errorMessage,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnectSshTunnel = async () => {
    setSaving(true);
    try {
      await window.electronAPI?.disconnectSSHTunnel?.();
      setSshTunnelEnabled(false);
      await loadData();
    } catch (error) {
      console.error('Failed to disconnect SSH tunnel:', error);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return <div className="settings-loading">Loading control plane settings...</div>;
  }

  return (
    <div className="settings-section">
      <h2>Control Plane</h2>
      <p className="settings-description">
        WebSocket gateway for remote management. Connect via SSH tunnel, Tailscale, or direct network.
      </p>

      {/* Connection Mode Selector */}
      <div className="settings-subsection">
        <h3>Connection Mode</h3>
        <div className="connection-mode-selector">
          <label className={`mode-option ${connectionMode === 'local' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="connectionMode"
              value="local"
              checked={connectionMode === 'local'}
              onChange={() => handleConnectionModeChange('local')}
            />
            <div className="mode-content">
              <span className="mode-title">Local Server</span>
              <span className="mode-description">Host the Control Plane on this machine</span>
            </div>
          </label>
          <label className={`mode-option ${connectionMode === 'remote' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="connectionMode"
              value="remote"
              checked={connectionMode === 'remote'}
              onChange={() => handleConnectionModeChange('remote')}
            />
            <div className="mode-content">
              <span className="mode-title">Remote Gateway</span>
              <span className="mode-description">Connect to a Control Plane on another machine</span>
            </div>
          </label>
        </div>
      </div>

      {connectionMode === 'local' ? (
        <>
          {/* Local Server Settings */}
          <div className="settings-subsection">
            <h3>Server Status</h3>
            <div className="settings-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings?.enabled || false}
                  onChange={handleToggleEnabled}
                  disabled={saving}
                />
                Enable Control Plane
              </label>
            </div>

            {settings?.enabled && (
              <>
                <div className="status-card">
                  <div className="status-indicator">
                    <span className={`status-dot ${status?.running ? 'running' : 'stopped'}`} />
                    <span>{status?.running ? 'Running' : 'Stopped'}</span>
                  </div>
                  {status?.running && status.address && (
                    <div className="status-details">
                      <div className="detail-row">
                        <span className="label">Local URL:</span>
                        <code>{status.address.wsUrl}</code>
                        <button
                          className="copy-btn"
                          onClick={() => copyToClipboard(status.address!.wsUrl)}
                          title="Copy"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="detail-row">
                        <span className="label">Clients:</span>
                        <span>{status.clients.authenticated} authenticated, {status.clients.pending} pending</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="button-row">
                  <button
                    onClick={handleStartStop}
                    disabled={saving}
                    className={status?.running ? 'btn-secondary' : 'btn-primary'}
                  >
                    {status?.running ? 'Stop Server' : 'Start Server'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Token Management */}
          {settings?.enabled && (
            <div className="settings-subsection">
              <h3>Authentication Token</h3>
              <div className="token-display">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={settings.token || ''}
                  readOnly
                  className="token-input"
                />
                <button
                  className="btn-icon"
                  onClick={() => setShowToken(!showToken)}
                  title={showToken ? 'Hide' : 'Show'}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
                <button
                  className="btn-icon"
                  onClick={() => copyToClipboard(settings.token || '')}
                  title="Copy"
                >
                  Copy
                </button>
              </div>
              <button
                onClick={handleRegenerateToken}
                disabled={saving}
                className="btn-secondary"
              >
                Regenerate Token
              </button>
              <p className="hint">
                Warning: Regenerating the token will disconnect all existing clients.
              </p>
            </div>
          )}

          {/* Tailscale Integration */}
          {settings?.enabled && (
            <div className="settings-subsection">
              <h3>Remote Access (Tailscale)</h3>
              {!tailscaleAvailability?.installed ? (
                <p className="hint">
                  Tailscale is not installed. Install from{' '}
                  <a href="https://tailscale.com" target="_blank" rel="noopener noreferrer">
                    tailscale.com
                  </a>{' '}
                  for remote access.
                </p>
              ) : (
                <>
                  <div className="settings-row">
                    <label>Exposure Mode:</label>
                    <select
                      value={settings.tailscale?.mode || 'off'}
                      onChange={(e) => handleTailscaleModeChange(e.target.value as any)}
                      disabled={saving}
                    >
                      <option value="off">Off (Local only)</option>
                      <option value="serve">Serve (Tailnet only)</option>
                      <option value="funnel" disabled={!tailscaleAvailability.funnelAvailable}>
                        Funnel (Public Internet)
                        {!tailscaleAvailability.funnelAvailable && ' - Not available'}
                      </option>
                    </select>
                  </div>

                  {status?.tailscale?.active && status.tailscale.wssUrl && (
                    <div className="status-card">
                      <div className="detail-row">
                        <span className="label">Remote URL:</span>
                        <code>{status.tailscale.wssUrl}</code>
                        <button
                          className="copy-btn"
                          onClick={() => copyToClipboard(status.tailscale.wssUrl!)}
                          title="Copy"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* SSH Tunnel Instructions */}
          {settings?.enabled && (
            <div className="settings-subsection">
              <h3>SSH Tunnel (Alternative)</h3>
              <p className="hint">
                Use SSH port forwarding to access the Control Plane remotely:
              </p>
              <div className="code-block">
                <code>ssh -N -L 18789:127.0.0.1:{settings.port || 18789} user@remote-host</code>
                <button
                  className="copy-btn"
                  onClick={() => copyToClipboard(`ssh -N -L 18789:127.0.0.1:${settings.port || 18789} user@remote-host`)}
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Remote Gateway Settings */}
          <div className="settings-subsection">
            <h3>Remote Gateway Configuration</h3>
            <p className="hint">
              Connect to a Control Plane server running on another machine via SSH tunnel or Tailscale.
            </p>

            <div className="settings-row">
              <label>Gateway URL:</label>
              <input
                type="text"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="ws://127.0.0.1:18789"
                className="settings-input"
              />
            </div>

            <div className="settings-row">
              <label>Token:</label>
              <div className="token-display">
                <input
                  type={showRemoteToken ? 'text' : 'password'}
                  value={remoteToken}
                  onChange={(e) => setRemoteToken(e.target.value)}
                  placeholder="Enter authentication token"
                  className="token-input"
                />
                <button
                  className="btn-icon"
                  onClick={() => setShowRemoteToken(!showRemoteToken)}
                  title={showRemoteToken ? 'Hide' : 'Show'}
                >
                  {showRemoteToken ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div className="settings-row">
              <label>Device Name:</label>
              <input
                type="text"
                value={remoteDeviceName}
                onChange={(e) => setRemoteDeviceName(e.target.value)}
                placeholder="CoWork Remote Client"
                className="settings-input"
              />
            </div>

            {testResult && (
              <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                {testResult.success ? (
                  <>Connection successful{testResult.latencyMs && ` (${testResult.latencyMs}ms)`}</>
                ) : (
                  testResult.message
                )}
              </div>
            )}

            <div className="button-row">
              <button
                onClick={handleTestRemoteConnection}
                disabled={testing || !remoteUrl || !remoteToken}
                className="btn-secondary"
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button
                onClick={handleSaveRemoteConfig}
                disabled={saving}
                className="btn-secondary"
              >
                Save Config
              </button>
            </div>
          </div>

          {/* Remote Connection Status */}
          <div className="settings-subsection">
            <h3>Connection Status</h3>
            <div className="status-card">
              <div className="status-indicator">
                <span className={`status-dot ${remoteStatus?.state === 'connected' ? 'running' : remoteStatus?.state === 'connecting' || remoteStatus?.state === 'authenticating' ? 'connecting' : 'stopped'}`} />
                <span className="status-text">
                  {remoteStatus?.state === 'connected' && 'Connected'}
                  {remoteStatus?.state === 'connecting' && 'Connecting...'}
                  {remoteStatus?.state === 'authenticating' && 'Authenticating...'}
                  {remoteStatus?.state === 'reconnecting' && `Reconnecting (attempt ${remoteStatus.reconnectAttempts})...`}
                  {remoteStatus?.state === 'error' && `Error: ${remoteStatus.error}`}
                  {remoteStatus?.state === 'disconnected' && 'Disconnected'}
                </span>
              </div>
              {remoteStatus?.state === 'connected' && (
                <div className="status-details">
                  <div className="detail-row">
                    <span className="label">Client ID:</span>
                    <code>{remoteStatus.clientId}</code>
                  </div>
                  <div className="detail-row">
                    <span className="label">Connected:</span>
                    <span>{remoteStatus.connectedAt ? new Date(remoteStatus.connectedAt).toLocaleTimeString() : 'Unknown'}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="button-row">
              {remoteStatus?.state === 'connected' ? (
                <button
                  onClick={handleDisconnectRemote}
                  disabled={saving}
                  className="btn-secondary"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={handleConnectRemote}
                  disabled={saving || !remoteUrl || !remoteToken}
                  className="btn-primary"
                >
                  {saving ? 'Connecting...' : 'Connect'}
                </button>
              )}
            </div>
          </div>

          {/* SSH Tunnel Configuration */}
          <div className="settings-subsection">
            <h3>SSH Tunnel</h3>
            <p className="hint">
              Automatically create an SSH tunnel to connect to the remote gateway securely.
            </p>

            {/* SSH Tunnel Status */}
            {sshTunnelStatus && sshTunnelStatus.state !== 'disconnected' && (
              <div className="status-card">
                <div className="status-indicator">
                  <span className={`status-dot ${sshTunnelStatus.state === 'connected' ? 'running' : sshTunnelStatus.state === 'connecting' || sshTunnelStatus.state === 'reconnecting' ? 'connecting' : 'stopped'}`} />
                  <span className="status-text">
                    {sshTunnelStatus.state === 'connected' && 'Tunnel Connected'}
                    {sshTunnelStatus.state === 'connecting' && 'Creating Tunnel...'}
                    {sshTunnelStatus.state === 'reconnecting' && `Reconnecting (attempt ${sshTunnelStatus.reconnectAttempts})...`}
                    {sshTunnelStatus.state === 'error' && `Error: ${sshTunnelStatus.error}`}
                  </span>
                </div>
                {sshTunnelStatus.state === 'connected' && sshTunnelStatus.localEndpoint && (
                  <div className="status-details">
                    <div className="detail-row">
                      <span className="label">Local Endpoint:</span>
                      <code>{sshTunnelStatus.localEndpoint}</code>
                    </div>
                    {sshTunnelStatus.pid && (
                      <div className="detail-row">
                        <span className="label">Process ID:</span>
                        <span>{sshTunnelStatus.pid}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="settings-row">
              <label>SSH Host:</label>
              <input
                type="text"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                placeholder="remote-server.com"
                className="settings-input"
                disabled={sshTunnelStatus?.state === 'connected'}
              />
            </div>

            <div className="settings-row-group">
              <div className="settings-row half">
                <label>Username:</label>
                <input
                  type="text"
                  value={sshUsername}
                  onChange={(e) => setSshUsername(e.target.value)}
                  placeholder="username"
                  className="settings-input"
                  disabled={sshTunnelStatus?.state === 'connected'}
                />
              </div>
              <div className="settings-row half">
                <label>SSH Port:</label>
                <input
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                  className="settings-input"
                  disabled={sshTunnelStatus?.state === 'connected'}
                />
              </div>
            </div>

            <div className="settings-row">
              <label>SSH Key Path (optional):</label>
              <input
                type="text"
                value={sshKeyPath}
                onChange={(e) => setSshKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
                className="settings-input"
                disabled={sshTunnelStatus?.state === 'connected'}
              />
            </div>

            <div className="settings-row-group">
              <div className="settings-row half">
                <label>Local Port:</label>
                <input
                  type="number"
                  value={sshLocalPort}
                  onChange={(e) => setSshLocalPort(parseInt(e.target.value) || 18789)}
                  className="settings-input"
                  disabled={sshTunnelStatus?.state === 'connected'}
                />
              </div>
              <div className="settings-row half">
                <label>Remote Port:</label>
                <input
                  type="number"
                  value={sshRemotePort}
                  onChange={(e) => setSshRemotePort(parseInt(e.target.value) || 18789)}
                  className="settings-input"
                  disabled={sshTunnelStatus?.state === 'connected'}
                />
              </div>
            </div>

            {sshTestResult && (
              <div className={`test-result ${sshTestResult.success ? 'success' : 'error'}`}>
                {sshTestResult.success ? (
                  <>SSH connection successful{sshTestResult.latencyMs && ` (${sshTestResult.latencyMs}ms)`}</>
                ) : (
                  sshTestResult.message
                )}
              </div>
            )}

            <div className="button-row">
              {sshTunnelStatus?.state === 'connected' ? (
                <button
                  onClick={handleDisconnectSshTunnel}
                  disabled={saving}
                  className="btn-secondary"
                >
                  Disconnect Tunnel
                </button>
              ) : (
                <>
                  <button
                    onClick={handleTestSshTunnel}
                    disabled={testingSshTunnel || !sshHost || !sshUsername}
                    className="btn-secondary"
                  >
                    {testingSshTunnel ? 'Testing...' : 'Test SSH'}
                  </button>
                  <button
                    onClick={handleConnectSshTunnel}
                    disabled={saving || !sshHost || !sshUsername}
                    className="btn-primary"
                  >
                    {saving ? 'Creating Tunnel...' : 'Create Tunnel'}
                  </button>
                </>
              )}
            </div>

            {sshTunnelStatus?.state !== 'connected' && (
              <p className="hint" style={{ marginTop: '0.75rem' }}>
                <strong>Manual alternative:</strong> Run <code>ssh -N -L {sshLocalPort}:127.0.0.1:{sshRemotePort} {sshUsername || 'user'}@{sshHost || 'remote-host'}</code>
              </p>
            )}
          </div>
        </>
      )}

      <style>{`
        .connection-mode-selector {
          display: flex;
          gap: 1rem;
          margin-bottom: 1rem;
        }

        .mode-option {
          flex: 1;
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
          padding: 1rem;
          border: 1px solid var(--border-color);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .mode-option:hover {
          border-color: var(--accent-color);
        }

        .mode-option.selected {
          border-color: var(--accent-color);
          background: var(--accent-color-light, rgba(var(--accent-rgb), 0.1));
        }

        .mode-option input {
          margin-top: 4px;
        }

        .mode-content {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .mode-title {
          font-weight: 500;
        }

        .mode-description {
          font-size: 0.85rem;
          color: var(--text-secondary);
        }

        .status-card {
          background: var(--bg-secondary);
          border-radius: 8px;
          padding: 1rem;
          margin: 0.5rem 0;
        }

        .status-indicator {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }

        .status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--text-secondary);
        }

        .status-dot.running {
          background: #22c55e;
        }

        .status-dot.stopped {
          background: #6b7280;
        }

        .status-dot.connecting {
          background: #f59e0b;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .status-details {
          margin-top: 0.5rem;
          font-size: 0.9rem;
        }

        .detail-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.25rem;
        }

        .detail-row .label {
          color: var(--text-secondary);
          min-width: 100px;
        }

        .detail-row code {
          background: var(--bg-tertiary);
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
          font-size: 0.85rem;
        }

        .token-display {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }

        .token-input {
          flex: 1;
          font-family: monospace;
        }

        .code-block {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          background: var(--bg-secondary);
          padding: 0.75rem 1rem;
          border-radius: 6px;
          margin: 0.5rem 0;
        }

        .code-block code {
          flex: 1;
          font-size: 0.85rem;
          word-break: break-all;
        }

        .copy-btn {
          padding: 0.25rem 0.5rem;
          font-size: 0.75rem;
          background: var(--bg-tertiary);
          border: none;
          border-radius: 4px;
          cursor: pointer;
          color: var(--text-secondary);
        }

        .copy-btn:hover {
          background: var(--accent-color);
          color: white;
        }

        .button-row {
          display: flex;
          gap: 0.5rem;
          margin-top: 1rem;
        }

        .btn-primary {
          background: var(--accent-color);
          color: white;
          border: none;
          padding: 0.5rem 1rem;
          border-radius: 6px;
          cursor: pointer;
        }

        .btn-primary:hover:not(:disabled) {
          opacity: 0.9;
        }

        .btn-secondary {
          background: var(--bg-secondary);
          color: var(--text-primary);
          border: 1px solid var(--border-color);
          padding: 0.5rem 1rem;
          border-radius: 6px;
          cursor: pointer;
        }

        .btn-secondary:hover:not(:disabled) {
          background: var(--bg-tertiary);
        }

        .btn-icon {
          padding: 0.5rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.75rem;
        }

        .test-result {
          padding: 0.75rem 1rem;
          border-radius: 6px;
          margin: 0.5rem 0;
        }

        .test-result.success {
          background: rgba(34, 197, 94, 0.1);
          color: #22c55e;
          border: 1px solid rgba(34, 197, 94, 0.3);
        }

        .test-result.error {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .hint {
          font-size: 0.85rem;
          color: var(--text-secondary);
          margin: 0.5rem 0;
        }

        .settings-input {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid var(--border-color);
          border-radius: 4px;
          background: var(--bg-primary);
          color: var(--text-primary);
        }

        .settings-input:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .settings-row-group {
          display: flex;
          gap: 1rem;
          margin-bottom: 0.75rem;
        }

        .settings-row.half {
          flex: 1;
        }
      `}</style>
    </div>
  );
}
