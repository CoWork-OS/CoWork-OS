import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { getConnectorProfile, type ConnectorProfile } from "../../shared/connector-profiles";
import { ConnectorBrandIcon } from "./ConnectorBrandIcon";
import type { ConnectorProvider } from "./ConnectorSetupModal";
import type { ConnectorEnvField } from "./ConnectorEnvModal";

type MCPConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

type MCPServerConfig = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
};

type MCPServerStatus = {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: Array<{ name: string }>;
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

function getStatusColor(status: MCPConnectionStatus): string {
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
}

function getStatusText(status: MCPConnectionStatus): string {
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
}

type MCPRegistryEntry = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tools: Array<{ name: string; description?: string }>;
  tags: string[];
  category?: string;
  verified?: boolean;
  featured?: boolean;
};

type MCPUpdateInfo = {
  serverId: string;
  currentVersion: string;
  latestVersion: string;
  registryEntry: MCPRegistryEntry;
};

export interface ConnectorProfileViewProps {
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
    env?: Record<string, string>,
  ) => void;
  onOpenEnvModal: (
    id: string,
    name: string,
    env: Record<string, string> | undefined,
    fields: ConnectorEnvField[],
  ) => void;
  onUpdate?: (serverId: string) => void | Promise<void>;
}

export function ConnectorProfileView({
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
  onUpdate,
}: ConnectorProfileViewProps) {
  const profile = getConnectorProfile(connector.registryId) as ConnectorProfile | undefined;
  const isInstalled = Boolean(config);
  const serverStatus = status?.status || "disconnected";
  const isConnected = serverStatus === "connected";
  const isConnecting = connectingServer === config?.id;
  const errorMsg = config ? connectionErrors[config.id] || status?.error : undefined;

  const [registryEntry, setRegistryEntry] = useState<MCPRegistryEntry | null>(null);
  const [updateInfo, setUpdateInfo] = useState<MCPUpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const registry = await window.electronAPI.fetchMCPRegistry();
        const entry = registry?.servers?.find((s: { id: string }) => s.id === connector.registryId);
        if (!cancelled && entry) setRegistryEntry(entry);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connector.registryId]);

  useEffect(() => {
    if (!config?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const updates = await window.electronAPI.checkMCPUpdates();
        const info = updates?.find((u: MCPUpdateInfo) => u.serverId === config.id);
        if (!cancelled && info) setUpdateInfo(info);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config?.id]);

  const tools = status?.tools ?? registryEntry?.tools ?? [];
  const toolNames = tools.map((t) => (typeof t === "string" ? t : t.name));
  const author = config?.author ?? registryEntry?.author ?? "";
  const homepage = config?.homepage ?? registryEntry?.homepage;
  const version = config?.version ?? registryEntry?.version ?? "";
  const connectorUrl = config?.url;

  const tagline = profile?.tagline ?? connector.description;
  const longDescription = profile?.longDescription ?? connector.description;
  const keyFeatures = profile?.keyFeatures ?? [];
  const examples = profile?.examples ?? [];
  const handleConnectClick = async () => {
    if (!isInstalled) {
      onInstall(connector);
      return;
    }
    if (isConnected) {
      onDisconnect(config!.id);
      return;
    }
    onConnect(config!.id);
  };

  const getConnectButtonLabel = () => {
    if (!isInstalled) {
      return installingId === connector.registryId ? "Installing..." : "Install & Connect";
    }
    if (isConnected) {
      return isConnecting ? "Disconnecting..." : "Disconnect";
    }
    return isConnecting ? "Connecting..." : "Connect";
  };

  const handleUpdate = async () => {
    if (!config?.id || updating) return;
    try {
      setUpdating(true);
      await window.electronAPI.updateMCPServerFromRegistry(config.id);
      setUpdateInfo(null);
      onUpdate?.(config.id);
    } finally {
      setUpdating(false);
    }
  };

  const handleCopyUrl = () => {
    if (connectorUrl) navigator.clipboard.writeText(connectorUrl);
  };

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="cm-profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Top nav: Back + Close */}
        <div className="cm-profile-nav">
          <button type="button" className="cm-profile-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={18} strokeWidth={2} />
            <span>Back</span>
          </button>
          <button type="button" className="mcp-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Header: Icon, Title, Tagline, Connect */}
        <div className="cm-profile-header">
          <ConnectorBrandIcon
            connectorKey={connector.key}
            name={connector.name}
            className="cm-profile-icon"
          />
          <div className="cm-profile-header-content">
            <h1 className="cm-profile-title">{connector.name}</h1>
            <p className="cm-profile-tagline">{tagline}</p>
          </div>
          <div className="cm-profile-header-actions">
            {updateInfo && (
              <button
                type="button"
                className="cm-profile-update-btn"
                onClick={handleUpdate}
                disabled={updating}
              >
                {updating ? "Updating..." : "Update"}
              </button>
            )}
            <button
              type="button"
              className={`cm-profile-connect-btn ${isConnected ? "connected" : ""}`}
              onClick={handleConnectClick}
              disabled={
                (isInstalled && isConnecting) ||
                (!isInstalled && installingId === connector.registryId)
              }
            >
              {getConnectButtonLabel()}
            </button>
            {isInstalled && !isConnected && connector.supportsOAuth && connector.provider && (
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() =>
                  onOpenSetup(connector.provider!, config!.id, config!.name, config!.env)
                }
              >
                OAuth Setup
              </button>
            )}
            {isInstalled &&
              !isConnected &&
              connector.envFields &&
              connector.envFields.length > 0 && (
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() =>
                    onOpenEnvModal(config!.id, config!.name, config!.env, connector.envFields!)
                  }
                >
                  Configure
                </button>
              )}
          </div>
        </div>

        {errorMsg && (
          <div className="mcp-server-error cm-profile-error">
            <span className="mcp-error-icon">
              <AlertTriangle size={14} strokeWidth={2} />
            </span>
            {errorMsg}
          </div>
        )}

        <div className="cm-profile-body">
          {/* Example cards */}
          {examples.length > 0 && (
            <div className="cm-profile-examples">
              <h3 className="cm-profile-section-label">Examples</h3>
              <div className="cm-profile-examples-grid">
                {examples.map((ex, i) => (
                  <div key={i} className="cm-example-card">
                    <div className="cm-example-prompt">{ex.prompt}</div>
                    <div className="cm-example-result">
                      {ex.resultImageUrl ? (
                        <img src={ex.resultImageUrl} alt={ex.resultLabel ?? "Example output"} />
                      ) : (
                        <div className="cm-example-placeholder">
                          {ex.resultLabel ?? "Example output"}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          <div className="cm-profile-description">
            <p>{longDescription}</p>
          </div>

          {/* Key features */}
          {keyFeatures.length > 0 && (
            <div className="cm-profile-features">
              <h3 className="cm-profile-section-label">Key features</h3>
              <ul className="cm-profile-features-list">
                {keyFeatures.map((f, i) => (
                  <li key={i}>
                    <strong>{f.title}</strong> — {f.description}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Developed by & Trust warning (for MCP connectors) */}
          {(author || registryEntry || toolNames.length > 0) && (
            <div className="cm-profile-developed-by">
              {author && (
                <p className="cm-profile-developed-by-text">
                  <span className="cm-profile-developed-by-label">Developed by</span>{" "}
                  {homepage ? (
                    <a
                      href={homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cm-profile-author-link"
                    >
                      {author}
                      <ExternalLink size={12} strokeWidth={2} />
                    </a>
                  ) : (
                    author
                  )}
                </p>
              )}
              <p className="cm-profile-trust-warning">
                Only use connectors from developers you trust. Anthropic does not control these
                tools.
              </p>
            </div>
          )}

          {/* Tools */}
          {toolNames.length > 0 && (
            <div className="cm-profile-tools">
              <h3 className="cm-profile-section-label">
                Tools <span className="cm-profile-tools-badge">{toolNames.length}</span>
              </h3>
              <div className="cm-profile-tools-pills">
                {toolNames.map((name) => (
                  <span key={name} className="cm-profile-tool-pill">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Details */}
          {(version || author || homepage || connectorUrl) && (
            <div className="cm-profile-details">
              <h3 className="cm-profile-section-label">Details</h3>
              <div className="cm-profile-details-grid">
                <div className="cm-profile-details-col">
                  {version && (
                    <div className="cm-profile-detail-row">
                      <span className="cm-profile-detail-label">Version</span>
                      <span className="cm-profile-detail-value">
                        {version}
                        {updateInfo && (
                          <span className="cm-profile-update-badge">Update available</span>
                        )}
                      </span>
                    </div>
                  )}
                  <div className="cm-profile-detail-row">
                    <span className="cm-profile-detail-label">Capabilities</span>
                    <span className="cm-profile-detail-value">Interactive</span>
                  </div>
                  {(homepage || registryEntry?.repository) && (
                    <div className="cm-profile-detail-row">
                      <span className="cm-profile-detail-label">More info</span>
                      <span className="cm-profile-detail-links">
                        {homepage && (
                          <a
                            href={homepage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cm-profile-detail-link"
                          >
                            Documentation
                            <ExternalLink size={12} strokeWidth={2} />
                          </a>
                        )}
                        {registryEntry?.repository && (
                          <a
                            href={registryEntry.repository}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cm-profile-detail-link"
                          >
                            Support
                            <ExternalLink size={12} strokeWidth={2} />
                          </a>
                        )}
                      </span>
                    </div>
                  )}
                </div>
                <div className="cm-profile-details-col">
                  {author && (
                    <div className="cm-profile-detail-row">
                      <span className="cm-profile-detail-label">Author</span>
                      <span className="cm-profile-detail-value">
                        {homepage ? (
                          <a
                            href={homepage}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cm-profile-detail-link"
                          >
                            {author}
                            <ExternalLink size={12} strokeWidth={2} />
                          </a>
                        ) : (
                          author
                        )}
                      </span>
                    </div>
                  )}
                  {connectorUrl && (
                    <div className="cm-profile-detail-row">
                      <span className="cm-profile-detail-label">Connector URL</span>
                      <span className="cm-profile-detail-value cm-profile-detail-url">
                        <code>{connectorUrl}</code>
                        <button
                          type="button"
                          className="cm-profile-copy-btn"
                          onClick={handleCopyUrl}
                          aria-label="Copy URL"
                        >
                          <Copy size={14} strokeWidth={2} />
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Connection status & tools (compact) */}
        {isInstalled && (
          <div className="cm-profile-footer">
            <span className="cm-profile-status" style={{ color: getStatusColor(serverStatus) }}>
              <span
                className="mcp-status-dot"
                style={{ backgroundColor: getStatusColor(serverStatus) }}
              />
              {getStatusText(serverStatus)}
            </span>
            {isConnected && status?.tools && status.tools.length > 0 && (
              <span className="cm-profile-tools-count">{status.tools.length} tools available</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
