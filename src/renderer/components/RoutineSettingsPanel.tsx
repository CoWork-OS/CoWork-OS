import { useEffect, useMemo, useState } from "react";
import { Cable, Clock3, Link2, Pencil, Play, Plus, Save, Trash2, Workflow } from "lucide-react";

type CronSchedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "at"; atMs: number };

type RoutineTrigger =
  | {
      id: string;
      type: "schedule";
      enabled: boolean;
      schedule: CronSchedule;
      managedCronJobId?: string;
    }
  | {
      id: string;
      type: "api";
      enabled: boolean;
      path?: string;
      token?: string;
      managedHookMappingId?: string;
    }
  | {
      id: string;
      type: "connector_event";
      enabled: boolean;
      connectorId: string;
      changeType?: string;
      resourceUriContains?: string;
      cooldownMs?: number;
      managedEventTriggerId?: string;
    }
  | {
      id: string;
      type: "channel_event";
      enabled: boolean;
      channelType?: string;
      chatId?: string;
      textContains?: string;
      senderContains?: string;
      cooldownMs?: number;
      managedEventTriggerId?: string;
    }
  | {
      id: string;
      type: "mailbox_event";
      enabled: boolean;
      eventType?: string;
      subjectContains?: string;
      provider?: string;
      labelContains?: string;
      cooldownMs?: number;
      managedEventTriggerId?: string;
    }
  | {
      id: string;
      type: "github_event";
      enabled: boolean;
      eventName?: string;
      repository?: string;
      action?: string;
      ref?: string;
      cooldownMs?: number;
      managedEventTriggerId?: string;
    }
  | {
      id: string;
      type: "manual";
      enabled: boolean;
    };

type RoutineOutput =
  | { kind: "task_only" }
  | {
      kind: "channel_message";
      channelType?: string;
      channelDbId?: string;
      channelId?: string;
      summaryOnly?: boolean;
      deliverOnSuccess?: boolean;
      deliverOnError?: boolean;
    }
  | {
      kind: "webhook_response";
      statusCode?: number;
      message?: string;
      includeTaskId?: boolean;
    };

type RoutineRun = {
  id: string;
  routineId: string;
  triggerType: RoutineTrigger["type"];
  status: string;
  outputStatus: string;
  startedAt: number;
  finishedAt?: number;
  sourceEventSummary?: string;
  backingTaskId?: string;
  backingManagedSessionId?: string;
  errorSummary?: string;
  artifactsSummary?: string;
};

type Routine = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspaceId: string;
  instructions: string;
  prompt: string;
  executionTarget: {
    kind: "workspace" | "worktree" | "device" | "managed_environment";
    deviceId?: string;
    managedEnvironmentId?: string;
  };
  connectorPolicy: {
    mode: "prefer" | "allowlist";
    connectorIds: string[];
  };
  approvalPolicy: {
    mode: "inherit" | "auto_safe" | "confirm_external" | "strict_confirm";
  };
  outputs: RoutineOutput[];
  triggers: RoutineTrigger[];
  createdAt: number;
  updatedAt: number;
};

type Workspace = {
  id: string;
  name: string;
  path: string;
};

type HookStatus = {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
};

type HookSettings = {
  path: string;
  host?: string;
  port?: number;
};

type MCPServerStatus = {
  id: string;
  name: string;
  status: string;
};

type RoutineFormState = {
  enabled: boolean;
  name: string;
  description: string;
  workspaceId: string;
  instructions: string;
  executionTargetKind: Routine["executionTarget"]["kind"];
  deviceId: string;
  managedEnvironmentId: string;
  connectorPolicyMode: Routine["connectorPolicy"]["mode"];
  connectorIds: string[];
  approvalMode: Routine["approvalPolicy"]["mode"];
  outputTaskOnly: boolean;
  outputChannelMessage: boolean;
  outputChannelType: string;
  outputChannelId: string;
  outputSummaryOnly: boolean;
  outputDeliverOnSuccess: boolean;
  outputDeliverOnError: boolean;
  outputWebhookResponse: boolean;
  outputWebhookStatusCode: number;
  outputWebhookMessage: string;
  outputWebhookIncludeTaskId: boolean;
  scheduleEnabled: boolean;
  scheduleKind: CronSchedule["kind"];
  scheduleExpr: string;
  scheduleTz: string;
  scheduleEveryMinutes: number;
  scheduleAt: string;
  apiEnabled: boolean;
  apiPath: string;
  connectorEventEnabled: boolean;
  connectorEventConnectorId: string;
  connectorEventChangeType: string;
  connectorEventResourceUriContains: string;
  channelEventEnabled: boolean;
  channelEventChannelType: string;
  channelEventChatId: string;
  channelEventTextContains: string;
  channelEventSenderContains: string;
  mailboxEventEnabled: boolean;
  mailboxEventType: string;
  mailboxEventProvider: string;
  mailboxEventSubjectContains: string;
  mailboxEventLabelContains: string;
  githubEventEnabled: boolean;
  githubEventName: string;
  githubEventRepository: string;
  githubEventAction: string;
  githubEventRef: string;
  manualEnabled: boolean;
};

const DEFAULT_CRON = "0 9 * * 1-5";
const DEFAULT_SCHEDULE_TZ =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid var(--color-border, rgba(127, 127, 127, 0.2))",
  background: "var(--color-surface-secondary, rgba(127, 127, 127, 0.08))",
  color: "var(--color-text-primary)",
  fontSize: 12,
} as const;

