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
import { formatCount } from "../utils/plural";
import {
  agentMailApiKeyConfigured,
  agentMailErrorMessage,
  loadAgentMailInboxApiKeys,
  loadAgentMailListEntries,
  loadAgentMailPods,
} from "./agentmail-settings-model";
import "./agentmail-settings.css";

const DEFAULT_TIMEOUT_MS = 20000;

function formatTimestamp(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
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

  // Lists, inbox keys and pods come from the AgentMail API, so they wait for a saved
  // org API key instead of failing with "API key is not configured" on first open.
  const apiKeyConfigured = agentMailApiKeyConfigured(status);

  useEffect(() => {
    if (!selectedWorkspaceId || !apiKeyConfigured) {
      setListEntries([]);
      setApiKeys([]);
      return;
    }
    void loadLists(selectedWorkspaceId, selectedInboxId || undefined);
    if (selectedInboxId) {
      void loadApiKeys(selectedWorkspaceId, selectedInboxId);
    } else {
      setApiKeys([]);
    }
  }, [selectedWorkspaceId, selectedInboxId, apiKeyConfigured]);

  const loadBootstrap = async () => {
    setError(null);
    try {
      const [loadedSettings, loadedStatus, loadedWorkspaces] = await Promise.all([
        window.electronAPI.getAgentMailSettings(),
        window.electronAPI.getAgentMailStatus(),
        window.electronAPI.listWorkspaces(),
      ]);
      const loadedPods = await loadAgentMailPods(
        window.electronAPI,
        agentMailApiKeyConfigured(loadedStatus),
      );
      setSettings(loadedSettings);
      setStatus(loadedStatus);
      setPods(loadedPods);
      const stableWorkspaces = loadedWorkspaces.filter((workspace) => !workspace.isTemp);
      setWorkspaces(stableWorkspaces);
      const preferredWorkspaceId = stableWorkspaces[0]?.id || "";
      setSelectedWorkspaceId((current) => current || preferredWorkspaceId);
    } catch (err) {
      setError(agentMailErrorMessage(err));
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
      setError(agentMailErrorMessage(err));
    }
  };

  const loadLists = async (workspaceId: string, inboxId?: string) => {
    try {
      const entries = await loadAgentMailListEntries(window.electronAPI, apiKeyConfigured, {
        workspaceId,
        inboxId,
      });
      setListEntries(entries);
    } catch (err) {
      setError(agentMailErrorMessage(err));
    }
  };

  const loadApiKeys = async (workspaceId: string, inboxId: string) => {
    try {
      const keys = await loadAgentMailInboxApiKeys(window.electronAPI, apiKeyConfigured, {
        workspaceId,
        inboxId,
      });
      setApiKeys(keys);
    } catch (err) {
      setError(agentMailErrorMessage(err));
    }
  };

  const withBusy = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(agentMailErrorMessage(err));
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
          <h3>Connect AgentMail</h3>
          <div className="agentmail-header-actions">
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
        {error && (
          <p className="agentmail-message agentmail-message-error" role="alert">
            {error}
          </p>
        )}
        {!apiKeyConfigured && (
          <p className="agentmail-message">
            Add your org API key and save to load pods, lists, and inbox keys.
          </p>
        )}
        {testResult && (
          <div className={`test-result ${testResult.success ? "success" : "error"}`}>
            <span>
              {testResult.success
                ? `Connected. ${formatCount(testResult.podCount || 0, "pod")}, ${formatCount(
                    testResult.inboxCount || 0,
                    "inbox",
                    "inboxes",
                  )}.`
                : `Connection failed: ${testResult.error || "Unknown error"}`}
            </span>
          </div>
        )}
        {createdApiKey && (
          <p className="agentmail-message">
            New inbox key: <code>{createdApiKey}</code> (shown once only)
          </p>
        )}
        <div className="agentmail-toggles">
          <label className="agentmail-toggle-row">
            <span>Enable AgentMail</span>
            <span className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
              />
              <span className="toggle-slider" />
            </span>
          </label>
          <label className="agentmail-toggle-row">
            <span>Enable realtime WebSocket sync</span>
            <span className="settings-toggle">
              <input
                type="checkbox"
                checked={Boolean(settings.realtimeEnabled)}
                onChange={(event) =>
                  setSettings({ ...settings, realtimeEnabled: event.target.checked })
                }
              />
              <span className="toggle-slider" />
            </span>
          </label>
        </div>
        <div className="settings-form-grid two-columns agentmail-fields">
          <label className="settings-field agentmail-field-full">
            <span>Org API key</span>
            <input
              className="settings-input"
              type="password"
              value={settings.apiKey || ""}
              onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
              placeholder="am_..."
            />
          </label>
          <label className="settings-field">
            <span>Base URL</span>
            <input
              className="settings-input"
              type="text"
              value={settings.baseUrl || ""}
              onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
              placeholder="https://api.agentmail.to/v0"
            />
          </label>
          <label className="settings-field">
            <span>WebSocket URL</span>
            <input
              className="settings-input"
              type="text"
              value={settings.websocketUrl || ""}
              onChange={(event) => setSettings({ ...settings, websocketUrl: event.target.value })}
              placeholder="wss://api.agentmail.to/v0/websocket"
            />
          </label>
          <label className="settings-field">
            <span>Timeout (ms)</span>
            <input
              className="settings-input"
              type="number"
              value={settings.timeoutMs || DEFAULT_TIMEOUT_MS}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  timeoutMs: Number(event.target.value) || DEFAULT_TIMEOUT_MS,
                })
              }
            />
          </label>
        </div>
        <p className="agentmail-status-line">
          Status: {status?.connected ? "Connected" : "Not connected"} · Realtime:{" "}
          {status?.connectionState || "disconnected"} · Last event:{" "}
          {formatTimestamp(status?.lastEventAt)}
        </p>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Workspace pod</h3>
          <button
            className="btn-secondary btn-sm"
            onClick={refreshWorkspace}
            disabled={!selectedWorkspaceId || busy !== null}
          >
            {busy === "refresh-workspace" ? "Refreshing..." : "Refresh Workspace"}
          </button>
        </div>
        <div className="settings-form-grid two-columns agentmail-fields">
          <label className="settings-field">
            <span>Workspace</span>
            <select
              className="settings-select"
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <div className="settings-field">
            <span>Bound pod</span>
            <div className={`agentmail-readonly${binding ? "" : " is-empty"}`}>
              {binding ? `${binding.podName || binding.podId} (${binding.podId})` : "Not bound"}
            </div>
          </div>
          <label className="settings-field">
            <span>Bind existing pod</span>
            <select
              className="settings-select"
              value={workspacePodChoice}
              onChange={(event) => setWorkspacePodChoice(event.target.value)}
            >
              <option value="">
                {apiKeyConfigured ? "Select pod..." : "Add an API key to list pods"}
              </option>
              {pods.map((pod) => (
                <option key={pod.podId} value={pod.podId}>
                  {pod.name || pod.podId}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>New pod name</span>
            <input
              className="settings-input"
              type="text"
              value={workspacePodName}
              onChange={(event) => setWorkspacePodName(event.target.value)}
              placeholder="Acme workspace"
            />
          </label>
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
        </div>
        <p className="settings-description">
          Inbox Agent shows the <code>agentmail</code> provider badge on threads from these inboxes.
        </p>
        <div className="settings-form-grid two-columns agentmail-fields">
          <label className="settings-field">
            <span>Username</span>
            <input
              className="settings-input"
              type="text"
              value={inboxForm.username}
              onChange={(event) => setInboxForm({ ...inboxForm, username: event.target.value })}
              placeholder="support"
            />
          </label>
          <label className="settings-field">
            <span>Domain</span>
            <input
              className="settings-input"
              type="text"
              value={inboxForm.domain}
              onChange={(event) => setInboxForm({ ...inboxForm, domain: event.target.value })}
              placeholder="example.com"
            />
          </label>
          <label className="settings-field">
            <span>Display name</span>
            <input
              className="settings-input"
              type="text"
              value={inboxForm.displayName}
              onChange={(event) => setInboxForm({ ...inboxForm, displayName: event.target.value })}
              placeholder="Support"
            />
          </label>
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
        <div className="agentmail-item-list">
          {inboxes.map((inbox) => (
            <div
              key={inbox.inboxId}
              className={`agentmail-item${selectedInboxId === inbox.inboxId ? " is-selected" : ""}`}
            >
              <div className="agentmail-item-main">
                <div className="agentmail-item-title">
                  {inbox.displayName || inbox.email || inbox.inboxId}
                </div>
                <div className="agentmail-item-meta">{inbox.inboxId}</div>
              </div>
              <div className="agentmail-item-actions">
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
            <p className="agentmail-empty">No inboxes yet for this workspace pod.</p>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Domains</h3>
        </div>
        <div className="settings-form-grid two-columns agentmail-fields">
          <label className="settings-field">
            <span>Domain</span>
            <input
              className="settings-input"
              type="text"
              value={domainForm.domain}
              onChange={(event) => setDomainForm({ ...domainForm, domain: event.target.value })}
              placeholder="example.com"
            />
          </label>
          <label className="agentmail-toggle-row agentmail-toggle-inline">
            <span>Feedback enabled</span>
            <span className="settings-toggle">
              <input
                type="checkbox"
                checked={domainForm.feedbackEnabled}
                onChange={(event) =>
                  setDomainForm({ ...domainForm, feedbackEnabled: event.target.checked })
                }
              />
              <span className="toggle-slider" />
            </span>
          </label>
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
        <div className="agentmail-item-list">
          {domains.map((domain) => (
            <div key={domain.domainId} className="agentmail-item">
              <div className="agentmail-item-main">
                <div className="agentmail-item-title">
                  {domain.domain}{" "}
                  <span className="agentmail-item-meta">({domain.status || "unknown"})</span>
                </div>
                {domain.records.length > 0 && (
                  <div className="agentmail-records">
                    {domain.records.map((record, index) => (
                      <div key={`${domain.domainId}-${index}`} className="agentmail-item-meta">
                        {record.type} {record.name} → {record.value}{" "}
                        {record.status ? `(${record.status})` : ""}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="agentmail-item-actions">
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
          {domains.length === 0 && <p className="agentmail-empty">No custom domains yet.</p>}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Lists and inbox keys</h3>
        </div>
        <div className="settings-form-grid two-columns agentmail-fields">
          <label className="settings-field">
            <span>Inbox scope</span>
            <select
              className="settings-select"
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
          </label>
          <label className="settings-field">
            <span>Direction</span>
            <select
              className="settings-select"
              value={listForm.direction}
              onChange={(event) =>
                setListForm({
                  ...listForm,
                  direction: event.target.value as AgentMailListEntry["direction"],
                })
              }
            >
              <option value="receive">Receive</option>
              <option value="reply">Reply</option>
              <option value="send">Send</option>
            </select>
          </label>
          <label className="settings-field">
            <span>Type</span>
            <select
              className="settings-select"
              value={listForm.listType}
              onChange={(event) =>
                setListForm({
                  ...listForm,
                  listType: event.target.value as AgentMailListEntry["listType"],
                })
              }
            >
              <option value="allow">Allow</option>
              <option value="block">Block</option>
            </select>
          </label>
          <label className="settings-field">
            <span>Entry</span>
            <input
              className="settings-input"
              type="text"
              value={listForm.entry}
              onChange={(event) => setListForm({ ...listForm, entry: event.target.value })}
              placeholder="vip@example.com or example.com"
            />
          </label>
          <label className="settings-field">
            <span>Reason</span>
            <input
              className="settings-input"
              type="text"
              value={listForm.reason}
              onChange={(event) => setListForm({ ...listForm, reason: event.target.value })}
              placeholder="Optional"
            />
          </label>
        </div>
        <div className="settings-actions">
          <button className="btn-primary btn-sm" onClick={createListEntry} disabled={busy !== null}>
            {busy === "create-list-entry" ? "Saving..." : "Add List Entry"}
          </button>
        </div>
        <div className="agentmail-item-list">
          {listEntries.map((entry) => (
            <div
              key={`${entry.inboxId || "org"}:${entry.direction}:${entry.listType}:${entry.entry}`}
              className="agentmail-item"
            >
              <div className="agentmail-item-main">
                <div className="agentmail-item-title">
                  {entry.entry}{" "}
                  <span className="agentmail-item-meta">
                    ({entry.direction}/{entry.listType})
                  </span>
                </div>
                {entry.reason && <div className="agentmail-item-meta">{entry.reason}</div>}
              </div>
              <div className="agentmail-item-actions">
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
            <p className="agentmail-empty">
              {apiKeyConfigured
                ? "No list entries for this scope."
                : "Add your API key to manage allow and block lists."}
            </p>
          )}
        </div>

        <div className="agentmail-subsection">
          <div className="settings-form-grid two-columns agentmail-fields">
            <label className="settings-field">
              <span>New inbox API key name</span>
              <input
                className="settings-input"
                type="text"
                value={apiKeyName}
                onChange={(event) => setApiKeyName(event.target.value)}
                placeholder="support-agent-key"
              />
            </label>
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
          <div className="agentmail-item-list">
            {apiKeys.map((apiKey) => (
              <div key={apiKey.apiKeyId} className="agentmail-item">
                <div className="agentmail-item-main">
                  <div className="agentmail-item-title">{apiKey.name || apiKey.prefix}</div>
                  <div className="agentmail-item-meta">
                    {apiKey.prefix} · {formatTimestamp(apiKey.createdAt)}
                  </div>
                </div>
                <div className="agentmail-item-actions">
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
              <p className="agentmail-empty">
                {apiKeyConfigured
                  ? "No inbox-scoped API keys for the selected inbox."
                  : "Add your API key to manage inbox keys."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
