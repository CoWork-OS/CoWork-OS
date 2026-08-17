import { useCallback, useEffect, useState } from "react";
import type {
  AgentSecurityDiagnostic,
  AgentSecurityFinding,
  AgentSecurityFindingStatus,
  AgentSecurityInventoryItem,
  AgentSecurityRuntimeStatus,
} from "../../shared/agent-security";
import "./agent-security.css";

function formatTime(value?: number | string): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}

export function AgentSecurityPanel() {
  const [status, setStatus] = useState<AgentSecurityRuntimeStatus | null>(null);
  const [findings, setFindings] = useState<AgentSecurityFinding[]>([]);
  const [inventory, setInventory] = useState<AgentSecurityInventoryItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<AgentSecurityDiagnostic[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refreshRuntime = false) => {
    setError(null);
    try {
      const [runtime, recentFindings, agents, recentDiagnostics] = await Promise.all([
        window.electronAPI.agentSecurityGetStatus(refreshRuntime),
        window.electronAPI.agentSecurityListFindings({ limit: 50 }),
        refreshRuntime
          ? window.electronAPI.agentSecurityRefreshInventory().catch(() => [])
          : window.electronAPI.agentSecurityListInventory(),
        window.electronAPI.agentSecurityListDiagnostics(20),
      ]);
      setStatus(runtime);
      setFindings(recentFindings);
      setInventory(agents);
      setDiagnostics(recentDiagnostics);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load agent security status",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      await load(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Security action failed");
    } finally {
      setBusy(null);
    }
  };

  const updateFinding = async (findingId: string, nextStatus: AgentSecurityFindingStatus) => {
    setBusy(`finding:${findingId}`);
    setError(null);
    try {
      const updated = await window.electronAPI.agentSecurityUpdateFinding(findingId, nextStatus);
      if (updated) {
        setFindings((current) =>
          current.map((finding) => (finding.findingId === findingId ? updated : finding)),
        );
      }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Failed to update finding");
    } finally {
      setBusy(null);
    }
  };

  const manageHook = async (agent: AgentSecurityInventoryItem, install: boolean) => {
    const verb = install ? "install" : "uninstall";
    await runAction(`hook:${agent.agentId}`, async () => {
      const result = install
        ? await window.electronAPI.agentSecurityInstallHook(agent.agentId)
        : await window.electronAPI.agentSecurityUninstallHook(agent.agentId);
      return result.output || `Hook ${verb} completed for ${agent.agentId}.`;
    });
  };

  return (
    <div className="settings-panel agent-security-panel">
      <div className="agent-security-heading">
        <div>
          <h2>Agent Security</h2>
          <p className="settings-description">
            Inspect CoWork actions with Numbat, review findings, and explicitly manage supported
            external-agent hooks.
          </p>
        </div>
        <span
          className={`agent-security-health agent-security-health--${status?.health || "unknown"}`}
        >
          {status?.health || "loading"}
        </span>
      </div>

      {error && <div className="ap-message ap-error">{error}</div>}
      {message && <div className="ap-message ap-success">{message}</div>}

      <div className="agent-security-summary">
        <div>
          <span>Policy</span>
          <strong>{status?.enabled ? status.mode : "Disabled"}</strong>
        </div>
        <div>
          <span>Runtime</span>
          <strong>{status?.binaryVersion || "Unavailable"}</strong>
        </div>
        <div>
          <span>Open findings</span>
          <strong>{findings.filter((finding) => finding.status === "open").length}</strong>
        </div>
        <div>
          <span>Last check</span>
          <strong>{formatTime(status?.lastCheckedAt)}</strong>
        </div>
      </div>

      {status?.lastError && <p className="agent-security-runtime-error">{status.lastError}</p>}

      <div className="agent-security-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={busy !== null}
          onClick={() => void load(true)}
        >
          Refresh
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy !== null}
          onClick={() =>
            void runAction("rules", async () => {
              const result = await window.electronAPI.agentSecurityCheckRules();
              return result.output || "Rule validation passed.";
            })
          }
        >
          {busy === "rules" ? "Checking..." : "Check Rules"}
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={busy !== null}
          onClick={() =>
            void runAction("scan", async () => {
              const result = await window.electronAPI.agentSecurityScan();
              return `Scan completed with ${result.findings} finding${result.findings === 1 ? "" : "s"}.`;
            })
          }
        >
          {busy === "scan" ? "Scanning..." : "Run Scan"}
        </button>
      </div>

      <div className="settings-section">
        <h3>Recent Findings</h3>
        {findings.length === 0 ? (
          <p className="settings-description">No findings have been recorded.</p>
        ) : (
          <div className="agent-security-table-wrap">
            <table className="agent-security-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Rule</th>
                  <th>Finding</th>
                  <th>Detected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.findingId}>
                    <td>
                      <span
                        className={`agent-security-severity agent-security-severity--${finding.severity}`}
                      >
                        {finding.severity}
                      </span>
                    </td>
                    <td>{finding.ruleId}</td>
                    <td>{finding.title}</td>
                    <td>{formatTime(finding.detectedAt)}</td>
                    <td>
                      <select
                        className="ap-input"
                        value={finding.status}
                        disabled={busy === `finding:${finding.findingId}`}
                        onChange={(event) =>
                          void updateFinding(
                            finding.findingId,
                            event.target.value as AgentSecurityFindingStatus,
                          )
                        }
                      >
                        <option value="open">Open</option>
                        <option value="acknowledged">Acknowledged</option>
                        <option value="resolved">Resolved</option>
                        <option value="false_positive">False positive</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h3>External Agent Inventory</h3>
        {inventory.length === 0 ? (
          <p className="settings-description">
            No supported external agents were detected. Refresh requires an available Numbat
            runtime.
          </p>
        ) : (
          <div className="agent-security-inventory">
            {inventory.map((agent) => (
              <div className="agent-security-inventory-row" key={agent.agentId}>
                <div>
                  <strong>{agent.agentId}</strong>
                  <span>
                    {agent.present ? "Detected" : "Not detected"} ·{" "}
                    {agent.wired ? "Hook installed" : "Hook not installed"}
                    {agent.liveMode ? ` · ${agent.liveMode}` : ""}
                  </span>
                </div>
                {agent.present &&
                  agent.agentId !== "cowork" &&
                  agent.liveMode !== "none" &&
                  agent.liveMode !== "n/a" && (
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={busy !== null}
                      onClick={() => void manageHook(agent, !agent.wired)}
                    >
                      {busy === `hook:${agent.agentId}`
                        ? "Working..."
                        : agent.wired
                          ? "Uninstall Hook"
                          : "Install Hook"}
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>

      {diagnostics.length > 0 && (
        <details className="settings-section agent-security-diagnostics">
          <summary>Recent diagnostics ({diagnostics.length})</summary>
          {diagnostics.map((diagnostic) => (
            <p key={diagnostic.id}>
              <strong>{diagnostic.code}</strong> · {formatTime(diagnostic.createdAt)}
              <br />
              {diagnostic.message}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

export default AgentSecurityPanel;
