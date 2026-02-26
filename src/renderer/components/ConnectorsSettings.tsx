import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ConnectorSetupModal, ConnectorProvider } from "./ConnectorSetupModal";
import { ConnectorEnvModal, ConnectorEnvField } from "./ConnectorEnvModal";

// Types (matching preload types)
type MCPConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

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
    key: "salesforce",
    name: "Salesforce",
    registryId: "salesforce",
    description: "CRM (accounts, cases, opportunities).",
    supportsOAuth: true,
    provider: "salesforce",
  },
  {
    key: "jira",
    name: "Jira",
    registryId: "jira",
    description: "Issue tracking for teams.",
    supportsOAuth: true,
    provider: "jira",
  },
  {
    key: "hubspot",
    name: "HubSpot",
    registryId: "hubspot",
    description: "CRM objects for contacts, companies, deals.",
    supportsOAuth: true,
    provider: "hubspot",
  },
  {
    key: "zendesk",
    name: "Zendesk",
    registryId: "zendesk",
    description: "Support tickets and customer operations.",
    supportsOAuth: true,
    provider: "zendesk",
  },
  {
    key: "servicenow",
    name: "ServiceNow",
    registryId: "servicenow",
    description: "ITSM records and table APIs.",
    supportsOAuth: false,
    envFields: [
      {
        key: "SERVICENOW_INSTANCE_URL",
        label: "Instance URL",
        placeholder: "https://instance.service-now.com",
      },
      { key: "SERVICENOW_INSTANCE", label: "Instance Subdomain", placeholder: "dev12345" },
      { key: "SERVICENOW_USERNAME", label: "Username" },
      { key: "SERVICENOW_PASSWORD", label: "Password", type: "password" },
      { key: "SERVICENOW_ACCESS_TOKEN", label: "Access Token", type: "password" },
    ],
  },
  {
    key: "linear",
    name: "Linear",
    registryId: "linear",
    description: "Project and issue tracking (GraphQL).",
    supportsOAuth: false,
    envFields: [{ key: "LINEAR_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "asana",
    name: "Asana",
    registryId: "asana",
    description: "Work management tasks and projects.",
    supportsOAuth: false,
    envFields: [{ key: "ASANA_ACCESS_TOKEN", label: "Access Token", type: "password" }],
  },
  {
    key: "okta",
    name: "Okta",
    registryId: "okta",
    description: "User and directory management.",
    supportsOAuth: false,
    envFields: [
      { key: "OKTA_BASE_URL", label: "Okta Base URL", placeholder: "https://your-org.okta.com" },
      { key: "OKTA_API_TOKEN", label: "API Token", type: "password" },
    ],
  },
  {
    key: "resend",
    name: "Resend",
    registryId: "resend",
    description: "Transactional email send + inbound webhook management.",
    supportsOAuth: false,
    envFields: [
      { key: "RESEND_API_KEY", label: "API Key", type: "password" },
      { key: "RESEND_BASE_URL", label: "Base URL", placeholder: "https://api.resend.com" },
    ],
  },
  // --- Google Workspace (OAuth) ---
  {
    key: "google-calendar",
    name: "Google Calendar",
    registryId: "google-calendar",
    description: "Calendar events, scheduling, and availability.",
    supportsOAuth: true,
    provider: "google-calendar",
  },
  {
    key: "google-drive",
    name: "Google Drive",
    registryId: "google-drive",
    description: "File storage, search, and document management.",
    supportsOAuth: true,
    provider: "google-drive",
  },
  {
    key: "gmail",
    name: "Gmail",
    registryId: "gmail",
    description: "Email read, send, and label management.",
    supportsOAuth: true,
    provider: "gmail",
  },
  // --- OAuth connectors ---
  {
    key: "docusign",
    name: "DocuSign",
    registryId: "docusign",
    description: "Envelope management and e-signatures.",
    supportsOAuth: true,
    provider: "docusign",
  },
  {
    key: "outreach",
    name: "Outreach",
    registryId: "outreach",
    description: "Sales engagement sequences and analytics.",
    supportsOAuth: true,
    provider: "outreach",
  },
  {
    key: "slack",
    name: "Slack",
    registryId: "slack",
    description: "Team messaging, channels, and notifications.",
    supportsOAuth: true,
    provider: "slack",
  },
  {
    key: "discord",
    name: "Discord",
    registryId: "discord",
    description: "Guild management, channels, roles, messages, and webhooks.",
    supportsOAuth: false,
    envFields: [
      { key: "DISCORD_BOT_TOKEN", label: "Bot Token", type: "password" },
      { key: "DISCORD_APPLICATION_ID", label: "Application ID" },
      { key: "DISCORD_GUILD_ID", label: "Default Guild ID (optional)" },
    ],
  },
  // --- API-key connectors ---
  {
    key: "apollo",
    name: "Apollo",
    registryId: "apollo",
    description: "Prospecting and data enrichment.",
    supportsOAuth: false,
    envFields: [{ key: "APOLLO_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "clay",
    name: "Clay",
    registryId: "clay",
    description: "Data enrichment and waterfall workflows.",
    supportsOAuth: false,
    envFields: [{ key: "CLAY_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "similarweb",
    name: "Similarweb",
    registryId: "similarweb",
    description: "Web traffic analytics and competitive intelligence.",
    supportsOAuth: false,
    envFields: [{ key: "SIMILARWEB_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "msci",
    name: "MSCI",
    registryId: "msci",
    description: "ESG ratings, risk analytics, and index data.",
    supportsOAuth: false,
    envFields: [
      { key: "MSCI_API_KEY", label: "API Key", type: "password" },
      { key: "MSCI_BASE_URL", label: "Base URL", placeholder: "https://api.msci.com" },
    ],
  },
  {
    key: "legalzoom",
    name: "LegalZoom",
    registryId: "legalzoom",
    description: "Legal document management and business filings.",
    supportsOAuth: false,
    envFields: [{ key: "LEGALZOOM_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "factset",
    name: "FactSet",
    registryId: "factset",
    description: "Financial data, analytics, and research.",
    supportsOAuth: false,
    envFields: [
      { key: "FACTSET_USERNAME", label: "Username" },
      { key: "FACTSET_API_KEY", label: "API Key", type: "password" },
    ],
  },
  {
    key: "wordpress",
    name: "WordPress",
    registryId: "wordpress",
    description: "Content management (posts, pages, media).",
    supportsOAuth: false,
    envFields: [
      { key: "WORDPRESS_SITE_URL", label: "Site URL", placeholder: "https://your-site.com" },
      { key: "WORDPRESS_USERNAME", label: "Username" },
      { key: "WORDPRESS_APPLICATION_PASSWORD", label: "Application Password", type: "password" },
    ],
  },
  {
    key: "harvey",
    name: "Harvey",
    registryId: "harvey",
    description: "AI-powered legal research and document analysis.",
    supportsOAuth: false,
    envFields: [{ key: "HARVEY_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "lseg",
    name: "LSEG (Refinitiv)",
    registryId: "lseg",
    description: "Market data, news, and financial analytics.",
    supportsOAuth: false,
    envFields: [
      { key: "LSEG_API_KEY", label: "API Key", type: "password" },
      { key: "LSEG_API_SECRET", label: "API Secret", type: "password" },
    ],
  },
  {
    key: "spglobal",
    name: "S&P Global",
    registryId: "spglobal",
    description: "Financial intelligence, credit ratings, and market data.",
    supportsOAuth: false,
    envFields: [
      { key: "SPGLOBAL_USERNAME", label: "Username" },
      { key: "SPGLOBAL_API_KEY", label: "API Key", type: "password" },
    ],
  },
  {
    key: "commonroom",
    name: "Common Room",
    registryId: "commonroom",
    description: "Community intelligence and signal tracking.",
    supportsOAuth: false,
    envFields: [{ key: "COMMONROOM_API_KEY", label: "API Key", type: "password" }],
  },
  {
    key: "tribeai",
    name: "Tribe AI",
    registryId: "tribeai",
    description: "AI workforce management and expert matching.",
    supportsOAuth: false,
    envFields: [{ key: "TRIBEAI_API_KEY", label: "API Key", type: "password" }],
  },
];

const getStatusColor = (status: MCPConnectionStatus): string => {
  switch (status) {
    case "connected":
      return "var(--color-success)";
    case "connecting":
    case "reconnecting":
      return "var(--color-warning)";
    case "error":
      return "var(--color-error)";
    default:
      return "var(--color-text-tertiary)";
  }
};

const getStatusText = (status: MCPConnectionStatus): string => {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
};

function matchConnector(config: MCPServerConfig, connector: ConnectorDefinition): boolean {
  const nameMatch = config.name.toLowerCase().includes(connector.key);
  const argsMatch = (config.args || []).some((arg) => arg.toLowerCase().includes(connector.key));
  const commandMatch = (config.command || "").toLowerCase().includes(connector.key);
  return nameMatch || argsMatch || commandMatch;
}

export function ConnectorsSettings() {
  const [settings, setSettings] = useState<MCPSettingsData | null>(null);
  const [serverStatuses, setServerStatuses] = useState<MCPServerStatus[]>([]);
  const [registryConnectorIds, setRegistryConnectorIds] = useState<Set<string> | null>(null);
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
      const [loadedSettings, statuses, registry] = await Promise.all([
        window.electronAPI.getMCPSettings(),
        window.electronAPI.getMCPStatus(),
        window.electronAPI.fetchMCPRegistry().catch(() => null),
      ]);
      setSettings(loadedSettings);
      setServerStatuses(statuses);
      if (registry?.servers) {
        setRegistryConnectorIds(new Set(registry.servers.map((server: Any) => String(server.id))));
      } else {
        setRegistryConnectorIds(null);
      }
    } catch (error) {
      console.error("Failed to load connector settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const connectorRows = useMemo(() => {
    if (!settings) return [];
    return CONNECTORS.map((connector) => {
      const config = settings.servers.find((server) => matchConnector(server, connector));
      const status = config ? serverStatuses.find((s) => s.id === config.id) : undefined;
      return { connector, config, status };
    }).filter(({ connector, config }) => {
      // Always show already-installed connectors.
      if (config) return true;
      // If registry info is unavailable, keep previous behavior.
      if (!registryConnectorIds) return true;
      // Only advertise connectors currently available from the registry.
      return registryConnectorIds.has(connector.registryId);
    });
  }, [settings, serverStatuses, registryConnectorIds]);

  const handleInstall = async (connector: ConnectorDefinition) => {
    try {
      setInstallingId(connector.registryId);
      await window.electronAPI.installMCPServer(connector.registryId);
      await loadData();
    } catch (error: Any) {
      alert(`Failed to install ${connector.name}: ${error.message}`);
    } finally {
      setInstallingId(null);
    }
  };

  const handleConnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.connectMCPServer(serverId);
    } catch (error: Any) {
      setConnectionErrors((prev) => ({
        ...prev,
        [serverId]: error.message || "Connection failed",
      }));
    } finally {
      setConnectingServer(null);
    }
  };

  const handleDisconnectServer = async (serverId: string) => {
    try {
      setConnectingServer(serverId);
      setConnectionErrors((prev) => {
        const { [serverId]: _, ...rest } = prev;
        return rest;
      });
      await window.electronAPI.disconnectMCPServer(serverId);
    } catch (error: Any) {
      setConnectionErrors((prev) => ({
        ...prev,
        [serverId]: error.message || "Disconnect failed",
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
          const serverStatus = status?.status || "disconnected";
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
                      <span
                        className="mcp-status-dot"
                        style={{ backgroundColor: getStatusColor(serverStatus) }}
                      />
                      {isInstalled ? getStatusText(serverStatus) : "Not installed"}
                    </span>
                  </div>
                  <span className="mcp-server-command">{connector.description}</span>
                </div>
              </div>

              {isInstalled && (status?.error || connectionErrors[config!.id]) && (
                <div className="mcp-server-error">
                  <span className="mcp-error-icon">
                    <AlertTriangle size={14} strokeWidth={2} />
                  </span>
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
                    {installingId === connector.registryId ? "Installing..." : "Install"}
                  </button>
                ) : (
                  <>
                    {serverStatus === "connected" ? (
                      <button
                        className="button-small button-secondary"
                        onClick={() => handleDisconnectServer(config!.id)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? "Disconnecting..." : "Disconnect"}
                      </button>
                    ) : (
                      <button
                        className="button-small button-primary"
                        onClick={() => handleConnectServer(config!.id)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? "Connecting..." : "Connect"}
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
