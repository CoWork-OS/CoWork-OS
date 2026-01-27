import { useState, useEffect } from 'react';
import { MCPRegistryBrowser } from './MCPRegistryBrowser';

// Types (matching preload types)
type MCPTransportType = 'stdio' | 'sse' | 'websocket';
type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: MCPTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  connectionTimeout?: number;
  requestTimeout?: number;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface MCPServerStatus {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: MCPTool[];
  lastPing?: number;
}

interface MCPSettings {
  servers: MCPServerConfig[];
  autoConnect: boolean;
  toolNamePrefix: string;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  registryEnabled: boolean;
  registryUrl?: string;
  hostEnabled: boolean;
  hostPort?: number;
}

interface MCPUpdateInfo {
  serverId: string;
  currentVersion: string;
  latestVersion: string;
}

export function MCPSettings() {
  const [settings, setSettings] = useState<MCPSettings | null>(null);
  const [serverStatuses, setServerStatuses] = useState<MCPServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeView, setActiveView] = useState<'servers' | 'registry' | 'settings'>('servers');

  // Add server form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [newServerCommand, setNewServerCommand] = useState('');
  const [newServerArgs, setNewServerArgs] = useState('');
  const [newServerEnv, setNewServerEnv] = useState('');

  // Tools modal state
  const [viewingToolsFor, setViewingToolsFor] = useState<string | null>(null);
  const [serverTools, setServerTools] = useState<MCPTool[]>([]);

  // Test result
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ serverId: string; success: boolean; error?: string; tools?: number } | null>(null);

  // Connecting/disconnecting state
  const [connectingServer, setConnectingServer] = useState<string | null>(null);

  // Update state
  const [availableUpdates, setAvailableUpdates] = useState<MCPUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingServer, setUpdatingServer] = useState<string | null>(null);

  useEffect(() => {
    loadData();

    // Subscribe to status changes
    const unsubscribe = window.electronAPI.onMCPStatusChange((statuses) => {
      setServerStatuses(statuses);
    });

    return () => unsubscribe();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [loadedSettings, statuses] = await Promise.all([
        window.electronAPI.getMCPSettings(),
        window.electronAPI.getMCPStatus(),
      ]);
      setSettings(loadedSettings);
      setServerStatuses(statuses);
    } catch (error) {
      console.error('Failed to load MCP settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddServer = async () => {
    if (!newServerName || !newServerCommand) return;

    try {
      setSaving(true);
      const args = newServerArgs ? newServerArgs.split(' ').filter(a => a.trim()) : [];
      const env: Record<string, string> = {};

      if (newServerEnv) {
        newServerEnv.split('\n').forEach(line => {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            env[key.trim()] = valueParts.join('=').trim();
          }
        });
      }

      await window.electronAPI.addMCPServer({
        name: newServerName,
        transport: 'stdio' as MCPTransportType,
        command: newServerCommand,
        args: args.length > 0 ? args : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        enabled: true,
      });

      // Reset form
      setNewServerName('');
      setNewServerCommand('');
      setNewServerArgs('');
      setNewServerEnv('');
      setShowAddForm(false);

      // Reload data
      await loadData();
    } catch (error: any) {
      console.error('Failed to add server:', error);
      alert(`Failed to add server: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    if (!confirm('Are you sure you want to remove this server?')) return;

    try {
      await window.electronAPI.removeMCPServer(serverId);
      await loadData();
    } catch (error: any) {
      console.error('Failed to remove server:', error);
      alert(`Failed to remove server: ${error.message}`);
    }
  };

  const handleConnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      await window.electronAPI.connectMCPServer(serverId);
    } catch (error: any) {
      console.error('Failed to connect server:', error);
      alert(`Failed to connect: ${error.message}`);
    } finally {
      setConnectingServer(null);
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      await window.electronAPI.disconnectMCPServer(serverId);
    } catch (error: any) {
      console.error('Failed to disconnect server:', error);
      alert(`Failed to disconnect: ${error.message}`);
    } finally {
      setConnectingServer(null);
    }
  };

  const handleTestServer = async (serverId: string) => {
    try {
      setTestingServer(serverId);
      setTestResult(null);
      const result = await window.electronAPI.testMCPServer(serverId);
      setTestResult({ serverId, ...result });
    } catch (error: any) {
      setTestResult({ serverId, success: false, error: error.message });
    } finally {
      setTestingServer(null);
    }
  };

  const handleViewTools = async (serverId: string) => {
    try {
      const tools = await window.electronAPI.getMCPServerTools(serverId);
      setServerTools(tools);
      setViewingToolsFor(serverId);
    } catch (error) {
      console.error('Failed to get server tools:', error);
    }
  };

  const handleToggleEnabled = async (serverId: string, enabled: boolean) => {
    try {
      await window.electronAPI.updateMCPServer(serverId, { enabled });
      await loadData();
    } catch (error: any) {
      console.error('Failed to update server:', error);
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      await window.electronAPI.saveMCPSettings(settings);
    } catch (error: any) {
      console.error('Failed to save settings:', error);
      alert(`Failed to save settings: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCheckUpdates = async () => {
    try {
      setCheckingUpdates(true);
      const updates = await window.electronAPI.checkMCPUpdates();
      setAvailableUpdates(updates);
      if (updates.length === 0) {
        alert('All MCP servers are up to date!');
      }
    } catch (error: any) {
      console.error('Failed to check for updates:', error);
      alert(`Failed to check for updates: ${error.message}`);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleUpdateServer = async (serverId: string) => {
    try {
      setUpdatingServer(serverId);
      await window.electronAPI.updateMCPServerFromRegistry(serverId);
      // Remove from available updates
      setAvailableUpdates(prev => prev.filter(u => u.serverId !== serverId));
      // Reload data
      await loadData();
      alert('Server updated successfully!');
    } catch (error: any) {
      console.error('Failed to update server:', error);
      alert(`Failed to update server: ${error.message}`);
    } finally {
      setUpdatingServer(null);
    }
  };

  const getUpdateInfo = (serverId: string): MCPUpdateInfo | undefined => {
    return availableUpdates.find(u => u.serverId === serverId);
  };

  const getStatusColor = (status: MCPConnectionStatus): string => {
    switch (status) {
      case 'connected': return 'var(--color-success)';
      case 'connecting':
      case 'reconnecting': return 'var(--color-warning)';
      case 'error': return 'var(--color-error)';
      default: return 'var(--color-text-tertiary)';
    }
  };

  const getStatusText = (status: MCPConnectionStatus): string => {
    switch (status) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'reconnecting': return 'Reconnecting...';
      case 'error': return 'Error';
      default: return 'Disconnected';
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading MCP settings...</div>;
  }

  return (
    <div className="mcp-settings">
      {/* Sub-navigation */}
      <div className="mcp-settings-nav">
        <button
          className={`mcp-nav-button ${activeView === 'servers' ? 'active' : ''}`}
          onClick={() => setActiveView('servers')}
        >
          Installed
        </button>
        <button
          className={`mcp-nav-button ${activeView === 'registry' ? 'active' : ''}`}
          onClick={() => setActiveView('registry')}
        >
          Browse Registry
        </button>
        <button
          className={`mcp-nav-button ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveView('settings')}
        >
          Settings
        </button>
      </div>

      {activeView === 'servers' && (
        <>
          <div className="settings-section">
            <div className="settings-section-header">
              <h3>MCP Servers</h3>
              <div className="mcp-header-actions">
                <button
                  className="button-small button-secondary"
                  onClick={handleCheckUpdates}
                  disabled={checkingUpdates}
                >
                  {checkingUpdates ? 'Checking...' : 'Check for Updates'}
                </button>
                <button
                  className="button-small button-primary"
                  onClick={() => setShowAddForm(!showAddForm)}
                >
                  {showAddForm ? 'Cancel' : '+ Add Server'}
                </button>
              </div>
            </div>
            <p className="settings-description">
              Connect to MCP servers to extend CoWork with additional tools.
              Tools from connected servers will be available to the AI agent.
            </p>

            {showAddForm && (
              <div className="mcp-add-form">
                <h4>Add New MCP Server</h4>
                <div className="settings-field">
                  <label>Server Name</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="e.g., Filesystem Server"
                    value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Command</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="e.g., npx -y @modelcontextprotocol/server-filesystem"
                    value={newServerCommand}
                    onChange={(e) => setNewServerCommand(e.target.value)}
                  />
                  <p className="settings-hint">
                    The command to start the MCP server
                  </p>
                </div>
                <div className="settings-field">
                  <label>Arguments (space-separated)</label>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="e.g., /Users/me/Documents"
                    value={newServerArgs}
                    onChange={(e) => setNewServerArgs(e.target.value)}
                  />
                </div>
                <div className="settings-field">
                  <label>Environment Variables (KEY=value, one per line)</label>
                  <textarea
                    className="settings-textarea"
                    placeholder="API_KEY=xxx&#10;DEBUG=true"
                    value={newServerEnv}
                    onChange={(e) => setNewServerEnv(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="mcp-form-actions">
                  <button
                    className="button-primary"
                    onClick={handleAddServer}
                    disabled={!newServerName || !newServerCommand || saving}
                  >
                    {saving ? 'Adding...' : 'Add Server'}
                  </button>
                </div>
              </div>
            )}

            {serverStatuses.length === 0 && !showAddForm ? (
              <div className="mcp-empty-state">
                <p>No MCP servers configured.</p>
                <p className="settings-hint">
                  Click "Add Server" to connect to an MCP server and extend CoWork's capabilities.
                </p>
              </div>
            ) : (
              <div className="mcp-server-list">
                {serverStatuses.map((serverStatus) => {
                  const config = settings?.servers.find(s => s.id === serverStatus.id);
                  const isConnecting = connectingServer === serverStatus.id;
                  const isTesting = testingServer === serverStatus.id;
                  const updateInfo = getUpdateInfo(serverStatus.id);
                  const isUpdating = updatingServer === serverStatus.id;

                  return (
                    <div key={serverStatus.id} className="mcp-server-card">
                      <div className="mcp-server-header">
                        <div className="mcp-server-info">
                          <div className="mcp-server-name-row">
                            <span className="mcp-server-name">{serverStatus.name}</span>
                            {updateInfo && (
                              <span className="mcp-update-badge" title={`Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}`}>
                                Update
                              </span>
                            )}
                            <span
                              className="mcp-server-status"
                              style={{ color: getStatusColor(serverStatus.status) }}
                            >
                              <span className="mcp-status-dot" style={{ backgroundColor: getStatusColor(serverStatus.status) }} />
                              {getStatusText(serverStatus.status)}
                            </span>
                          </div>
                          {config?.command && (
                            <span className="mcp-server-command">
                              {config.command} {config.args?.join(' ')}
                            </span>
                          )}
                        </div>
                        <div className="mcp-server-toggle">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={config?.enabled ?? false}
                              onChange={(e) => handleToggleEnabled(serverStatus.id, e.target.checked)}
                            />
                            <span className="toggle-slider" />
                          </label>
                        </div>
                      </div>

                      {serverStatus.error && (
                        <div className="mcp-server-error">
                          {serverStatus.error}
                        </div>
                      )}

                      <div className="mcp-server-tools-count">
                        {serverStatus.tools.length} tool{serverStatus.tools.length !== 1 ? 's' : ''} available
                      </div>

                      <div className="mcp-server-actions">
                        {serverStatus.status === 'connected' ? (
                          <button
                            className="button-small button-secondary"
                            onClick={() => handleDisconnectServer(serverStatus.id)}
                            disabled={isConnecting}
                          >
                            {isConnecting ? 'Disconnecting...' : 'Disconnect'}
                          </button>
                        ) : (
                          <button
                            className="button-small button-primary"
                            onClick={() => handleConnectServer(serverStatus.id)}
                            disabled={isConnecting || !config?.enabled}
                          >
                            {isConnecting ? 'Connecting...' : 'Connect'}
                          </button>
                        )}

                        <button
                          className="button-small button-secondary"
                          onClick={() => handleViewTools(serverStatus.id)}
                          disabled={serverStatus.status !== 'connected'}
                        >
                          View Tools
                        </button>

                        <button
                          className="button-small button-secondary"
                          onClick={() => handleTestServer(serverStatus.id)}
                          disabled={isTesting}
                        >
                          {isTesting ? 'Testing...' : 'Test'}
                        </button>

                        {updateInfo && (
                          <button
                            className="button-small button-success"
                            onClick={() => handleUpdateServer(serverStatus.id)}
                            disabled={isUpdating}
                            title={`Update from ${updateInfo.currentVersion} to ${updateInfo.latestVersion}`}
                          >
                            {isUpdating ? 'Updating...' : `Update to ${updateInfo.latestVersion}`}
                          </button>
                        )}

                        <button
                          className="button-small button-danger"
                          onClick={() => handleRemoveServer(serverStatus.id)}
                        >
                          Remove
                        </button>
                      </div>

                      {testResult?.serverId === serverStatus.id && (
                        <div className={`mcp-test-result ${testResult.success ? 'success' : 'error'}`}>
                          {testResult.success
                            ? `✓ Connection successful (${testResult.tools} tools)`
                            : `✗ ${testResult.error}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {activeView === 'registry' && (
        <div className="settings-section">
          <h3>MCP Server Registry</h3>
          <p className="settings-description">
            Browse and install MCP servers from the official registry.
            Click on a server to see details and install with one click.
          </p>
          <MCPRegistryBrowser
            onInstall={() => {
              loadData();
              setActiveView('servers');
            }}
            installedServerIds={settings?.servers.map(s => s.name) || []}
          />
        </div>
      )}

      {activeView === 'settings' && settings && (
        <div className="settings-section">
          <h3>MCP Configuration</h3>

          <div className="settings-field">
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.autoConnect}
                onChange={(e) => setSettings({ ...settings, autoConnect: e.target.checked })}
              />
              <span>Auto-connect to enabled servers on startup</span>
            </label>
          </div>

          <div className="settings-field">
            <label>Tool Name Prefix</label>
            <input
              type="text"
              className="settings-input"
              placeholder="mcp_"
              value={settings.toolNamePrefix}
              onChange={(e) => setSettings({ ...settings, toolNamePrefix: e.target.value })}
            />
            <p className="settings-hint">
              Prefix added to MCP tool names to avoid conflicts with built-in tools.
              For example, a tool named "read_file" becomes "{settings.toolNamePrefix || 'mcp_'}read_file".
            </p>
          </div>

          <div className="settings-field">
            <label>Max Reconnect Attempts</label>
            <input
              type="number"
              className="settings-input"
              min={0}
              max={20}
              value={settings.maxReconnectAttempts}
              onChange={(e) => setSettings({ ...settings, maxReconnectAttempts: parseInt(e.target.value) || 0 })}
            />
            <p className="settings-hint">
              Number of times to attempt reconnection if a server disconnects unexpectedly.
            </p>
          </div>

          <div className="settings-field">
            <label>Reconnect Delay (ms)</label>
            <input
              type="number"
              className="settings-input"
              min={100}
              max={60000}
              value={settings.reconnectDelayMs}
              onChange={(e) => setSettings({ ...settings, reconnectDelayMs: parseInt(e.target.value) || 1000 })}
            />
            <p className="settings-hint">
              Base delay between reconnection attempts (uses exponential backoff).
            </p>
          </div>

          <div className="settings-actions">
            <button
              className="button-primary"
              onClick={handleSaveSettings}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      )}

      {/* Tools Modal */}
      {viewingToolsFor && (
        <div className="mcp-modal-overlay" onClick={() => setViewingToolsFor(null)}>
          <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mcp-modal-header">
              <h3>Available Tools</h3>
              <button className="mcp-modal-close" onClick={() => setViewingToolsFor(null)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mcp-modal-content">
              {serverTools.length === 0 ? (
                <p className="mcp-no-tools">No tools available from this server.</p>
              ) : (
                <div className="mcp-tools-list">
                  {serverTools.map((tool) => (
                    <div key={tool.name} className="mcp-tool-item">
                      <div className="mcp-tool-name">{tool.name}</div>
                      {tool.description && (
                        <div className="mcp-tool-description">{tool.description}</div>
                      )}
                      {tool.inputSchema.properties && (
                        <div className="mcp-tool-params">
                          <span className="mcp-tool-params-label">Parameters: </span>
                          {Object.keys(tool.inputSchema.properties).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
