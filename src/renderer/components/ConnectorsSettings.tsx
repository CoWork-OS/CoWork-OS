import { useEffect, useMemo, useState } from 'react';
import { ConnectorSetupModal, ConnectorProvider } from './ConnectorSetupModal';
import { ConnectorEnvModal, ConnectorEnvField } from './ConnectorEnvModal';

// Types (matching preload types)
type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

type MCPServerConfig = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

type MCPServerStatus = {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: Array<{ name: string }>;
};

type MCPSettingsData = {
  servers: MCPServerConfig[];
};

interface ConnectorDefinition {
  key: string;
  name: string;
  registryId: string;
  description: string;
  supportsOAuth: boolean;
  provider?: ConnectorProvider;
  envFields?: ConnectorEnvField[];
}

const CONNECTORS: ConnectorDefinition[] = [
  {
    key: 'salesforce',
    name: 'Salesforce',
    registryId: 'salesforce',
    description: 'CRM (accounts, cases, opportunities).',
    supportsOAuth: true,
    provider: 'salesforce',
  },
  {
    key: 'jira',
    name: 'Jira',
    registryId: 'jira',
    description: 'Issue tracking for teams.',
    supportsOAuth: true,
    provider: 'jira',
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    registryId: 'hubspot',
    description: 'CRM objects for contacts, companies, deals.',
    supportsOAuth: true,
    provider: 'hubspot',
  },
  {
    key: 'zendesk',
    name: 'Zendesk',
    registryId: 'zendesk',
    description: 'Support tickets and customer operations.',
    supportsOAuth: true,
    provider: 'zendesk',
  },
  {
    key: 'servicenow',
    name: 'ServiceNow',
    registryId: 'servicenow',
    description: 'ITSM records and table APIs.',
    supportsOAuth: false,
    envFields: [
      { key: 'SERVICENOW_INSTANCE_URL', label: 'Instance URL', placeholder: 'https://instance.service-now.com' },
      { key: 'SERVICENOW_INSTANCE', label: 'Instance Subdomain', placeholder: 'dev12345' },
      { key: 'SERVICENOW_USERNAME', label: 'Username' },
      { key: 'SERVICENOW_PASSWORD', label: 'Password', type: 'password' },
      { key: 'SERVICENOW_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
    ],
  },
  {
    key: 'linear',
    name: 'Linear',
    registryId: 'linear',
    description: 'Project and issue tracking (GraphQL).',
    supportsOAuth: false,
    envFields: [
      { key: 'LINEAR_API_KEY', label: 'API Key', type: 'password' },
    ],
  },
  {
    key: 'asana',
    name: 'Asana',
    registryId: 'asana',
    description: 'Work management tasks and projects.',
    supportsOAuth: false,
    envFields: [
      { key: 'ASANA_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
    ],
  },
  {
    key: 'okta',
    name: 'Okta',
    registryId: 'okta',
    description: 'User and directory management.',
    supportsOAuth: false,
    envFields: [
      { key: 'OKTA_BASE_URL', label: 'Okta Base URL', placeholder: 'https://your-org.okta.com' },
      { key: 'OKTA_API_TOKEN', label: 'API Token', type: 'password' },
    ],
  },
  {
    key: 'resend',
    name: 'Resend',
    registryId: 'resend',
    description: 'Transactional email send + inbound webhook management.',
    supportsOAuth: false,
    envFields: [
      { key: 'RESEND_API_KEY', label: 'API Key', type: 'password' },
      { key: 'RESEND_BASE_URL', label: 'Base URL', placeholder: 'https://api.resend.com' },
    ],
  },
];

const getStatusColor = (status: MCPConnectionStatus): string => {
  switch (status) {
    case 'connected':
      return 'var(--color-success)';
    case 'connecting':
    case 'reconnecting':
      return 'var(--color-warning)';
    case 'error':
      return 'var(--color-error)';
    default:
      return 'var(--color-text-tertiary)';
  }
};

const getStatusText = (status: MCPConnectionStatus): string => {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
};

function matchConnector(config: MCPServerConfig, connector: ConnectorDefinition): boolean {
  const nameMatch = config.name.toLowerCase().includes(connector.key);
  const argsMatch = (config.args || []).some((arg) => arg.toLowerCase().includes(connector.key));
  const commandMatch = (config.command || '').toLowerCase().includes(connector.key);
  return nameMatch || argsMatch || commandMatch;
}

export function ConnectorsSettings() {
  const [settings, setSettings] = useState<MCPSettingsData | null>(null);
  const [serverStatuses, setServerStatuses] = useState<MCPServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [connectingServer, setConnectingServer] = useState<string | null>(null);
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});

  const [connectorSetup, setConnectorSetup] = useState<{
    provider: ConnectorProvider;
    serverId: string;
    serverName: string;
    env?: Record<string, string>;
  } | null>(null);

  const [envModal, setEnvModal] = useState<{
    serverId: string;
    serverName: string;
    env?: Record<string, string>;
    fields: ConnectorEnvField[];
  } | null>(null);

  useEffect(() => {
    loadData();

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
      console.error('Failed to load connector settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const connectorRows = useMemo(() => {
    if (!settings) return [];
    return CONNECTORS.map((connector) => {
      const config = settings.servers.find((server) => matchConnector(server, connector));
      const status = config
        ? serverStatuses.find((s) => s.id === config.id)
        : undefined;
      return { connector, config, status };
    });
  }, [settings, serverStatuses]);

  const handleInstall = async (connector: ConnectorDefinition) => {
    try {
      setInstallingId(connector.registryId);
      await window.electronAPI.installMCPServer(connector.registryId);
      await loadData();
    } catch (error: any) {
      alert(`Failed to install ${connector.name}: ${error.message}`);
    } finally {
      setInstallingId(null);
    }
  };

  const handleConnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors(prev => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.connectMCPServer(serverId);
    } catch (error: any) {
      setConnectionErrors(prev => ({
        ...prev,
        [serverId]: error.message || 'Connection failed',
      }));
    } finally {
      setConnectingServer(null);
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors(prev => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.disconnectMCPServer(serverId);
    } catch (error: any) {
      setConnectionErrors(prev => ({
        ...prev,
        [serverId]: error.message || 'Disconnect failed',
      }));
    } finally {
      setConnectingServer(null);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading connector settings...</div>;
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <h3>Connectors</h3>
      </div>
      <p className="settings-description">
        Connect enterprise systems to your assistant. Configure credentials and monitor status here.
      </p>

      <div className="mcp-server-list">
        {connectorRows.map(({ connector, config, status }) => {
          const isInstalled = Boolean(config);
          const serverStatus = status?.status || 'disconnected';
          const isConnecting = connectingServer === config?.id;
          return (
            <div key={connector.key} className="mcp-server-card">
              <div className="mcp-server-header">
                <div className="mcp-server-info">
                  <div className="mcp-server-name-row">
                    <span className="mcp-server-name">{connector.name}</span>
                    <span
                      className="mcp-server-status"
                      style={{ color: getStatusColor(serverStatus) }}
                    >
                      <span className="mcp-status-dot" style={{ backgroundColor: getStatusColor(serverStatus) }} />
                      {isInstalled ? getStatusText(serverStatus) : 'Not installed'}
                    </span>
                  </div>
                  <span className="mcp-server-command">{connector.description}</span>
                </div>
              </div>

              {isInstalled && (status?.error || connectionErrors[config!.id]) && (
                <div className="mcp-server-error">
                  <span className="mcp-error-icon">⚠</span>
                  {connectionErrors[config!.id] || status?.error}
                </div>
              )}

              <div className="mcp-server-actions">
                {!isInstalled ? (
                  <button
                    className="button-small button-primary"
                    onClick={() => handleInstall(connector)}
                    disabled={installingId === connector.registryId}
                  >
                    {installingId === connector.registryId ? 'Installing...' : 'Install'}
                  </button>
                ) : (
                  <>
                    {serverStatus === 'connected' ? (
                      <button
                        className="button-small button-secondary"
                        onClick={() => handleDisconnectServer(config!.id)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? 'Disconnecting...' : 'Disconnect'}
                      </button>
                    ) : (
                      <button
                        className="button-small button-primary"
                        onClick={() => handleConnectServer(config!.id)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? 'Connecting...' : 'Connect'}
                      </button>
                    )}

                    {connector.supportsOAuth && connector.provider && (
                      <button
                        className="button-small button-primary"
                        onClick={() =>
                          setConnectorSetup({
                            provider: connector.provider!,
                            serverId: config!.id,
                            serverName: config!.name,
                            env: config!.env,
                          })
                        }
                      >
                        Setup
                      </button>
                    )}

                    {!connector.supportsOAuth && connector.envFields && (
                      <button
                        className="button-small button-secondary"
                        onClick={() =>
                          setEnvModal({
                            serverId: config!.id,
                            serverName: config!.name,
                            env: config!.env,
                            fields: connector.envFields!,
                          })
                        }
                      >
                        Configure
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {connectorSetup && (
        <ConnectorSetupModal
          provider={connectorSetup.provider}
          serverId={connectorSetup.serverId}
          serverName={connectorSetup.serverName}
          initialEnv={connectorSetup.env}
          onClose={() => setConnectorSetup(null)}
          onSaved={loadData}
        />
      )}

      {envModal && (
        <ConnectorEnvModal
          serverId={envModal.serverId}
          serverName={envModal.serverName}
          initialEnv={envModal.env}
          fields={envModal.fields}
          onClose={() => setEnvModal(null)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}
