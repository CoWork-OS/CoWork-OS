import React, { useState, useEffect, useCallback } from "react";
import { Zap, Plus, Trash2, ToggleLeft, ToggleRight, History, ChevronDown } from "lucide-react";

interface TriggerCondition {
  field: string;
  operator: string;
  value: string;
}

interface TriggerAction {
  type: string;
  config: Record<string, Any>;
}

interface EventTrigger {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  source: string;
  conditions: TriggerCondition[];
  conditionLogic?: string;
  action: TriggerAction;
  workspaceId: string;
  cooldownMs?: number;
  lastFiredAt?: number;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

interface TriggerHistoryEntry {
  id: string;
  triggerId: string;
  firedAt: number;
  eventData: Record<string, unknown>;
  actionResult?: string;
  taskId?: string;
}

const SOURCES = [
  { value: "channel_message", label: "Channel Message" },
  { value: "email", label: "Email" },
  { value: "webhook", label: "Webhook" },
  { value: "connector_event", label: "Connector Event" },
];

const OPERATORS = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "matches", label: "matches (regex)" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "not_contains", label: "does not contain" },
  { value: "not_equals", label: "does not equal" },
];

const FIELDS_BY_SOURCE: Record<string, string[]> = {
  channel_message: ["text", "senderName", "chatId", "channelType"],
  email: ["subject", "from", "to", "body"],
  webhook: ["path", "method", "body"],
  connector_event: ["type", "source", "data"],
};

/** Example triggers shown when empty; clicking one populates the form */
const EXAMPLE_TRIGGERS = [
  {
    name: "Urgent deploy alert",
    source: "channel_message" as const,
    conditions: [{ field: "text", operator: "contains", value: "urgent" }],
    actionTitle: "Review deploy request",
    actionPrompt:
      "Someone requested an urgent deploy. Review the message and create a task to handle it. Context: {{event.text}} from {{event.senderName}}",
  },
  {
    name: "Bug report triage",
    source: "channel_message" as const,
    conditions: [{ field: "text", operator: "contains", value: "bug" }],
    actionTitle: "Triage bug report",
    actionPrompt:
      "Triage this bug report and create a task with priority and steps. Message: {{event.text}}",
  },
  {
    name: "Meeting follow-up",
    source: "email" as const,
    conditions: [{ field: "subject", operator: "contains", value: "meeting" }],
    actionTitle: "Meeting follow-up",
    actionPrompt:
      "Create follow-up tasks from this meeting email. Extract action items and assign priorities.",
  },
  {
    name: "Webhook deploy",
    source: "webhook" as const,
    conditions: [{ field: "path", operator: "equals", value: "/deploy" }],
    actionTitle: "Deploy triggered",
    actionPrompt: "A deploy was triggered via webhook. Verify and document the deployment.",
  },
];

