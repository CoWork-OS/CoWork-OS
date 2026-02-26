import { useState, useEffect, useCallback } from "react";
import type { NodeInfo, NodeInvokeResult } from "../../shared/types";

interface NodesSettingsProps {
  compact?: boolean;
}

export function NodesSettings({ compact = false }: NodesSettingsProps) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [testingCommand, setTestingCommand] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    nodeId: string;
    command: string;
    result: NodeInvokeResult;
  } | null>(null);

  const loadNodes = useCallback(async () => {
    try {
      const result = await window.electronAPI?.nodeList?.();
      if (result?.ok && result.nodes) {
        setNodes(result.nodes);
      } else {
        setNodes([]);
      }
    } catch (error) {
      console.error("Failed to load nodes:", error);
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load nodes on mount and set up event listener
  useEffect(() => {
    loadNodes();

    // Subscribe to node events
    const unsubscribe = window.electronAPI?.onNodeEvent?.((event) => {
      if (
        event.type === "connected" ||
        event.type === "disconnected" ||
        event.type === "capabilities_changed"
      ) {
        loadNodes();
      }
    });

    // Refresh nodes periodically
    const interval = setInterval(loadNodes, 10000);

    return () => {
      unsubscribe?.();
      clearInterval(interval);
    };
  }, [loadNodes]);

  const handleTestCommand = async (nodeId: string, command: string) => {
    setTestingCommand(`${nodeId}:${command}`);
    setTestResult(null);

    try {
      const result = await window.electronAPI?.nodeInvoke?.({
        nodeId,
        command,
        params: command === "camera.snap" ? { facing: "back", maxWidth: 640 } : undefined,
        timeoutMs: 30000,
      });

      setTestResult({
        nodeId,
        command,
        result: result || { ok: false, error: { code: "UNKNOWN", message: "No response" } },
      });
    } catch (error: Any) {
      setTestResult({
        nodeId,
        command,
        result: {
          ok: false,
          error: { code: "ERROR", message: error.message || "Failed to invoke command" },
        },
      });
    } finally {
      setTestingCommand(null);
    }
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case "ios":
        return ""; // Apple icon
      case "android":
        return ""; // Android icon
      case "macos":
        return "";
      default:
        return "";
    }
  };

  const getCapabilityIcon = (capability: string) => {
    switch (capability) {
      case "camera":
        return "";
      case "location":
        return "";
      case "screen":
        return "";
      case "sms":
        return "";
      case "voice":
        return "";
      case "canvas":
        return "";
      default:
        return "";
    }
  };

  const formatTimestamp = (ts: number) => {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
    return new Date(ts).toLocaleDateString();
  };

  if (loading) {
    return <div className="settings-loading">Loading companions...</div>;
  }

  return (
    <div className="nodes-settings">
      {!compact && (
        <div className="settings-section nodes-header-section">
          <div className="settings-section-header">
            <div>
              <h3>Mobile Companions</h3>
              <p className="settings-description">
                Connect iOS or Android devices as mobile companions for device-specific actions.
              </p>
            </div>
            <button className="button-secondary button-small" onClick={loadNodes}>
              Refresh
            </button>
          </div>
        </div>
      )}

      {nodes.length === 0 && (
        <div className="nodes-empty-card">
          <h4>How to Connect</h4>
          <ol>
            <li>Make sure the Control Plane is enabled and running</li>
            <li>Install the companion app on your iOS or Android device</li>
            <li>Enter the gateway URL and authentication token in the app</li>
            <li>The device will appear here once connected</li>
          </ol>
          <div className="nodes-connection-note">
            <p>
              <code>For local network: ws://{"<your-mac-ip>"}:18789</code>
            </p>
            <p>For remote access: Enable Tailscale or SSH tunnel in Control Plane settings</p>
          </div>
        </div>
      )}

      {nodes.length > 0 && (
        <div className="nodes-list">
          {nodes.map((node) => (
            <div
              key={node.id}
              className={`nodes-card ${selectedNode === node.id ? "is-active" : ""}`}
              onClick={() => setSelectedNode(selectedNode === node.id ? null : node.id)}
            >
              <div className="nodes-card-header">
                <div className="nodes-card-info">
                  <span className="nodes-platform-icon">{getPlatformIcon(node.platform)}</span>
                  <div>
                    <h4 className="nodes-card-title">{node.displayName}</h4>
                    <p className="nodes-card-subtitle">
                      {node.platform.toUpperCase()} · v{node.version}
                    </p>
                  </div>
                </div>
                <span className={`nodes-status ${node.isForeground ? "foreground" : "background"}`}>
                  {node.isForeground ? "Foreground" : "Background"}
                </span>
              </div>

              <div className="nodes-capabilities">
                {node.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className={`nodes-capability ${node.permissions?.[cap] ? "" : "denied"}`}
                    title={
                      node.permissions?.[cap] ? "Permission granted" : "Permission not granted"
                    }
                  >
                    {getCapabilityIcon(cap)} {cap}
                    {!node.permissions?.[cap] && " (denied)"}
                  </span>
                ))}
              </div>

              {selectedNode === node.id && (
                <div className="nodes-details">
                  <div className="nodes-detail-grid">
                    <div className="nodes-detail">
                      <span className="nodes-detail-label">Node ID</span>
                      <span className="nodes-detail-value nodes-detail-mono">{node.id}</span>
                    </div>
                    <div className="nodes-detail">
                      <span className="nodes-detail-label">Device ID</span>
                      <span className="nodes-detail-value nodes-detail-mono">
                        {node.deviceId || "N/A"}
                      </span>
                    </div>
                    <div className="nodes-detail">
                      <span className="nodes-detail-label">Connected</span>
                      <span className="nodes-detail-value">
                        {formatTimestamp(node.connectedAt)}
                      </span>
                    </div>
                    <div className="nodes-detail">
                      <span className="nodes-detail-label">Last Activity</span>
                      <span className="nodes-detail-value">
                        {formatTimestamp(node.lastActivityAt)}
                      </span>
                    </div>
                  </div>

                  <div className="nodes-test">
                    <h5>Test Commands</h5>
                    <div className="nodes-test-actions">
                      {node.commands.slice(0, 6).map((cmd) => (
                        <button
                          key={cmd}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTestCommand(node.id, cmd);
                          }}
                          disabled={testingCommand === `${node.id}:${cmd}`}
                          className="nodes-command-btn"
                        >
                          {testingCommand === `${node.id}:${cmd}` ? "Testing..." : cmd}
                        </button>
                      ))}
                    </div>
                  </div>

                  {testResult && testResult.nodeId === node.id && (
                    <div className={`nodes-result ${testResult.result.ok ? "success" : "error"}`}>
                      <p className="nodes-result-title">
                        {testResult.command}: {testResult.result.ok ? "Success" : "Failed"}
                      </p>
                      {testResult.result.error && (
                        <p className="nodes-result-error">{testResult.result.error.message}</p>
                      )}
                      {testResult.result.ok && testResult.result.payload != null && (
                        <pre className="nodes-result-pre">
                          {(() => {
                            try {
                              return JSON.stringify(testResult.result.payload, null, 2).slice(
                                0,
                                500,
                              );
                            } catch {
                              return "[Unable to serialize result]";
                            }
                          })()}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {nodes.length > 0 && !compact && (
        <div className="nodes-summary">
          <span className="nodes-summary-count">{nodes.length}</span> companion
          {nodes.length !== 1 ? "s" : ""} connected
          {" · "}
          <span className="nodes-summary-highlight">
            {nodes.filter((n) => n.isForeground).length}
          </span>{" "}
          in foreground
        </div>
      )}
    </div>
  );
}