function createDefaultFormState(workspaceId = ""): RoutineFormState {
  return {
    enabled: true,
    name: "",
    description: "",
    workspaceId,
    instructions: "",
    executionTargetKind: "workspace",
    deviceId: "",
    managedEnvironmentId: "",
    connectorPolicyMode: "prefer",
    connectorIds: [],
    approvalMode: "inherit",
    outputTaskOnly: true,
    outputChannelMessage: false,
    outputChannelType: "",
    outputChannelId: "",
    outputSummaryOnly: true,
    outputDeliverOnSuccess: true,
    outputDeliverOnError: true,
    outputWebhookResponse: false,
    outputWebhookStatusCode: 202,
    outputWebhookMessage: "Routine accepted",
    outputWebhookIncludeTaskId: true,
    scheduleEnabled: false,
    scheduleKind: "cron",
    scheduleExpr: DEFAULT_CRON,
    scheduleTz: DEFAULT_SCHEDULE_TZ,
    scheduleEveryMinutes: 60,
    scheduleAt: "",
    apiEnabled: false,
    apiPath: "",
    connectorEventEnabled: false,
    connectorEventConnectorId: "",
    connectorEventChangeType: "",
    connectorEventResourceUriContains: "",
    channelEventEnabled: false,
    channelEventChannelType: "",
    channelEventChatId: "",
    channelEventTextContains: "",
    channelEventSenderContains: "",
    mailboxEventEnabled: false,
    mailboxEventType: "",
    mailboxEventProvider: "",
    mailboxEventSubjectContains: "",
    mailboxEventLabelContains: "",
    githubEventEnabled: false,
    githubEventName: "",
    githubEventRepository: "",
    githubEventAction: "",
    githubEventRef: "",
    manualEnabled: true,
  };
}