export const EventTriggersPanel: React.FC<{ workspaceId?: string }> = ({ workspaceId }) => {
  const [triggers, setTriggers] = useState<EventTrigger[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [history, setHistory] = useState<TriggerHistoryEntry[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [source, setSource] = useState("channel_message");
  const [conditions, setConditions] = useState<TriggerCondition[]>([
    { field: "text", operator: "contains", value: "" },
  ]);
  const [actionType] = useState("create_task");
  const [actionPrompt, setActionPrompt] = useState("");
  const [actionTitle, setActionTitle] = useState("");

  const loadTriggers = useCallback(async () => {
    try {
      const result = await (window as Any).electronAPI.listTriggers(workspaceId || "");
      setTriggers(result || []);
    } catch {
      // API not available yet
    }
  }, [workspaceId]);

  useEffect(() => {
    loadTriggers();
  }, [loadTriggers]);

  const addCondition = () => {
    const fields = FIELDS_BY_SOURCE[source] || ["text"];
    setConditions([...conditions, { field: fields[0], operator: "contains", value: "" }]);
  };

  const removeCondition = (idx: number) => {
    setConditions(conditions.filter((_, i) => i !== idx));
  };

  const updateCondition = (idx: number, updates: Partial<TriggerCondition>) => {
    setConditions(conditions.map((c, i) => (i === idx ? { ...c, ...updates } : c)));
  };

  const handleAdd = async () => {
    if (!name.trim()) return;
    try {
      await (window as Any).electronAPI.addTrigger({
        name: name.trim(),
        enabled: true,
        source,
        conditions,
        conditionLogic: "all",
        action: {
          type: actionType,
          config: {
            prompt: actionPrompt,
            title: actionTitle || `Trigger: ${name.trim()}`,
            workspaceId,
          },
        },
        workspaceId: workspaceId || "",
      });
      setShowForm(false);
      setName("");
      setConditions([{ field: "text", operator: "contains", value: "" }]);
      setActionPrompt("");
      setActionTitle("");
      loadTriggers();
    } catch (err) {
      console.error("Failed to add trigger:", err);
    }
  };

  const toggleTrigger = async (id: string, enabled: boolean) => {
    try {
      await (window as Any).electronAPI.updateTrigger(id, { enabled });
      loadTriggers();
    } catch {
      // ignore
    }
  };

  const deleteTrigger = async (id: string) => {
    try {
      await (window as Any).electronAPI.removeTrigger(id);
      loadTriggers();
    } catch {
      // ignore
    }
  };

  const applyExample = (ex: (typeof EXAMPLE_TRIGGERS)[0]) => {
    setName(ex.name);
    setSource(ex.source);
    setConditions(ex.conditions.map((c) => ({ ...c })));
    setActionTitle(ex.actionTitle);
    setActionPrompt(ex.actionPrompt);
    setShowForm(true);
  };

  const loadHistory = async (triggerId: string) => {
    if (expandedHistory === triggerId) {
      setExpandedHistory(null);
      return;
    }
    try {
      const result = await (window as Any).electronAPI.getTriggerHistory(triggerId);
      setHistory(result || []);
      setExpandedHistory(triggerId);
    } catch {
      setExpandedHistory(triggerId);
    }
  };

  const fields = FIELDS_BY_SOURCE[source] || ["text"];

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={18} style={{ color: "var(--color-accent)" }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--color-text)" }}>
            Event Triggers
          </h3>
          <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            {triggers.length} trigger{triggers.length !== 1 ? "s" : ""}
          </span>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 12px",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            background: "var(--color-bg-elevated)",
            color: "var(--color-text)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <Plus size={14} /> Add Trigger
        </button>
      </div>

      {showForm && (
        <div
          className="event-triggers-form"
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
            background: "var(--color-bg-elevated)",
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Name
            </label>
            <input
              type="text"
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Urgent deploy alert"
              style={{ marginBottom: 0 }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              When (source)
            </label>
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setConditions([
                  {
                    field: FIELDS_BY_SOURCE[e.target.value]?.[0] || "text",
                    operator: "contains",
                    value: "",
                  },
                ]);
              }}
              className="event-triggers-select"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg-input)",
                color: "var(--color-text)",
                fontSize: 13,
              }}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Conditions (all must match)
            </label>
            {conditions.map((c, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}
              >
                <select
                  value={c.field}
                  onChange={(e) => updateCondition(i, { field: e.target.value })}
                  className="event-triggers-select"
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-input)",
                    color: "var(--color-text)",
                    fontSize: 12,
                  }}
                >
                  {fields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <select
                  value={c.operator}
                  onChange={(e) => updateCondition(i, { operator: e.target.value })}
                  className="event-triggers-select"
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg-input)",
                    color: "var(--color-text)",
                    fontSize: 12,
                  }}
                >
                  {OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="settings-input"
                  value={c.value}
                  onChange={(e) => updateCondition(i, { value: e.target.value })}
                  placeholder="value"
                  style={{ flex: 2, marginBottom: 0 }}
                />
                {conditions.length > 1 && (
                  <button
                    onClick={() => removeCondition(i)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--color-text-muted)",
                      padding: 2,
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={addCondition}
              style={{
                fontSize: 11,
                color: "var(--color-accent)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 0",
              }}
            >
              + Add condition
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Then (action)
            </label>
            <input
              type="text"
              className="settings-input"
              value={actionTitle}
              onChange={(e) => setActionTitle(e.target.value)}
              placeholder="Task title"
              style={{ marginBottom: 6 }}
            />
            <textarea
              className="settings-input"
              value={actionPrompt}
              onChange={(e) => setActionPrompt(e.target.value)}
              placeholder="Task prompt (use {{event.text}}, {{event.senderName}} for variables)"
              rows={3}
              style={{
                resize: "vertical",
                minHeight: 72,
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => setShowForm(false)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--color-border)",
                background: "none",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!name.trim()}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "var(--color-accent)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                opacity: name.trim() ? 1 : 0.5,
              }}
            >
              Create Trigger
            </button>
          </div>
        </div>
      )}

      {triggers.length === 0 && !showForm && (
        <div style={{ marginBottom: 24 }}>
          <p
            style={{
              fontSize: 13,
              color: "var(--color-text-secondary)",
              marginBottom: 16,
            }}
          >
            No triggers configured yet. Try an example below or create your own.
          </p>
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            }}
          >
            {EXAMPLE_TRIGGERS.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => applyExample(ex)}
                style={{
                  textAlign: "left",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-elevated)",
                  color: "var(--color-text)",
                  cursor: "pointer",
                  fontSize: 13,
                  transition: "border-color 0.2s, background 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-accent)";
                  e.currentTarget.style.background = "var(--color-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.background = "var(--color-bg-elevated)";
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{ex.name}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-muted)",
                  }}
                >
                  {ex.source.replace("_", " ")} · {ex.conditions[0].field}{" "}
                  {ex.conditions[0].operator} "{ex.conditions[0].value}"
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-accent)",
                    marginTop: 6,
                  }}
                >
                  Use as template →
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {triggers.map((t) => (
        <div
          key={t.id}
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            marginBottom: 8,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
            <button
              onClick={() => toggleTrigger(t.id, !t.enabled)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {t.enabled ? (
                <ToggleRight size={20} style={{ color: "var(--color-success)" }} />
              ) : (
                <ToggleLeft size={20} style={{ color: "var(--color-text-muted)" }} />
              )}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: t.enabled ? "var(--color-text)" : "var(--color-text-muted)",
                }}
              >
                {t.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>
                {t.source.replace("_", " ")} · {t.conditions.length} condition
                {t.conditions.length !== 1 ? "s" : ""} · fired {t.fireCount}x
              </div>
            </div>
            <button
              onClick={() => loadHistory(t.id)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-muted)",
                padding: 4,
              }}
            >
              {expandedHistory === t.id ? <ChevronDown size={14} /> : <History size={14} />}
            </button>
            <button
              onClick={() => deleteTrigger(t.id)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-muted)",
                padding: 4,
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>

          {expandedHistory === t.id && (
            <div
              style={{
                borderTop: "1px solid var(--color-border)",
                padding: "8px 12px",
                background: "var(--color-bg-darker)",
              }}
            >
              {history.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                  No history yet
                </div>
              ) : (
                history.slice(0, 10).map((h) => (
                  <div
                    key={h.id}
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-secondary)",
                      padding: "3px 0",
                      display: "flex",
                      gap: 8,
                    }}
                  >
                    <span style={{ color: "var(--color-text-muted)" }}>
                      {new Date(h.firedAt).toLocaleString()}
                    </span>
                    <span>{h.actionResult || "fired"}</span>
                    {h.taskId && (
                      <span style={{ color: "var(--color-accent)" }}>→ task</span>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
