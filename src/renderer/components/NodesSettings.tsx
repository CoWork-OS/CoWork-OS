import { useState, useEffect, useCallback } from 'react';
import type { NodeInfo, NodeInvokeResult } from '../../shared/types';

interface NodesSettingsProps {
  compact?: boolean;
}

export function NodesSettings({ compact = false }: NodesSettingsProps) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [testingCommand, setTestingCommand] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ nodeId: string; command: string; result: NodeInvokeResult } | null>(null);

  const loadNodes = useCallback(async () => {
    try {
      const result = await window.electronAPI?.nodeList?.();
      if (result?.ok && result.nodes) {
        setNodes(result.nodes);
      } else {
        setNodes([]);
      }
    } catch (error) {
      console.error('Failed to load nodes:', error);
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
      if (event.type === 'connected' || event.type === 'disconnected' || event.type === 'capabilities_changed') {
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
        params: command === 'camera.snap' ? { facing: 'back', maxWidth: 640 } : undefined,
        timeoutMs: 30000,
      });

      setTestResult({
        nodeId,
        command,
        result: result || { ok: false, error: { code: 'UNKNOWN', message: 'No response' } },
      });
    } catch (error: any) {
      setTestResult({
        nodeId,
        command,
        result: { ok: false, error: { code: 'ERROR', message: error.message || 'Failed to invoke command' } },
      });
    } finally {
      setTestingCommand(null);
    }
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case 'ios':
        return ''; // Apple icon
      case 'android':
        return ''; // Android icon
      case 'macos':
        return '';
      default:
        return '';
    }
  };

  const getCapabilityIcon = (capability: string) => {
    switch (capability) {
      case 'camera':
        return '';
      case 'location':
        return '';
      case 'screen':
        return '';
      case 'sms':
        return '';
      case 'voice':
        return '';
      case 'canvas':
        return '';
      default:
        return '';
    }
  };

  const formatTimestamp = (ts: number) => {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
    return new Date(ts).toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium text-neutral-100">Mobile Companions</h3>
            <p className="text-sm text-neutral-400 mt-1">
              Connect iOS or Android devices as mobile companions for device-specific actions.
            </p>
          </div>
          <button
            onClick={loadNodes}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:text-neutral-100 bg-neutral-800 hover:bg-neutral-700 rounded-md transition-colors"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Connection Instructions */}
      {nodes.length === 0 && (
        <div className="bg-neutral-800/50 rounded-lg p-4 border border-neutral-700">
          <h4 className="text-sm font-medium text-neutral-200 mb-2">How to Connect</h4>
          <ol className="text-sm text-neutral-400 space-y-2 list-decimal list-inside">
            <li>Make sure the Control Plane is enabled and running</li>
            <li>Install the companion app on your iOS or Android device</li>
            <li>Enter the gateway URL and authentication token in the app</li>
            <li>The device will appear here once connected</li>
          </ol>
          <div className="mt-4 p-3 bg-neutral-900/50 rounded-md">
            <p className="text-xs text-neutral-500 font-mono">
              For local network: ws://{'<your-mac-ip>'}:18789
            </p>
            <p className="text-xs text-neutral-500 mt-1">
              For remote access: Enable Tailscale or SSH tunnel in Control Plane settings
            </p>
          </div>
        </div>
      )}

      {/* Node List */}
      {nodes.length > 0 && (
        <div className="space-y-3">
          {nodes.map((node) => (
            <div
              key={node.id}
              className={`bg-neutral-800/50 rounded-lg p-4 border transition-colors cursor-pointer ${
                selectedNode === node.id
                  ? 'border-accent-500'
                  : 'border-neutral-700 hover:border-neutral-600'
              }`}
              onClick={() => setSelectedNode(selectedNode === node.id ? null : node.id)}
            >
              {/* Node Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{getPlatformIcon(node.platform)}</span>
                  <div>
                    <h4 className="text-sm font-medium text-neutral-100">{node.displayName}</h4>
                    <p className="text-xs text-neutral-500">
                      {node.platform.toUpperCase()} · v{node.version}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${
                      node.isForeground
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                    }`}
                  >
                    {node.isForeground ? 'Foreground' : 'Background'}
                  </span>
                </div>
              </div>

              {/* Capabilities */}
              <div className="mt-3 flex flex-wrap gap-2">
                {node.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                      node.permissions?.[cap]
                        ? 'bg-neutral-700 text-neutral-300'
                        : 'bg-neutral-800 text-neutral-500'
                    }`}
                    title={node.permissions?.[cap] ? 'Permission granted' : 'Permission not granted'}
                  >
                    {getCapabilityIcon(cap)} {cap}
                    {!node.permissions?.[cap] && ' (denied)'}
                  </span>
                ))}
              </div>

              {/* Expanded Details */}
              {selectedNode === node.id && (
                <div className="mt-4 pt-4 border-t border-neutral-700 space-y-4">
                  {/* Connection Info */}
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <span className="text-neutral-500">Node ID</span>
                      <p className="text-neutral-300 font-mono mt-0.5 truncate">{node.id}</p>
                    </div>
                    <div>
                      <span className="text-neutral-500">Device ID</span>
                      <p className="text-neutral-300 font-mono mt-0.5 truncate">{node.deviceId || 'N/A'}</p>
                    </div>
                    <div>
                      <span className="text-neutral-500">Connected</span>
                      <p className="text-neutral-300 mt-0.5">{formatTimestamp(node.connectedAt)}</p>
                    </div>
                    <div>
                      <span className="text-neutral-500">Last Activity</span>
                      <p className="text-neutral-300 mt-0.5">{formatTimestamp(node.lastActivityAt)}</p>
                    </div>
                  </div>

                  {/* Test Commands */}
                  <div>
                    <h5 className="text-xs font-medium text-neutral-400 mb-2">Test Commands</h5>
                    <div className="flex flex-wrap gap-2">
                      {node.commands.slice(0, 6).map((cmd) => (
                        <button
                          key={cmd}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTestCommand(node.id, cmd);
                          }}
                          disabled={testingCommand === `${node.id}:${cmd}`}
                          className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {testingCommand === `${node.id}:${cmd}` ? 'Testing...' : cmd}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Test Result */}
                  {testResult && testResult.nodeId === node.id && (
                    <div
                      className={`p-3 rounded text-xs ${
                        testResult.result.ok
                          ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                          : 'bg-red-500/10 border border-red-500/30 text-red-400'
                      }`}
                    >
                      <p className="font-medium">
                        {testResult.command}: {testResult.result.ok ? 'Success' : 'Failed'}
                      </p>
                      {testResult.result.error && (
                        <p className="mt-1 text-red-300">
                          {testResult.result.error.message}
                        </p>
                      )}
                      {testResult.result.ok && testResult.result.payload != null && (
                        <pre className="mt-2 p-2 bg-neutral-900/50 rounded overflow-auto max-h-32">
                          {(() => {
                            try {
                              return JSON.stringify(testResult.result.payload, null, 2).slice(0, 500);
                            } catch {
                              return '[Unable to serialize result]';
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

      {/* Status Summary */}
      {nodes.length > 0 && !compact && (
        <div className="mt-4 p-3 bg-neutral-800/30 rounded-lg border border-neutral-700/50">
          <p className="text-xs text-neutral-400">
            <span className="text-accent-400 font-medium">{nodes.length}</span> companion{nodes.length !== 1 ? 's' : ''} connected
            {' · '}
            <span className="text-green-400">{nodes.filter(n => n.isForeground).length}</span> in foreground
          </p>
        </div>
      )}
    </div>
  );
}
