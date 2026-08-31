import { useEffect, useState } from "react";
import type {
  AgentMailApiKeySummary,
  AgentMailDomain,
  AgentMailInbox,
  AgentMailListEntry,
  AgentMailPod,
  AgentMailSettingsData,
  AgentMailStatus,
  AgentMailWorkspaceBinding,
  Workspace,
} from "../../shared/types";

const DEFAULT_TIMEOUT_MS = 20000;

function formatTimestamp(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentMailSettings() {
  const [settings, setSettings] = useState<AgentMailSettingsData | null>(null);
  const [status, setStatus] = useState<AgentMailStatus | null>(null);
  const [pods, setPods] = useState<AgentMailPod[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [binding, setBinding] = useState<AgentMailWorkspaceBinding | null>(null);
  const [inboxes, setInboxes] = useState<AgentMailInbox[]>([]);
  const [domains, setDomains] = useState<AgentMailDomain[]>([]);
  const [selectedInboxId, setSelectedInboxId] = useState<string>("");
  const [listEntries, setListEntries] = useState<AgentMailListEntry[]>([]);
  const [apiKeys, setApiKeys] = useState<AgentMailApiKeySummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdApiKey, setCreatedApiKey] = useState<string | null>(null);
  const [workspacePodChoice, setWorkspacePodChoice] = useState<string>("");
  const [workspacePodName, setWorkspacePodName] = useState<string>("");
  const [inboxForm, setInboxForm] = useState({
    username: "",
    domain: "",
    displayName: "",
  });
  const [domainForm, setDomainForm] = useState({
    domain: "",
    feedbackEnabled: true,
  });
  const [listForm, setListForm] = useState<{
    direction: AgentMailListEntry["direction"];
    listType: AgentMailListEntry["listType"];
    entry: string;
    reason: string;
  }>({
    direction: "receive",
    listType: "allow",
    entry: "",
    reason: "",
  });
  const [apiKeyName, setApiKeyName] = useState("");
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    podCount?: number;
    inboxCount?: number;
  } | null>(null);

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void loadWorkspace(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    void loadLists(selectedWorkspaceId, selectedInboxId || undefined);
    if (selectedInboxId) {
      void loadApiKeys(selectedWorkspaceId, selectedInboxId);
    } else {
      setApiKeys([]);
    }
  }, [selectedWorkspaceId, selectedInboxId]);

  const loadBootstrap = async () => {
    setError(null);
    try {
      const [loadedSettings, loadedStatus, loadedPods, loadedWorkspaces] = await Promise.all([
        window.electronAPI.getAgentMailSettings(),
        window.electronAPI.getAgentMailStatus(),
        window.electronAPI.listAgentMailPods().catch(() => []),
        window.electronAPI.listWorkspaces(),
      ]);
      setSettings(loadedSettings);
      setStatus(loadedStatus);
      setPods(loadedPods);
      const stableWorkspaces = loadedWorkspaces.filter((workspace) => !workspace.isTemp);
      setWorkspaces(stableWorkspaces);
      const preferredWorkspaceId = stableWorkspaces[0]?.id || "";
      setSelectedWorkspaceId((current) => current || preferredWorkspaceId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadWorkspace = async (workspaceId: string) => {
    setError(null);
    try {
      const [loadedBinding, loadedInboxes, loadedDomains] = await Promise.all([
        window.electronAPI.getAgentMailWorkspaceBinding(workspaceId),
        window.electronAPI.listAgentMailInboxes(workspaceId),
        window.electronAPI.listAgentMailDomains(workspaceId),
      ]);
      setBinding(loadedBinding);
      setInboxes(loadedInboxes);
      setDomains(loadedDomains);
      setWorkspacePodChoice(loadedBinding?.podId || "");
      setSelectedInboxId((current) =>
        current && loadedInboxes.some((inbox) => inbox.inboxId === current)
          ? current
          : loadedInboxes[0]?.inboxId || "",
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadLists = async (workspaceId: string, inboxId?: string) => {
    try {
      const entries = await window.electronAPI.listAgentMailListEntries({ workspaceId, inboxId });
      setListEntries(entries);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const loadApiKeys = async (workspaceId: string, inboxId: string) => {
    try {
      const keys = await window.electronAPI.listAgentMailInboxApiKeys({ workspaceId, inboxId });
      setApiKeys(keys);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const withBusy = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    await withBusy("save-settings", async () => {
      await window.electronAPI.saveAgentMailSettings(settings);
      await loadBootstrap();
    });
  };

  const testConnection = async () => {
    await withBusy("test-connection", async () => {
      const result = await window.electronAPI.testAgentMailConnection();
      setTestResult(result);
      await loadBootstrap();
    });
  };

  const refreshWorkspace = async () => {
    if (!selectedWorkspaceId) return;
    await withBusy("refresh-workspace", async () => {
      await window.electronAPI.refreshAgentMailWorkspace(selectedWorkspaceId);
      await loadWorkspace(selectedWorkspaceId);
      await loadBootstrap();
    });
  };

  const bindWorkspacePod = async () => {
    if (!selectedWorkspaceId || !workspacePodChoice) return;
    await withBusy("bind-pod", async () => {
      await window.electronAPI.bindAgentMailWorkspacePod({
        workspaceId: selectedWorkspaceId,
        podId: workspacePodChoice,
      });
      await loadWorkspace(selectedWorkspaceId);
      await loadBootstrap();
    });
  };

  const createWorkspacePod = async () => {
    if (!selectedWorkspaceId) return;
    await withBusy("create-pod", async () => {
      await window.electronAPI.createAgentMailWorkspacePod({
        workspaceId: selectedWorkspaceId,
        podName: workspacePodName || undefined,
      });
      setWorkspacePodName("");
      await loadWorkspace(selectedWorkspaceId);
      await loadBootstrap();
    });
  };

  const createInbox = async () => {
    if (!selectedWorkspaceId) return;
    await withBusy("create-inbox", async () => {
      await window.electronAPI.createAgentMailInbox({
        workspaceId: selectedWorkspaceId,
        username: inboxForm.username || undefined,
        domain: inboxForm.domain || undefined,
        displayName: inboxForm.displayName || undefined,
      });
      setInboxForm({ username: "", domain: "", displayName: "" });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const renameInbox = async (inbox: AgentMailInbox) => {
    const nextDisplayName = window.prompt(
      "Display name",
      inbox.displayName || inbox.email || inbox.inboxId,
    );
    if (!nextDisplayName || !selectedWorkspaceId) return;
    await withBusy(`rename-${inbox.inboxId}`, async () => {
      await window.electronAPI.updateAgentMailInbox({
        workspaceId: selectedWorkspaceId,
        inboxId: inbox.inboxId,
        displayName: nextDisplayName,
      });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const deleteInbox = async (inbox: AgentMailInbox) => {
    if (!selectedWorkspaceId) return;
    if (!window.confirm(`Delete inbox ${inbox.email || inbox.inboxId}?`)) return;
    await withBusy(`delete-${inbox.inboxId}`, async () => {
      await window.electronAPI.deleteAgentMailInbox({
        workspaceId: selectedWorkspaceId,
        inboxId: inbox.inboxId,
      });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const createDomain = async () => {
    if (!selectedWorkspaceId || !domainForm.domain) return;
    await withBusy("create-domain", async () => {
      await window.electronAPI.createAgentMailDomain({
        workspaceId: selectedWorkspaceId,
        domain: domainForm.domain,
        feedbackEnabled: domainForm.feedbackEnabled,
      });
      setDomainForm({ domain: "", feedbackEnabled: true });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const verifyDomain = async (domain: AgentMailDomain) => {
    if (!selectedWorkspaceId) return;
    await withBusy(`verify-${domain.domainId}`, async () => {
      await window.electronAPI.verifyAgentMailDomain({
        workspaceId: selectedWorkspaceId,
        domainId: domain.domainId,
      });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const deleteDomain = async (domain: AgentMailDomain) => {
    if (!selectedWorkspaceId) return;
    if (!window.confirm(`Delete domain ${domain.domain || domain.domainId}?`)) return;
    await withBusy(`delete-domain-${domain.domainId}`, async () => {
      await window.electronAPI.deleteAgentMailDomain({
        workspaceId: selectedWorkspaceId,
        domainId: domain.domainId,
      });
      await loadWorkspace(selectedWorkspaceId);
    });
  };

  const createListEntry = async () => {
    if (!selectedWorkspaceId || !listForm.entry) return;
    await withBusy("create-list-entry", async () => {
      await window.electronAPI.createAgentMailListEntry({
        workspaceId: selectedWorkspaceId,
        inboxId: selectedInboxId || undefined,
        direction: listForm.direction,
        listType: listForm.listType,
        entry: listForm.entry,
        reason: listForm.reason || undefined,
      });
      setListForm((current) => ({ ...current, entry: "", reason: "" }));
      await loadLists(selectedWorkspaceId, selectedInboxId || undefined);
    });
  };

  const deleteListEntry = async (entry: AgentMailListEntry) => {
    if (!selectedWorkspaceId) return;
    await withBusy(`delete-list-${entry.entry}`, async () => {
      await window.electronAPI.deleteAgentMailListEntry({
        workspaceId: selectedWorkspaceId,
        inboxId: entry.inboxId || undefined,
        direction: entry.direction,
        listType: entry.listType,
        entry: entry.entry,
      });
      await loadLists(selectedWorkspaceId, selectedInboxId || undefined);
    });
  };

  const createApiKey = async () => {
    if (!selectedWorkspaceId || !selectedInboxId) return;
    await withBusy("create-api-key", async () => {
      const result = await window.electronAPI.createAgentMailInboxApiKey({
        workspaceId: selectedWorkspaceId,
        inboxId: selectedInboxId,
        name: apiKeyName || undefined,
      });
      setCreatedApiKey(result.apiKey || null);
      setApiKeyName("");
      await loadApiKeys(selectedWorkspaceId, selectedInboxId);
    });
  };

  const deleteApiKey = async (apiKey: AgentMailApiKeySummary) => {
    if (!selectedWorkspaceId || !selectedInboxId) return;
    await withBusy(`delete-api-key-${apiKey.apiKeyId}`, async () => {
      await window.electronAPI.deleteAgentMailInboxApiKey({
        workspaceId: selectedWorkspaceId,
        inboxId: selectedInboxId,
        apiKeyId: apiKey.apiKeyId,
      });
      await loadApiKeys(selectedWorkspaceId, selectedInboxId);
    });
  };

  if (!settings) {
    return <div className="settings-loading">Loading AgentMail settings...</div>;
  }

  return (
    <div className="agentmail-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>AgentMail</h3>
          <div className="settings-actions">
            <button
              className="btn-secondary btn-sm"
              onClick={testConnection}
              disabled={busy !== null}
            >
              {busy === "test-connection" ? "Testing..." : "Test Connection"}
            </button>
            <button className="btn-primary btn-sm" onClick={saveSettings} disabled={busy !== null}>
              {busy === "save-settings" ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
        <p className="settings-description">
          Native AgentMail support for workspace pods, inbox provisioning, domains, lists,
          inbox-scoped API keys, REST sync, and realtime event streaming.
        </p>
        {error && <p className="settings-hint">Error: {error}</p>}
        {testResult && (
          <p className="settings-hint">
            {testResult.success
              ? `Connected. ${testResult.podCount || 0} pod(s), ${testResult.inboxCount || 0} inbox(es).`
              : `Connection failed: ${testResult.error || "Unknown error"}`}
          </p>
        )}
        {createdApiKey && (
          <p className="settings-hint">
            New inbox key: <code>{createdApiKey}</code> (shown once only)
          </p>
        )}
        <div className="settings-grid">
          <div className="setting-item">
            <label>Enable AgentMail</label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
          </div>
          <div className="setting-item">
            <label>Enable realtime WebSocket sync</label>
            <input
              type="checkbox"
              checked={Boolean(settings.realtimeEnabled)}
              onChange={(event) =>
                setSettings({ ...settings, realtimeEnabled: event.target.checked })
              }
            />
          </div>
          <div className="setting-item">
            <label>Org API Key</label>
            <input
              type="password"
              value={settings.apiKey || ""}
              onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
              placeholder="am_..."
            />
          </div>
          <div className="setting-item">
            <label>Base URL</label>
            <input
              type="text"
              value={settings.baseUrl || ""}
              onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
              placeholder="https://api.agentmail.to/v0"
            />
          </div>
          <div className="setting-item">
            <label>WebSocket URL</label>
            <input
              type="text"
              value={settings.websocketUrl || ""}
              onChange={(event) => setSettings({ ...settings, websocketUrl: event.target.value })}
              placeholder="wss://api.agentmail.to/v0/websocket"
            />
          </div>
          <div className="setting-item">
            <label>Timeout (ms)</label>
            <input
              type="number"
              value={settings.timeoutMs || DEFAULT_TIMEOUT_MS}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  timeoutMs: Number(event.target.value) || DEFAULT_TIMEOUT_MS,
                })
              }
            />
          </div>
        </div>
        <div className="settings-hint">
          Status: {status?.connected ? "Connected" : "Not connected"} · Realtime:{" "}
          {status?.connectionState || "disconnected"} · Last event:{" "}
          {formatTimestamp(status?.lastEventAt)}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Workspace Pod Binding</h3>
          <button
            className="btn-secondary btn-sm"
            onClick={refreshWorkspace}
            disabled={!selectedWorkspaceId || busy !== null}
          >
            {busy === "refresh-workspace" ? "Refreshing..." : "Refresh Workspace"}
          </button>
        </div>
        <div className="settings-grid">
          <div className="setting-item">
            <label>Workspace</label>
            <select
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-item">
            <label>Bound pod</label>
            <div>
              {binding ? `${binding.podName || binding.podId} (${binding.podId})` : "Not bound"}
            </div>
          </div>
          <div className="setting-item">
            <label>Bind existing pod</label>
            <select
              value={workspacePodChoice}
              onChange={(event) => setWorkspacePodChoice(event.target.value)}
            >
              <option value="">Select pod...</option>
              {pods.map((pod) => (
                <option key={pod.podId} value={pod.podId}>
                  {pod.name || pod.podId}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-item">
            <label>New pod name</label>
            <input
              type="text"
              value={workspacePodName}
              onChange={(event) => setWorkspacePodName(event.target.value)}
              placeholder="Acme workspace"
            />
          </div>
        </div>
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={bindWorkspacePod}
            disabled={!workspacePodChoice || busy !== null}
          >
            {busy === "bind-pod" ? "Binding..." : "Bind Pod"}
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={createWorkspacePod}
            disabled={!selectedWorkspaceId || busy !== null}
          >
            {busy === "create-pod" ? "Creating..." : "Create Pod"}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Inboxes</h3>
          <div className="settings-hint">
            Provider badge in Inbox Agent will show `agentmail` for these threads.
          </div>
        </div>
        <div className="settings-grid">
          <div className="setting-item">
            <label>Username</label>
            <input
              type="text"
              value={inboxForm.username}
              onChange={(event) => setInboxForm({ ...inboxForm, username: event.target.value })}
              placeholder="support"
            />
          </div>
          <div className="setting-item">
            <label>Domain</label>
            <input
              type="text"
              value={inboxForm.domain}
              onChange={(event) => setInboxForm({ ...inboxForm, domain: event.target.value })}
              placeholder="example.com"
            />
          </div>
          <div className="setting-item">
            <label>Display name</label>
            <input
              type="text"
              value={inboxForm.displayName}
              onChange={(event) => setInboxForm({ ...inboxForm, displayName: event.target.value })}
              placeholder="Support"
            />
          </div>
        </div>
        <div className="settings-actions">
          <button
            className="btn-primary btn-sm"
            onClick={createInbox}
            disabled={!binding || busy !== null}
          >
            {busy === "create-inbox" ? "Creating..." : "Create Inbox"}
          </button>
        </div>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {inboxes.map((inbox) => (
            <div
              key={inbox.inboxId}
              className="setting-item"
              style={{
                border: "1px solid var(--color-border-subtle)",
                padding: 12,
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {inbox.displayName || inbox.email || inbox.inboxId}
              </div>
              <div className="settings-hint">{inbox.inboxId}</div>
              <div className="settings-actions">
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => renameInbox(inbox)}
                  disabled={busy !== null}
                >
                  Rename
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => setSelectedInboxId(inbox.inboxId)}
                >
                  {selectedInboxId === inbox.inboxId ? "Selected" : "Manage"}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => deleteInbox(inbox)}
                  disabled={busy !== null}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {inboxes.length === 0 && (
            <div className="settings-hint">No inboxes yet for this workspace pod.</div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Domains</h3>
        </div>
        <div className="settings-grid">
          <div className="setting-item">
            <label>Domain</label>
            <input
              type="text"
              value={domainForm.domain}
              onChange={(event) => setDomainForm({ ...domainForm, domain: event.target.value })}
              placeholder="example.com"
            />
          </div>
          <div className="setting-item">
            <label>Feedback enabled</label>
            <input
              type="checkbox"
              checked={domainForm.feedbackEnabled}
              onChange={(event) =>
                setDomainForm({ ...domainForm, feedbackEnabled: event.target.checked })
              }
            />
          </div>
        </div>
        <div className="settings-actions">
          <button
            className="btn-primary btn-sm"
            onClick={createDomain}
            disabled={!binding || busy !== null}
          >
            {busy === "create-domain" ? "Creating..." : "Create Domain"}
          </button>
        </div>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {domains.map((domain) => (
            <div
              key={domain.domainId}
              className="setting-item"
              style={{
                border: "1px solid var(--color-border-subtle)",
                padding: 12,
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {domain.domain}{" "}
                <span className="settings-hint">({domain.status || "unknown"})</span>
              </div>
              <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
                {domain.records.map((record, index) => (
                  <div key={`${domain.domainId}-${index}`} className="settings-hint">
                    {record.type} {record.name} → {record.value}{" "}
                    {record.status ? `(${record.status})` : ""}
                  </div>
                ))}
              </div>
              <div className="settings-actions">
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => verifyDomain(domain)}
                  disabled={busy !== null}
                >
                  Verify
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => deleteDomain(domain)}
                  disabled={busy !== null}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {domains.length === 0 && <div className="settings-hint">No custom domains yet.</div>}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Lists And Inbox Keys</h3>
        </div>
        <div className="settings-grid">
          <div className="setting-item">
            <label>Inbox scope</label>
            <select
              value={selectedInboxId}
              onChange={(event) => setSelectedInboxId(event.target.value)}
            >
              <option value="">Organization scope</option>
              {inboxes.map((inbox) => (
                <option key={inbox.inboxId} value={inbox.inboxId}>
                  {inbox.email || inbox.inboxId}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-item">
            <label>Direction</label>
            <select
              value={listForm.direction}
              onChange={(event) =>
                setListForm({
                  ...listForm,
                  direction: event.target.value as AgentMailListEntry["direction"],
                })
              }
            >
              <option value="receive">receive</option>
              <option value="reply">reply</option>
              <option value="send">send</option>
            </select>
          </div>
          <div className="setting-item">
            <label>Type</label>
            <select
              value={listForm.listType}
              onChange={(event) =>
                setListForm({
                  ...listForm,
                  listType: event.target.value as AgentMailListEntry["listType"],
                })
              }
            >
              <option value="allow">allow</option>
              <option value="block">block</option>
            </select>
          </div>
          <div className="setting-item">
            <label>Entry</label>
            <input
              type="text"
              value={listForm.entry}
              onChange={(event) => setListForm({ ...listForm, entry: event.target.value })}
              placeholder="vip@example.com or example.com"
            />
          </div>
          <div className="setting-item">
            <label>Reason</label>
            <input
              type="text"
              value={listForm.reason}
              onChange={(event) => setListForm({ ...listForm, reason: event.target.value })}
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="settings-actions">
          <button className="btn-primary btn-sm" onClick={createListEntry} disabled={busy !== null}>
            {busy === "create-list-entry" ? "Saving..." : "Add List Entry"}
          </button>
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {listEntries.map((entry) => (
            <div
              key={`${entry.inboxId || "org"}:${entry.direction}:${entry.listType}:${entry.entry}`}
              className="setting-item"
              style={{
                border: "1px solid var(--color-border-subtle)",
                padding: 10,
                borderRadius: 10,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                {entry.entry}{" "}
                <span className="settings-hint">
                  ({entry.direction}/{entry.listType})
                </span>
              </div>
              {entry.reason && <div className="settings-hint">{entry.reason}</div>}
              <div className="settings-actions">
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => deleteListEntry(entry)}
                  disabled={busy !== null}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {listEntries.length === 0 && (
            <div className="settings-hint">No list entries for this scope.</div>
          )}
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="settings-grid">
            <div className="setting-item">
              <label>New inbox API key name</label>
              <input
                type="text"
                value={apiKeyName}
                onChange={(event) => setApiKeyName(event.target.value)}
                placeholder="support-agent-key"
              />
            </div>
          </div>
          <div className="settings-actions">
            <button
              className="btn-primary btn-sm"
              onClick={createApiKey}
              disabled={!selectedInboxId || busy !== null}
            >
              {busy === "create-api-key" ? "Creating..." : "Create Inbox API Key"}
            </button>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {apiKeys.map((apiKey) => (
              <div
                key={apiKey.apiKeyId}
                className="setting-item"
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  padding: 10,
                  borderRadius: 10,
                }}
              >
                <div style={{ fontWeight: 600 }}>{apiKey.name || apiKey.prefix}</div>
                <div className="settings-hint">
                  {apiKey.prefix} · {formatTimestamp(apiKey.createdAt)}
                </div>
                <div className="settings-actions">
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => deleteApiKey(apiKey)}
                    disabled={busy !== null}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {selectedInboxId && apiKeys.length === 0 && (
              <div className="settings-hint">No inbox-scoped API keys for the selected inbox.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
