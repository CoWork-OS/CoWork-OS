import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ConnectorSetupModal, ConnectorProvider } from "./ConnectorSetupModal";
import { ConnectorEnvModal, ConnectorEnvField } from "./ConnectorEnvModal";
import { NotionSettings } from "./NotionSettings";
import { BoxSettings } from "./BoxSettings";
import { OneDriveSettings } from "./OneDriveSettings";
import { GoogleWorkspaceSettings } from "./GoogleWorkspaceSettings";
import { DropboxSettings } from "./DropboxSettings";
import { SharePointSettings } from "./SharePointSettings";

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

type ConnectorCategory = "" | "crm" | "productivity" | "communication" | "finance" | "legal" | "devtools";

interface ConnectorDefinition {
  key: string;
  name: string;
  registryId: string;
  description: string;
  supportsOAuth: boolean;
  provider?: ConnectorProvider;
  envFields?: ConnectorEnvField[];
}

const SHIPPED_CONNECTOR_IDS = new Set([
  "salesforce",
  "jira",
  "hubspot",
  "zendesk",
  "servicenow",
  "linear",
  "asana",
  "okta",
  "resend",
  "google-workspace",
  "discord",
]);

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
  {
    key: "google-workspace",
    name: "Google Workspace",
    registryId: "google-workspace",
    description: "Single Google MCP connector for Workspace APIs when a connector deployment is needed.",
    supportsOAuth: true,
    provider: "google-workspace",
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
];

interface IntegrationDefinition {
  key: string;
  name: string;
  description: string;
  component: ReactNode;
}