export function RoutineSettingsPanel() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
  const [hooksStatus, setHooksStatus] = useState<HookStatus | null>(null);
  const [hooksSettings, setHooksSettings] = useState<HookSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<RoutineFormState>(() => createDefaultFormState());

  useEffect(() => {
    void loadAll();
  }, []);

  const runsByRoutine = useMemo(() => {
    const grouped = new Map<string, RoutineRun[]>();
    for (const run of runs) {
      const entries = grouped.get(run.routineId) || [];
      entries.push(run);
      grouped.set(run.routineId, entries);
    }
    return grouped;
  }, [runs]);

  const workspaceMap = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  const apiBaseUrl = useMemo(() => {
    const host = hooksStatus?.serverAddress?.host || hooksSettings?.host || "127.0.0.1";
    const port = hooksStatus?.serverAddress?.port || hooksSettings?.port || 9877;
    const path = hooksSettings?.path || "/hooks";
    return `http://${host}:${port}${path}`;
  }, [hooksSettings, hooksStatus]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [routineList, routineRuns, workspaceList, status, settings, servers] = await Promise.all([
        window.electronAPI.listRoutines(),
        window.electronAPI.listRoutineRuns?.(undefined, 200) || Promise.resolve([]),
        window.electronAPI.listWorkspaces(),
        window.electronAPI.getHooksStatus(),
        window.electronAPI.getHooksSettings(),
        window.electronAPI.getMCPStatus?.() || Promise.resolve([]),
      ]);

      setRoutines((routineList || []) as Routine[]);
      setRuns((routineRuns || []) as RoutineRun[]);
      setWorkspaces(workspaceList || []);
      setHooksStatus(status);
      setHooksSettings(settings);
      setMcpServers(Array.isArray(servers) ? servers : []);

      if (!form.workspaceId && workspaceList?.length) {
        setForm((current) => ({ ...current, workspaceId: workspaceList[0].id }));
      }
    } catch (err: Any) {
      setError(err.message || "Failed to load routines");
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setEditingRoutineId(null);
    setShowForm(false);
    setForm(createDefaultFormState(workspaces[0]?.id || ""));
  }

  function startCreate() {
    setEditingRoutineId(null);
    setShowForm(true);
    setForm(createDefaultFormState(workspaces[0]?.id || ""));
  }

  function startEdit(routine: Routine) {
    const scheduleTrigger = routine.triggers.find((trigger) => trigger.type === "schedule");
    const apiTrigger = routine.triggers.find((trigger) => trigger.type === "api");
    const connectorTrigger = routine.triggers.find((trigger) => trigger.type === "connector_event");
    const channelTrigger = routine.triggers.find((trigger) => trigger.type === "channel_event");
    const mailboxTrigger = routine.triggers.find((trigger) => trigger.type === "mailbox_event");
    const githubTrigger = routine.triggers.find((trigger) => trigger.type === "github_event");
    const manualTrigger = routine.triggers.find((trigger) => trigger.type === "manual");
    const channelOutput = routine.outputs.find((output) => output.kind === "channel_message");
    const webhookOutput = routine.outputs.find((output) => output.kind === "webhook_response");
    const hasTaskOnly = routine.outputs.some((output) => output.kind === "task_only") || routine.outputs.length === 0;

    setEditingRoutineId(routine.id);
    setShowForm(true);
    setForm({
      enabled: routine.enabled,
      name: routine.name,
      description: routine.description || "",
      workspaceId: routine.workspaceId,
      instructions: routine.instructions || routine.prompt,
      executionTargetKind: routine.executionTarget?.kind || "workspace",
      deviceId: routine.executionTarget?.deviceId || "",
      managedEnvironmentId: routine.executionTarget?.managedEnvironmentId || "",
      connectorPolicyMode: routine.connectorPolicy?.mode || "prefer",
      connectorIds: routine.connectorPolicy?.connectorIds || [],
      approvalMode: routine.approvalPolicy?.mode || "inherit",
      outputTaskOnly: hasTaskOnly,
      outputChannelMessage: Boolean(channelOutput),
      outputChannelType: channelOutput?.kind === "channel_message" ? channelOutput.channelType || "" : "",
      outputChannelId: channelOutput?.kind === "channel_message" ? channelOutput.channelId || "" : "",
      outputSummaryOnly: channelOutput?.kind === "channel_message" ? channelOutput.summaryOnly ?? true : true,
      outputDeliverOnSuccess:
        channelOutput?.kind === "channel_message" ? channelOutput.deliverOnSuccess ?? true : true,
      outputDeliverOnError:
        channelOutput?.kind === "channel_message" ? channelOutput.deliverOnError ?? true : true,
      outputWebhookResponse: Boolean(webhookOutput),
      outputWebhookStatusCode:
        webhookOutput?.kind === "webhook_response" ? webhookOutput.statusCode ?? 202 : 202,
      outputWebhookMessage:
        webhookOutput?.kind === "webhook_response" ? webhookOutput.message || "" : "Routine accepted",
      outputWebhookIncludeTaskId:
        webhookOutput?.kind === "webhook_response" ? webhookOutput.includeTaskId ?? true : true,
      scheduleEnabled: Boolean(scheduleTrigger),
      scheduleKind:
        scheduleTrigger?.type === "schedule" ? scheduleTrigger.schedule.kind : "cron",
      scheduleExpr:
        scheduleTrigger?.type === "schedule" && scheduleTrigger.schedule.kind === "cron"
          ? scheduleTrigger.schedule.expr
          : DEFAULT_CRON,
      scheduleTz:
        scheduleTrigger?.type === "schedule" && scheduleTrigger.schedule.kind === "cron"
          ? scheduleTrigger.schedule.tz || DEFAULT_SCHEDULE_TZ
          : DEFAULT_SCHEDULE_TZ,
      scheduleEveryMinutes:
        scheduleTrigger?.type === "schedule" && scheduleTrigger.schedule.kind === "every"
          ? Math.max(1, Math.floor(scheduleTrigger.schedule.everyMs / 60000))
          : 60,
      scheduleAt:
        scheduleTrigger?.type === "schedule" && scheduleTrigger.schedule.kind === "at"
          ? toDateTimeLocal(scheduleTrigger.schedule.atMs)
          : "",
      apiEnabled: Boolean(apiTrigger),
      apiPath: apiTrigger?.type === "api" ? apiTrigger.path || "" : "",
      connectorEventEnabled: Boolean(connectorTrigger),
      connectorEventConnectorId:
        connectorTrigger?.type === "connector_event" ? connectorTrigger.connectorId : "",
      connectorEventChangeType:
        connectorTrigger?.type === "connector_event" ? connectorTrigger.changeType || "" : "",
      connectorEventResourceUriContains:
        connectorTrigger?.type === "connector_event" ? connectorTrigger.resourceUriContains || "" : "",
      channelEventEnabled: Boolean(channelTrigger),
      channelEventChannelType:
        channelTrigger?.type === "channel_event" ? channelTrigger.channelType || "" : "",
      channelEventChatId:
        channelTrigger?.type === "channel_event" ? channelTrigger.chatId || "" : "",
      channelEventTextContains:
        channelTrigger?.type === "channel_event" ? channelTrigger.textContains || "" : "",
      channelEventSenderContains:
        channelTrigger?.type === "channel_event" ? channelTrigger.senderContains || "" : "",
      mailboxEventEnabled: Boolean(mailboxTrigger),
      mailboxEventType:
        mailboxTrigger?.type === "mailbox_event" ? mailboxTrigger.eventType || "" : "",
      mailboxEventProvider:
        mailboxTrigger?.type === "mailbox_event" ? mailboxTrigger.provider || "" : "",
      mailboxEventSubjectContains:
        mailboxTrigger?.type === "mailbox_event" ? mailboxTrigger.subjectContains || "" : "",
      mailboxEventLabelContains:
        mailboxTrigger?.type === "mailbox_event" ? mailboxTrigger.labelContains || "" : "",
      githubEventEnabled: Boolean(githubTrigger),
      githubEventName:
        githubTrigger?.type === "github_event" ? githubTrigger.eventName || "" : "",
      githubEventRepository:
        githubTrigger?.type === "github_event" ? githubTrigger.repository || "" : "",
      githubEventAction:
        githubTrigger?.type === "github_event" ? githubTrigger.action || "" : "",
      githubEventRef:
        githubTrigger?.type === "github_event" ? githubTrigger.ref || "" : "",
      manualEnabled: manualTrigger?.type === "manual" ? manualTrigger.enabled : true,
    });
  }

  function toggleConnector(connectorId: string) {
    setForm((current) => ({
      ...current,
      connectorIds: current.connectorIds.includes(connectorId)
        ? current.connectorIds.filter((item) => item !== connectorId)
        : [...current.connectorIds, connectorId],
    }));
  }

  async function saveRoutine() {
    if (!form.name.trim()) {
      setError("Routine name is required");
      return;
    }
    if (!form.workspaceId) {
      setError("Workspace is required");
      return;
    }
    if (!form.instructions.trim()) {
      setError("Routine instructions are required");
      return;
    }
    if (form.executionTargetKind === "device" && !form.deviceId.trim()) {
      setError("Device ID is required for device-targeted routines");
      return;
    }
    if (form.executionTargetKind === "managed_environment" && !form.managedEnvironmentId.trim()) {
      setError("Managed environment ID is required for managed-environment routines");
      return;
    }
    if (form.scheduleEnabled && form.scheduleKind === "cron" && !form.scheduleExpr.trim()) {
      setError("Cron expression is required when the schedule trigger is enabled");
      return;
    }
    if (form.scheduleEnabled && form.scheduleKind === "at" && !form.scheduleAt) {
      setError("Choose a run time for one-shot schedules");
      return;
    }
    if (form.connectorEventEnabled && !form.connectorEventConnectorId.trim()) {
      setError("Choose a connector for the connector event trigger");
      return;
    }
    if (form.outputChannelMessage && (!form.outputChannelType.trim() || !form.outputChannelId.trim())) {
      setError("Channel outputs need both a channel type and channel ID");
      return;
    }

    const existing =
      editingRoutineId ? routines.find((routine) => routine.id === editingRoutineId) || null : null;
    const triggers = buildTriggers(form, existing);
    const outputs = buildOutputs(form);

    const payload = {
      enabled: form.enabled,
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      workspaceId: form.workspaceId,
      instructions: form.instructions.trim(),
      executionTarget: {
        kind: form.executionTargetKind,
        deviceId: form.deviceId.trim() || undefined,
        managedEnvironmentId: form.managedEnvironmentId.trim() || undefined,
      },
      connectorPolicy: {
        mode: form.connectorPolicyMode,
        connectorIds: form.connectorIds,
      },
      connectors: form.connectorIds,
      approvalPolicy: { mode: form.approvalMode },
      outputs,
      triggers,
    };

    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await window.electronAPI.updateRoutine(existing.id, payload);
      } else {
        await window.electronAPI.createRoutine(payload);
      }
      await loadAll();
      resetForm();
    } catch (err: Any) {
      setError(err.message || "Failed to save routine");
    } finally {
      setSaving(false);
    }
  }

  async function deleteRoutine(routineId: string) {
    if (!confirm("Delete this routine and all of its generated triggers, hooks, and schedule jobs?")) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.removeRoutine(routineId);
      await loadAll();
      if (editingRoutineId === routineId) {
        resetForm();
      }
    } catch (err: Any) {
      setError(err.message || "Failed to delete routine");
    } finally {
      setSaving(false);
    }
  }

  async function runRoutineNow(routineId: string) {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.runRoutineNow?.(routineId);
      await loadAll();
    } catch (err: Any) {
      setError(err.message || "Failed to run routine");
    } finally {
      setSaving(false);
    }
  }

  async function regenerateApiToken(routine: Routine, triggerId: string) {
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.regenerateRoutineApiToken(routine.id, triggerId);
      await loadAll();
    } catch (err: Any) {
      setError(err.message || "Failed to regenerate API token");
    } finally {
      setSaving(false);
    }
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
  }

  if (loading) {
    return <div className="settings-loading">Loading routines...</div>;
  }

  return (
    <div className="settings-subsection">
      <div className="settings-section">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div>
            <h3>Routines</h3>
            <p className="settings-description">
              Routines are CoWork&apos;s saved automations: one set of instructions, one execution
              target, and one or more triggers. Comparable to Claude Routines, but designed for
              CoWork&apos;s local-first runtime.
            </p>
          </div>
          <button className="settings-button primary" onClick={startCreate}>
            <Plus size={16} />
            New Routine
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <span style={chipStyle}>
            <Workflow size={14} />
            Routines first
          </span>
          <span style={chipStyle}>
            <Clock3 size={14} />
            Scheduled Tasks, Webhooks, and Event Triggers remain as generated infrastructure
          </span>
          <span style={chipStyle}>
            <Cable size={14} />
            Connector allowlists can now be enforced, not just hinted
          </span>
        </div>

        {error && (
          <div className="settings-error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>

      {showForm && (
        <div className="settings-section" style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h4 style={{ margin: 0 }}>{editingRoutineId ? "Edit Routine" : "Create Routine"}</h4>
            <button className="settings-button secondary" onClick={resetForm}>
              Cancel
            </button>
          </div>

          <label className="settings-field">
            <span>Name</span>
            <input
              className="settings-input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="PR triage"
            />
          </label>

          <label className="settings-field">
            <span>Description</span>
            <input
              className="settings-input"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Review repo events and draft next actions."
            />
          </label>

          <label className="settings-field">
            <span>Workspace</span>
            <select
              className="settings-select"
              value={form.workspaceId}
              onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Instructions</span>
            <textarea
              className="settings-textarea"
              rows={7}
              value={form.instructions}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              placeholder="Review PRs targeting main. Check missing tests, risky migrations, and auth changes. Leave a pass/flag/fail summary. Do not merge or push."
            />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
            <label className="settings-field">
              <span>Execution Target</span>
              <select
                className="settings-select"
                value={form.executionTargetKind}
                onChange={(event) =>
                  setForm({
                    ...form,
                    executionTargetKind: event.target.value as RoutineFormState["executionTargetKind"],
                  })
                }
              >
                <option value="workspace">Workspace</option>
                <option value="worktree">Git Worktree</option>
                <option value="device">Remote Device</option>
                <option value="managed_environment">Managed Environment</option>
              </select>
            </label>

            {form.executionTargetKind === "device" && (
              <label className="settings-field">
                <span>Device ID</span>
                <input
                  className="settings-input"
                  value={form.deviceId}
                  onChange={(event) => setForm({ ...form, deviceId: event.target.value })}
                  placeholder="remote-node-id"
                />
              </label>
            )}

            {form.executionTargetKind === "managed_environment" && (
              <label className="settings-field">
                <span>Managed Environment ID</span>
                <input
                  className="settings-input"
                  value={form.managedEnvironmentId}
                  onChange={(event) =>
                    setForm({ ...form, managedEnvironmentId: event.target.value })
                  }
                  placeholder="env_..."
                />
              </label>
            )}

            <label className="settings-field">
              <span>Approval Policy</span>
              <select
                className="settings-select"
                value={form.approvalMode}
                onChange={(event) =>
                  setForm({
                    ...form,
                    approvalMode: event.target.value as RoutineFormState["approvalMode"],
                  })
                }
              >
                <option value="inherit">Inherit workspace defaults</option>
                <option value="auto_safe">Auto-safe</option>
                <option value="confirm_external">Confirm external actions</option>
                <option value="strict_confirm">Strict confirm</option>
              </select>
            </label>
          </div>

          <div className="settings-field">
            <span>Connector Policy</span>
            <div style={{ display: "grid", gap: 12 }}>
              <select
                className="settings-select"
                value={form.connectorPolicyMode}
                onChange={(event) =>
                  setForm({
                    ...form,
                    connectorPolicyMode: event.target.value as RoutineFormState["connectorPolicyMode"],
                  })
                }
              >
                <option value="prefer">Prefer connectors in prompt context</option>
                <option value="allowlist">Enforce connector allowlist at runtime</option>
              </select>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {mcpServers.map((server) => {
                  const active = form.connectorIds.includes(server.id);
                  return (
                    <button
                      key={server.id}
                      type="button"
                      className={`settings-chip ${active ? "active" : ""}`}
                      onClick={() => toggleConnector(server.id)}
                    >
                      {server.name}
                    </button>
                  );
                })}
                {mcpServers.length === 0 && (
                  <div className="settings-help">No MCP connectors found.</div>
                )}
              </div>
            </div>
          </div>

          <div className="settings-field">
            <span>Outputs</span>
            <div style={{ display: "grid", gap: 12 }}>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={form.outputTaskOnly}
                  onChange={(event) => setForm({ ...form, outputTaskOnly: event.target.checked })}
                />
                <span>Create a task and keep results in CoWork</span>
              </label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={form.outputChannelMessage}
                  onChange={(event) =>
                    setForm({ ...form, outputChannelMessage: event.target.checked })
                  }
                />
                <span>Deliver a channel summary</span>
              </label>
              {form.outputChannelMessage && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <input
                    className="settings-input"
                    value={form.outputChannelType}
                    onChange={(event) => setForm({ ...form, outputChannelType: event.target.value })}
                    placeholder="slack"
                  />
                  <input
                    className="settings-input"
                    value={form.outputChannelId}
                    onChange={(event) => setForm({ ...form, outputChannelId: event.target.value })}
                    placeholder="C123456"
                  />
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.outputSummaryOnly}
                      onChange={(event) =>
                        setForm({ ...form, outputSummaryOnly: event.target.checked })
                      }
                    />
                    <span>Summary only</span>
                  </label>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.outputDeliverOnSuccess}
                      onChange={(event) =>
                        setForm({ ...form, outputDeliverOnSuccess: event.target.checked })
                      }
                    />
                    <span>Send on success</span>
                  </label>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.outputDeliverOnError}
                      onChange={(event) =>
                        setForm({ ...form, outputDeliverOnError: event.target.checked })
                      }
                    />
                    <span>Send on error</span>
                  </label>
                </div>
              )}

              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={form.outputWebhookResponse}
                  onChange={(event) =>
                    setForm({ ...form, outputWebhookResponse: event.target.checked })
                  }
                />
                <span>Return a webhook response body for API-triggered runs</span>
              </label>
              {form.outputWebhookResponse && (
                <div style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 12 }}>
                  <input
                    className="settings-input"
                    type="number"
                    min={100}
                    max={599}
                    value={form.outputWebhookStatusCode}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        outputWebhookStatusCode: Number(event.target.value || 202),
                      })
                    }
                  />
                  <input
                    className="settings-input"
                    value={form.outputWebhookMessage}
                    onChange={(event) =>
                      setForm({ ...form, outputWebhookMessage: event.target.value })
                    }
                    placeholder="Routine accepted"
                  />
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={form.outputWebhookIncludeTaskId}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          outputWebhookIncludeTaskId: event.target.checked,
                        })
                      }
                    />
                    <span>Include task ID</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="settings-field">
            <span>Triggers</span>
            <div style={{ display: "grid", gap: 14 }}>
              <TriggerToggle
                checked={form.scheduleEnabled}
                label="Schedule"
                description="Compile this routine into a managed cron job."
                onChange={(checked) => setForm({ ...form, scheduleEnabled: checked })}
              />
              {form.scheduleEnabled && (
                <div style={{ display: "grid", gap: 12 }}>
                  <select
                    className="settings-select"
                    value={form.scheduleKind}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        scheduleKind: event.target.value as RoutineFormState["scheduleKind"],
                      })
                    }
                  >
                    <option value="cron">Cron</option>
                    <option value="every">Every N minutes</option>
                    <option value="at">Run once</option>
                  </select>
                  {form.scheduleKind === "cron" && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 12 }}>
                      <input
                        className="settings-input"
                        value={form.scheduleExpr}
                        onChange={(event) =>
                          setForm({ ...form, scheduleExpr: event.target.value })
                        }
                        placeholder="0 9 * * 1-5"
                      />
                      <input
                        className="settings-input"
                        value={form.scheduleTz}
                        onChange={(event) => setForm({ ...form, scheduleTz: event.target.value })}
                        placeholder="Europe/Lisbon"
                      />
                    </div>
                  )}
                  {form.scheduleKind === "every" && (
                    <input
                      className="settings-input"
                      type="number"
                      min={1}
                      value={form.scheduleEveryMinutes}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          scheduleEveryMinutes: Math.max(1, Number(event.target.value || 1)),
                        })
                      }
                    />
                  )}
                  {form.scheduleKind === "at" && (
                    <input
                      className="settings-input"
                      type="datetime-local"
                      value={form.scheduleAt}
                      onChange={(event) => setForm({ ...form, scheduleAt: event.target.value })}
                    />
                  )}
                </div>
              )}

              <TriggerToggle
                checked={form.apiEnabled}
                label="API"
                description="Generate a webhook path and token for external callers."
                onChange={(checked) => setForm({ ...form, apiEnabled: checked })}
              />
              {form.apiEnabled && (
                <input
                  className="settings-input"
                  value={form.apiPath}
                  onChange={(event) => setForm({ ...form, apiPath: event.target.value })}
                  placeholder="routines/pr-triage"
                />
              )}

              <TriggerToggle
                checked={form.connectorEventEnabled}
                label="Connector Event"
                description="Watch MCP connector notifications."
                onChange={(checked) => setForm({ ...form, connectorEventEnabled: checked })}
              />
              {form.connectorEventEnabled && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <input
                    className="settings-input"
                    value={form.connectorEventConnectorId}
                    onChange={(event) =>
                      setForm({ ...form, connectorEventConnectorId: event.target.value })
                    }
                    placeholder="github"
                  />
                  <input
                    className="settings-input"
                    value={form.connectorEventChangeType}
                    onChange={(event) =>
                      setForm({ ...form, connectorEventChangeType: event.target.value })
                    }
                    placeholder="resource_updated"
                  />
                  <input
                    className="settings-input"
                    value={form.connectorEventResourceUriContains}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        connectorEventResourceUriContains: event.target.value,
                      })
                    }
                    placeholder="repo://..."
                  />
                </div>
              )}

              <TriggerToggle
                checked={form.channelEventEnabled}
                label="Channel Event"
                description="Listen for incoming channel messages."
                onChange={(checked) => setForm({ ...form, channelEventEnabled: checked })}
              />
              {form.channelEventEnabled && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <input
                    className="settings-input"
                    value={form.channelEventChannelType}
                    onChange={(event) =>
                      setForm({ ...form, channelEventChannelType: event.target.value })
                    }
                    placeholder="slack"
                  />
                  <input
                    className="settings-input"
                    value={form.channelEventChatId}
                    onChange={(event) =>
                      setForm({ ...form, channelEventChatId: event.target.value })
                    }
                    placeholder="C123456"
                  />
                  <input
                    className="settings-input"
                    value={form.channelEventTextContains}
                    onChange={(event) =>
                      setForm({ ...form, channelEventTextContains: event.target.value })
                    }
                    placeholder="contains text"
                  />
                  <input
                    className="settings-input"
                    value={form.channelEventSenderContains}
                    onChange={(event) =>
                      setForm({ ...form, channelEventSenderContains: event.target.value })
                    }
                    placeholder="sender contains"
                  />
                </div>
              )}

              <TriggerToggle
                checked={form.mailboxEventEnabled}
                label="Mailbox Event"
                description="Use normalized inbox events as a trigger source."
                onChange={(checked) => setForm({ ...form, mailboxEventEnabled: checked })}
              />
              {form.mailboxEventEnabled && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <input
                    className="settings-input"
                    value={form.mailboxEventType}
                    onChange={(event) =>
                      setForm({ ...form, mailboxEventType: event.target.value })
                    }
                    placeholder="message_received"
                  />
                  <input
                    className="settings-input"
                    value={form.mailboxEventProvider}
                    onChange={(event) =>
                      setForm({ ...form, mailboxEventProvider: event.target.value })
                    }
                    placeholder="gmail"
                  />
                  <input
                    className="settings-input"
                    value={form.mailboxEventSubjectContains}
                    onChange={(event) =>
                      setForm({ ...form, mailboxEventSubjectContains: event.target.value })
                    }
                    placeholder="subject contains"
                  />
                  <input
                    className="settings-input"
                    value={form.mailboxEventLabelContains}
                    onChange={(event) =>
                      setForm({ ...form, mailboxEventLabelContains: event.target.value })
                    }
                    placeholder="label contains"
                  />
                </div>
              )}

              <TriggerToggle
                checked={form.githubEventEnabled}
                label="GitHub Event"
                description="First-class GitHub trigger surface over connector events."
                onChange={(checked) => setForm({ ...form, githubEventEnabled: checked })}
              />
              {form.githubEventEnabled && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <input
                    className="settings-input"
                    value={form.githubEventName}
                    onChange={(event) =>
                      setForm({ ...form, githubEventName: event.target.value })
                    }
                    placeholder="pull_request.opened"
                  />
                  <input
                    className="settings-input"
                    value={form.githubEventRepository}
                    onChange={(event) =>
                      setForm({ ...form, githubEventRepository: event.target.value })
                    }
                    placeholder="owner/repo"
                  />
                  <input
                    className="settings-input"
                    value={form.githubEventAction}
                    onChange={(event) =>
                      setForm({ ...form, githubEventAction: event.target.value })
                    }
                    placeholder="opened"
                  />
                  <input
                    className="settings-input"
                    value={form.githubEventRef}
                    onChange={(event) =>
                      setForm({ ...form, githubEventRef: event.target.value })
                    }
                    placeholder="refs/heads/main"
                  />
                </div>
              )}

              <TriggerToggle
                checked={form.manualEnabled}
                label="Manual"
                description="Allow manual runs from the routines panel."
                onChange={(checked) => setForm({ ...form, manualEnabled: checked })}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button className="settings-button primary" onClick={saveRoutine} disabled={saving}>
              <Save size={16} />
              {saving ? "Saving..." : "Save Routine"}
            </button>
          </div>
        </div>
      )}

      <div className="settings-section" style={{ display: "grid", gap: 16 }}>
        {routines.length === 0 ? (
          <div className="settings-empty-state">
            No routines yet. Create one to compile schedules, webhooks, and event triggers from a
            single top-level automation definition.
          </div>
        ) : (
          routines.map((routine) => {
            const routineRuns = (runsByRoutine.get(routine.id) || []).slice(0, 5);
            const apiTrigger = routine.triggers.find((trigger) => trigger.type === "api");
            const workspace = workspaceMap.get(routine.workspaceId);
            return (
              <div
                key={routine.id}
                style={{
                  border: "1px solid var(--color-border, rgba(127, 127, 127, 0.2))",
                  borderRadius: 16,
                  padding: 16,
                  display: "grid",
                  gap: 14,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{routine.name}</strong>
                      <span style={chipStyle}>{routine.enabled ? "Enabled" : "Disabled"}</span>
                      <span style={chipStyle}>{routine.executionTarget.kind.replace(/_/g, " ")}</span>
                      <span style={chipStyle}>{workspace?.name || routine.workspaceId}</span>
                    </div>
                    {routine.description && (
                      <div className="settings-description" style={{ marginTop: 8 }}>
                        {routine.description}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="settings-button secondary" onClick={() => runRoutineNow(routine.id)} disabled={saving}>
                      <Play size={16} />
                      Run Now
                    </button>
                    <button className="settings-button secondary" onClick={() => startEdit(routine)}>
                      <Pencil size={16} />
                      Edit
                    </button>
                    <button className="settings-button danger" onClick={() => deleteRoutine(routine.id)} disabled={saving}>
                      <Trash2 size={16} />
                      Delete
                    </button>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {routine.triggers.map((trigger) => (
                    <span key={trigger.id} style={chipStyle}>
                      {trigger.type.replace(/_/g, " ")}
                    </span>
                  ))}
                  {routine.outputs.map((output, index) => (
                    <span key={`${routine.id}-output-${index}`} style={chipStyle}>
                      output: {output.kind.replace(/_/g, " ")}
                    </span>
                  ))}
                  {routine.connectorPolicy.connectorIds.map((connectorId) => (
                    <span key={`${routine.id}-${connectorId}`} style={chipStyle}>
                      connector: {connectorId}
                    </span>
                  ))}
                </div>

                {apiTrigger?.type === "api" && (
                  <div
                    style={{
                      border: "1px solid var(--color-border, rgba(127, 127, 127, 0.2))",
                      borderRadius: 12,
                      padding: 12,
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <Link2 size={16} />
                      <strong>API Trigger</strong>
                    </div>
                    <code style={{ wordBreak: "break-all" }}>
                      {apiBaseUrl}/{apiTrigger.path || `routines/${routine.id}/${apiTrigger.id}`}
                    </code>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        className="settings-button secondary"
                        onClick={() =>
                          copyText(`${apiBaseUrl}/${apiTrigger.path || `routines/${routine.id}/${apiTrigger.id}`}`)
                        }
                      >
                        Copy URL
                      </button>
                      {apiTrigger.token && (
                        <>
                          <button
                            className="settings-button secondary"
                            onClick={() => copyText(apiTrigger.token || "")}
                          >
                            Copy Token
                          </button>
                          <button
                            className="settings-button secondary"
                            onClick={() => regenerateApiToken(routine, apiTrigger.id)}
                            disabled={saving}
                          >
                            Rotate Token
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ display: "grid", gap: 8 }}>
                  <strong>Recent Runs</strong>
                  {routineRuns.length === 0 ? (
                    <div className="settings-help">No runs recorded yet.</div>
                  ) : (
                    routineRuns.map((run) => (
                      <div
                        key={run.id}
                        style={{
                          border: "1px solid var(--color-border, rgba(127, 127, 127, 0.16))",
                          borderRadius: 10,
                          padding: 10,
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <span style={chipStyle}>{run.triggerType.replace(/_/g, " ")}</span>
                          <span style={chipStyle}>{run.status}</span>
                          <span style={chipStyle}>output: {run.outputStatus}</span>
                          <span style={chipStyle}>{formatTime(run.startedAt)}</span>
                        </div>
                        {run.sourceEventSummary && <div>{run.sourceEventSummary}</div>}
                        {run.errorSummary && (
                          <div className="settings-error" style={{ margin: 0 }}>
                            {run.errorSummary}
                          </div>
                        )}
                        {run.artifactsSummary && (
                          <div className="settings-help">{run.artifactsSummary}</div>
                        )}
                        {(run.backingTaskId || run.backingManagedSessionId) && (
                          <div className="settings-help">
                            {run.backingTaskId ? `Task: ${run.backingTaskId}` : ""}
                            {run.backingTaskId && run.backingManagedSessionId ? " · " : ""}
                            {run.backingManagedSessionId ? `Session: ${run.backingManagedSessionId}` : ""}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function TriggerToggle(props: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-checkbox" style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
        <span>{props.label}</span>
      </div>
      <span className="settings-help">{props.description}</span>
    </label>
  );
}

function buildTriggers(form: RoutineFormState, existing: Routine | null): RoutineTrigger[] {
  const findExisting = <T extends RoutineTrigger["type"]>(type: T) =>
    existing?.triggers.find((trigger): trigger is Extract<RoutineTrigger, { type: T }> => trigger.type === type);

  const triggers: RoutineTrigger[] = [];
  const scheduleExisting = findExisting("schedule");
  const apiExisting = findExisting("api");
  const connectorExisting = findExisting("connector_event");
  const channelExisting = findExisting("channel_event");
  const mailboxExisting = findExisting("mailbox_event");
  const githubExisting = findExisting("github_event");
  const manualExisting = findExisting("manual");

  if (form.scheduleEnabled) {
    const schedule: CronSchedule =
      form.scheduleKind === "every"
        ? { kind: "every", everyMs: form.scheduleEveryMinutes * 60_000 }
        : form.scheduleKind === "at"
          ? { kind: "at", atMs: new Date(form.scheduleAt).getTime() }
          : { kind: "cron", expr: form.scheduleExpr.trim(), tz: form.scheduleTz.trim() || undefined };
    triggers.push({
      ...(scheduleExisting || { id: window.crypto.randomUUID() }),
      type: "schedule",
      enabled: true,
      schedule,
    });
  }

  if (form.apiEnabled) {
    triggers.push({
      ...(apiExisting || { id: window.crypto.randomUUID() }),
      type: "api",
      enabled: true,
      path: form.apiPath.trim() || undefined,
    });
  }

  if (form.connectorEventEnabled) {
    triggers.push({
      ...(connectorExisting || { id: window.crypto.randomUUID() }),
      type: "connector_event",
      enabled: true,
      connectorId: form.connectorEventConnectorId.trim(),
      changeType: form.connectorEventChangeType.trim() || undefined,
      resourceUriContains: form.connectorEventResourceUriContains.trim() || undefined,
    });
  }

  if (form.channelEventEnabled) {
    triggers.push({
      ...(channelExisting || { id: window.crypto.randomUUID() }),
      type: "channel_event",
      enabled: true,
      channelType: form.channelEventChannelType.trim() || undefined,
      chatId: form.channelEventChatId.trim() || undefined,
      textContains: form.channelEventTextContains.trim() || undefined,
      senderContains: form.channelEventSenderContains.trim() || undefined,
    });
  }

  if (form.mailboxEventEnabled) {
    triggers.push({
      ...(mailboxExisting || { id: window.crypto.randomUUID() }),
      type: "mailbox_event",
      enabled: true,
      eventType: form.mailboxEventType.trim() || undefined,
      provider: form.mailboxEventProvider.trim() || undefined,
      subjectContains: form.mailboxEventSubjectContains.trim() || undefined,
      labelContains: form.mailboxEventLabelContains.trim() || undefined,
    });
  }

  if (form.githubEventEnabled) {
    triggers.push({
      ...(githubExisting || { id: window.crypto.randomUUID() }),
      type: "github_event",
      enabled: true,
      eventName: form.githubEventName.trim() || undefined,
      repository: form.githubEventRepository.trim() || undefined,
      action: form.githubEventAction.trim() || undefined,
      ref: form.githubEventRef.trim() || undefined,
    });
  }

  if (form.manualEnabled) {
    triggers.push({
      ...(manualExisting || { id: window.crypto.randomUUID() }),
      type: "manual",
      enabled: true,
    });
  }

  return triggers;
}

function buildOutputs(form: RoutineFormState): RoutineOutput[] {
  const outputs: RoutineOutput[] = [];
  if (form.outputTaskOnly || (!form.outputChannelMessage && !form.outputWebhookResponse)) {
    outputs.push({ kind: "task_only" });
  }
  if (form.outputChannelMessage) {
    outputs.push({
      kind: "channel_message",
      channelType: form.outputChannelType.trim() || undefined,
      channelId: form.outputChannelId.trim() || undefined,
      summaryOnly: form.outputSummaryOnly,
      deliverOnSuccess: form.outputDeliverOnSuccess,
      deliverOnError: form.outputDeliverOnError,
    });
  }
  if (form.outputWebhookResponse) {
    outputs.push({
      kind: "webhook_response",
      statusCode: form.outputWebhookStatusCode,
      message: form.outputWebhookMessage.trim() || undefined,
      includeTaskId: form.outputWebhookIncludeTaskId,
    });
  }
  return outputs;
}

function toDateTimeLocal(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}