const INTEGRATIONS: IntegrationDefinition[] = [
  {
    key: "notion",
    name: "Notion",
    description: "Search and create content on your Notion pages.",
    component: <NotionSettings />,
  },
  {
    key: "sharepoint",
    name: "SharePoint",
    description: "Get in-depth answers from your SharePoint content.",
    component: <SharePointSettings />,
  },
  {
    key: "onedrive",
    name: "OneDrive",
    description: "Get in-depth answers from your OneDrive content.",
    component: <OneDriveSettings />,
  },
  {
    key: "googleworkspace",
    name: "Google Workspace",
    description: "Access Drive, Gmail, and Calendar with OAuth.",
    component: <GoogleWorkspaceSettings />,
  },
  {
    key: "box",
    name: "Box",
    description: "Get in-depth answers from your Box content.",
    component: <BoxSettings />,
  },
  {
    key: "dropbox",
    name: "Dropbox",
    description: "Search and access your Dropbox content.",
    component: <DropboxSettings />,
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

function getConnectorColor(name: string): string {
  const colors = [
    "#4f46e5",
    "#0891b2",
    "#059669",
    "#d97706",
    "#dc2626",
    "#7c3aed",
    "#db2777",
    "#65a30d",
    "#ea580c",
    "#0284c7",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
}

function getConnectorCategory(connector: ConnectorDefinition): Exclude<ConnectorCategory, ""> {
  if (["salesforce", "hubspot", "zendesk"].includes(connector.key)) {
    return "crm";
  }
  if (["discord", "resend"].includes(connector.key)) {
    return "communication";
  }
  if (["jira", "linear", "asana", "servicenow", "okta"].includes(connector.key)) {
    return "devtools";
  }
  return "productivity";
}

function getIntegrationCategory(): Exclude<ConnectorCategory, ""> {
  return "productivity";
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

  const [activeFilter, setActiveFilter] = useState<"all" | "connected" | "available">("all");
  const [activeCategory, setActiveCategory] = useState<ConnectorCategory>("");
  const [detailConnector, setDetailConnector] = useState<{
    connector: ConnectorDefinition;
    config: MCPServerConfig | undefined;
    status: MCPServerStatus | undefined;
  } | null>(null);
  const [integrationModal, setIntegrationModal] = useState<IntegrationDefinition | null>(null);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [customSaving, setCustomSaving] = useState(false);

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
    return CONNECTORS.filter((connector) => SHIPPED_CONNECTOR_IDS.has(connector.registryId)).map((connector) => {
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

  const handleSaveCustom = async () => {
    if (!customName.trim() || !customCommand.trim()) return;
    try {
      setCustomSaving(true);
      const args = customArgs
        .split(" ")
        .map((a) => a.trim())
        .filter(Boolean);
      await window.electronAPI.addMCPServer({
        name: customName.trim(),
        command: customCommand.trim(),
        args,
        env: {},
        enabled: true,
        transport: "stdio" as const,
      });
      await loadData();
      setShowCustomForm(false);
      setCustomName("");
      setCustomCommand("");
      setCustomArgs("");
    } catch (error: Any) {
      alert(`Failed to add connector: ${error.message}`);
    } finally {
      setCustomSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading connector settings...</div>;
  }

  const connectedCount = connectorRows.filter((r) => r.status?.status === "connected").length;
  const availableCount = connectorRows.filter((r) => r.status?.status !== "connected").length;

  const filteredRows = connectorRows.filter(({ status }) => {
    if (activeFilter === "connected") return status?.status === "connected";
    if (activeFilter === "available") return status?.status !== "connected";
    return true;
  }).filter(({ connector }) => activeCategory === "" || getConnectorCategory(connector) === activeCategory);

  const filteredIntegrations = INTEGRATIONS.filter(
    (_integration) => activeCategory === "" || getIntegrationCategory() === activeCategory,
  );

  return (
    <div className="settings-section connector-marketplace">
      <div className="settings-section-header">
        <h3>Connectors</h3>
      </div>

      <div className="cm-toolbar">
        <div className="cm-filter-tabs" role="tablist">
          {(
            [
              { key: "all", label: "All", count: connectorRows.length },
              { key: "connected", label: "Connected", count: connectedCount },
              { key: "available", label: "Available", count: availableCount },
            ] as const
          ).map(({ key, label, count }) => (
            <button
              key={key}
              role="tab"
              aria-selected={activeFilter === key}
              className={`cm-filter-tab${activeFilter === key ? " cm-filter-tab--active" : ""}`}
              onClick={() => setActiveFilter(key)}
            >
              {label}
              <span className="cm-filter-count">{count}</span>
            </button>
          ))}
        </div>

        <div className="cm-toolbar-right">
          <select
            className="cm-category-select"
            value={activeCategory}
            onChange={(e) => setActiveCategory(e.target.value as ConnectorCategory)}
          >
            <option value="">All categories</option>
            <option value="crm">CRM</option>
            <option value="productivity">Productivity</option>
            <option value="communication">Communication</option>
            <option value="finance">Finance</option>
            <option value="legal">Legal</option>
            <option value="devtools">Dev Tools</option>
          </select>
          <button
            className="button-primary button-small"
            onClick={() => setShowCustomForm(true)}
          >
            + Custom connector
          </button>
        </div>
      </div>

      <div className="cm-grid">
        {filteredRows.map(({ connector, config, status }) => {
          const isConnected = status?.status === "connected";
          const serverStatus = status?.status || "disconnected";
          return (
            <button
              key={connector.key}
              className={`cm-card${isConnected ? " cm-card--connected" : ""}`}
              onClick={() => setDetailConnector({ connector, config, status })}
            >
              {isConnected && (
                <span className="cm-card-connected-badge" aria-label="Connected">
                  ✓
                </span>
              )}
              <div
                className="cm-card-icon"
                style={{ backgroundColor: getConnectorColor(connector.name) }}
              >
                {connector.name.charAt(0).toUpperCase()}
              </div>
              <div className="cm-card-body">
                <span className="cm-card-name">{connector.name}</span>
                <span className="cm-card-desc">{connector.description}</span>
              </div>
              {config && !isConnected && (
                <span
                  className="cm-card-status-dot"
                  style={{ backgroundColor: getStatusColor(serverStatus) }}
                  title={getStatusText(serverStatus)}
                />
              )}
            </button>
          );
        })}

        {filteredRows.length === 0 && (
          <div className="cm-empty">No connectors match this filter.</div>
        )}
      </div>

      {activeFilter !== "connected" && filteredIntegrations.length > 0 && (
        <>
          <div className="cm-section-divider">
            <span className="cm-section-label">Storage &amp; Productivity</span>
          </div>
          <div className="cm-grid">
            {filteredIntegrations.map((integration) => (
              <button
                key={integration.key}
                className="cm-card"
                onClick={() => setIntegrationModal(integration)}
              >
                <div
                  className="cm-card-icon"
                  style={{ backgroundColor: getConnectorColor(integration.name) }}
                >
                  {integration.name.charAt(0).toUpperCase()}
                </div>
                <div className="cm-card-body">
                  <span className="cm-card-name">{integration.name}</span>
                  <span className="cm-card-desc">{integration.description}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {integrationModal && (
        <div className="mcp-modal-overlay" onClick={() => setIntegrationModal(null)}>
          <div className="cm-integration-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-detail-header">
              <div
                className="cm-detail-icon"
                style={{ backgroundColor: getConnectorColor(integrationModal.name) }}
              >
                {integrationModal.name.charAt(0).toUpperCase()}
              </div>
              <div className="cm-detail-title">
                <h2>{integrationModal.name}</h2>
                <p className="cm-detail-subtitle">{integrationModal.description}</p>
              </div>
              <button className="mcp-modal-close" onClick={() => setIntegrationModal(null)}>
                ×
              </button>
            </div>
            <div className="cm-integration-modal-body">{integrationModal.component}</div>
          </div>
        </div>
      )}

      {detailConnector && (
        <ConnectorDetailModal
          connector={detailConnector.connector}
          config={detailConnector.config}
          status={detailConnector.status}
          installingId={installingId}
          connectingServer={connectingServer}
          connectionErrors={connectionErrors}
          onClose={() => setDetailConnector(null)}
          onInstall={handleInstall}
          onConnect={handleConnectServer}
          onDisconnect={handleDisconnectServer}
          onOpenSetup={(p, id, name, env) =>
            setConnectorSetup({ provider: p, serverId: id, serverName: name, env })
          }
          onOpenEnvModal={(id, name, env, fields) =>
            setEnvModal({ serverId: id, serverName: name, env, fields })
          }
        />
      )}

      {showCustomForm && (
        <div className="mcp-modal-overlay" onClick={() => setShowCustomForm(false)}>
          <div className="cm-custom-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cm-custom-modal-header">
              <h3>Custom connector</h3>
              <button className="mcp-modal-close" onClick={() => setShowCustomForm(false)}>
                ×
              </button>
            </div>
            <div className="cm-custom-modal-body">
              <div className="settings-field">
                <label className="settings-label">Name</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="My Connector"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Command</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="npx"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                />
              </div>
              <div className="settings-field">
                <label className="settings-label">Arguments (space-separated)</label>
                <input
                  className="settings-input"
                  type="text"
                  placeholder="-y @my-org/my-mcp-server"
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                />
              </div>
            </div>
            <div className="cm-custom-modal-footer">
              <button className="button-secondary button-small" onClick={() => setShowCustomForm(false)}>
                Cancel
              </button>
              <button
                className="button-primary button-small"
                onClick={handleSaveCustom}
                disabled={customSaving || !customName.trim() || !customCommand.trim()}
              >
                {customSaving ? "Adding..." : "Add connector"}
              </button>
            </div>
          </div>
        </div>
      )}

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

interface ConnectorDetailModalProps {
  connector: ConnectorDefinition;
  config: MCPServerConfig | undefined;
  status: MCPServerStatus | undefined;
  installingId: string | null;
  connectingServer: string | null;
  connectionErrors: Record<string, string>;
  onClose: () => void;
  onInstall: (c: ConnectorDefinition) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onOpenSetup: (
    p: ConnectorProvider,
    id: string,
    name: string,
    env?: Record<string, string>
  ) => void;
  onOpenEnvModal: (
    id: string,
    name: string,
    env: Record<string, string> | undefined,
    fields: ConnectorEnvField[]
  ) => void;
}

function ConnectorDetailModal({
  connector,
  config,
  status,
  installingId,
  connectingServer,
  connectionErrors,
  onClose,
  onInstall,
  onConnect,
  onDisconnect,
  onOpenSetup,
  onOpenEnvModal,
}: ConnectorDetailModalProps) {
  const isInstalled = Boolean(config);
  const serverStatus = status?.status || "disconnected";
  const isConnected = serverStatus === "connected";
  const isConnecting = connectingServer === config?.id;
  const errorMsg = config ? connectionErrors[config.id] || status?.error : undefined;

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="cm-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cm-detail-header">
          <div
            className="cm-detail-icon"
            style={{ backgroundColor: getConnectorColor(connector.name) }}
          >
            {connector.name.charAt(0).toUpperCase()}
          </div>
          <div className="cm-detail-title">
            <h2>{connector.name}</h2>
            <p className="cm-detail-subtitle">{connector.description}</p>
          </div>
          <div className="cm-detail-header-right">
            {isInstalled ? (
              <span
                className={`cm-connection-badge cm-connection-badge--${serverStatus}`}
                style={{ color: getStatusColor(serverStatus) }}
              >
                <span
                  className="mcp-status-dot"
                  style={{ backgroundColor: getStatusColor(serverStatus) }}
                />
                {getStatusText(serverStatus)}
              </span>
            ) : (
              <span className="cm-connection-badge">Not installed</span>
            )}
          </div>
          <button className="mcp-modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="cm-detail-body">
          {errorMsg && (
            <div className="mcp-server-error">
              <span className="mcp-error-icon">
                <AlertTriangle size={14} strokeWidth={2} />
              </span>
              {errorMsg}
            </div>
          )}

          <div className="cm-detail-section">
            <h4 className="cm-detail-section-title">Connection</h4>
            <div className="cm-detail-actions">
              {!isInstalled ? (
                <button
                  className="button-primary button-small"
                  onClick={() => onInstall(connector)}
                  disabled={installingId === connector.registryId}
                >
                  {installingId === connector.registryId ? "Installing..." : "Install connector"}
                </button>
              ) : (
                <>
                  {isConnected ? (
                    <button
                      className="button-secondary button-small"
                      onClick={() => onDisconnect(config!.id)}
                      disabled={isConnecting}
                    >
                      {isConnecting ? "Disconnecting..." : "Disconnect"}
                    </button>
                  ) : (
                    <button
                      className="button-primary button-small"
                      onClick={() => onConnect(config!.id)}
                      disabled={isConnecting}
                    >
                      {isConnecting ? "Connecting..." : "Connect"}
                    </button>
                  )}

                  {connector.supportsOAuth && connector.provider && (
                    <button
                      className="button-primary button-small"
                      onClick={() =>
                        onOpenSetup(connector.provider!, config!.id, config!.name, config!.env)
                      }
                    >
                      OAuth Setup
                    </button>
                  )}

                  {!connector.supportsOAuth && connector.envFields && (
                    <button
                      className="button-secondary button-small"
                      onClick={() =>
                        onOpenEnvModal(config!.id, config!.name, config!.env, connector.envFields!)
                      }
                    >
                      Configure credentials
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="cm-detail-section">
            <h4 className="cm-detail-section-title">Overview</h4>
            <p className="cm-detail-overview">{connector.description}</p>
            <ul className="cm-detail-overview-bullets">
              <li>Auth method: {connector.supportsOAuth ? "OAuth 2.0" : "API credentials"}</li>
              {connector.envFields && connector.envFields.length > 0 && (
                <li>
                  Required fields: {connector.envFields.map((f) => f.label).join(", ")}
                </li>
              )}
              {status?.tools && status.tools.length > 0 && (
                <li>{status.tools.length} tools available</li>
              )}
            </ul>
          </div>

          {isConnected && status?.tools && status.tools.length > 0 && (
            <div className="cm-detail-section">
              <h4 className="cm-detail-section-title">Available tools</h4>
              <ul className="cm-tools-list">
                {status.tools.map((tool) => (
                  <li key={tool.name} className="cm-tools-item">
                    <span className="cm-tools-check">✓</span>
                    <span className="cm-tools-name">{tool.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
