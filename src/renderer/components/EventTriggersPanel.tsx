import React, { useState, useEffect, useCallback } from "react";
import { Zap, Plus, Trash2, ToggleLeft, ToggleRight, History, ChevronDown } from "lucide-react";

interface TriggerCondition {
  field: string;
  operator: string;
  value: string;
}

interface TriggerAction {
  type: string;
  config: Record<string, any>;
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
      const result = await (window as any).electronAPI.listTriggers(workspaceId || "");
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
      await (window as any).electronAPI.addTrigger({
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
      await (window as any).electronAPI.updateTrigger(id, { enabled });
      loadTriggers();
    } catch {
      // ignore
    }
  };

  const deleteTrigger = async (id: string) => {
    try {
      await (window as any).electronAPI.removeTrigger(id);
      loadTriggers();
    } catch {
      // ignore
    }
  };

  const loadHistory = async (triggerId: string) => {
    if (expandedHistory === triggerId) {
      setExpandedHistory(null);
      return;
    }
    try {
      const result = await (window as any).electronAPI.getTriggerHistory(triggerId);
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
          <Zap size={18} style={{ color: "var(--accent-color, #f59e0b)" }} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Event Triggers</h3>
          <span style={{ fontSize: 12, color: "var(--text-tertiary, #666)" }}>
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
            border: "1px solid var(--border-color, #333)",
            borderRadius: 6,
            background: "var(--surface-secondary, #1a1a1a)",
            color: "var(--text-primary, #e5e5e5)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <Plus size={14} /> Add Trigger
        </button>
      </div>

      {showForm && (
        <div
          style={{
            border: "1px solid var(--border-color, #333)",
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
            background: "var(--surface-secondary, #1a1a1a)",
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-secondary, #999)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Urgent deploy alert"
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #333)",
                background: "var(--surface-primary, #0a0a0a)",
                color: "var(--text-primary, #e5e5e5)",
                fontSize: 13,
              }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 12,
                color: "var(--text-secondary, #999)",
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
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #333)",
                background: "var(--surface-primary, #0a0a0a)",
                color: "var(--text-primary, #e5e5e5)",
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
                color: "var(--text-secondary, #999)",
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
                  style={{
                    flex: 1,
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border-color, #333)",
                    background: "var(--surface-primary, #0a0a0a)",
                    color: "var(--text-primary, #e5e5e5)",
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
                  style={{
                    flex: 1,
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border-color, #333)",
                    background: "var(--surface-primary, #0a0a0a)",
                    color: "var(--text-primary, #e5e5e5)",
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
                  value={c.value}
                  onChange={(e) => updateCondition(i, { value: e.target.value })}
                  placeholder="value"
                  style={{
                    flex: 2,
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border-color, #333)",
                    background: "var(--surface-primary, #0a0a0a)",
                    color: "var(--text-primary, #e5e5e5)",
                    fontSize: 12,
                  }}
                />
                {conditions.length > 1 && (
                  <button
                    onClick={() => removeCondition(i)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-tertiary, #666)",
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
                color: "var(--accent-color, #60a5fa)",
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
                color: "var(--text-secondary, #999)",
                display: "block",
                marginBottom: 4,
              }}
            >
              Then (action)
            </label>
            <input
              value={actionTitle}
              onChange={(e) => setActionTitle(e.target.value)}
              placeholder="Task title"
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #333)",
                background: "var(--surface-primary, #0a0a0a)",
                color: "var(--text-primary, #e5e5e5)",
                fontSize: 13,
                marginBottom: 6,
              }}
            />
            <textarea
              value={actionPrompt}
              onChange={(e) => setActionPrompt(e.target.value)}
              placeholder="Task prompt (use {{event.text}}, {{event.senderName}} for variables)"
              rows={3}
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #333)",
                background: "var(--surface-primary, #0a0a0a)",
                color: "var(--text-primary, #e5e5e5)",
                fontSize: 13,
                resize: "vertical",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => setShowForm(false)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #333)",
                background: "none",
                color: "var(--text-secondary, #999)",
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
                background: "var(--accent-color, #2563eb)",
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
        <div
          style={{
            textAlign: "center",
            padding: 32,
            color: "var(--text-tertiary, #666)",
            fontSize: 13,
          }}
        >
          No triggers configured. Create one to automate actions when events occur.
        </div>
      )}

      {triggers.map((t) => (
        <div
          key={t.id}
          style={{
            border: "1px solid var(--border-color, #333)",
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
                <ToggleRight size={20} style={{ color: "var(--accent-color, #22c55e)" }} />
              ) : (
                <ToggleLeft size={20} style={{ color: "var(--text-tertiary, #666)" }} />
              )}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: t.enabled ? "var(--text-primary, #e5e5e5)" : "var(--text-tertiary, #666)",
                }}
              >
                {t.name}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary, #666)", marginTop: 2 }}>
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
                color: "var(--text-tertiary, #666)",
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
                color: "var(--text-tertiary, #666)",
                padding: 4,
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>

          {expandedHistory === t.id && (
            <div
              style={{
                borderTop: "1px solid var(--border-color, #333)",
                padding: "8px 12px",
                background: "var(--surface-secondary, #111)",
              }}
            >
              {history.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--text-tertiary, #666)" }}>
                  No history yet
                </div>
              ) : (
                history.slice(0, 10).map((h) => (
                  <div
                    key={h.id}
                    style={{
                      fontSize: 11,
                      color: "var(--text-secondary, #999)",
                      padding: "3px 0",
                      display: "flex",
                      gap: 8,
                    }}
                  >
                    <span style={{ color: "var(--text-tertiary, #666)" }}>
                      {new Date(h.firedAt).toLocaleString()}
                    </span>
                    <span>{h.actionResult || "fired"}</span>
                    {h.taskId && (
                      <span style={{ color: "var(--accent-color, #60a5fa)" }}>→ task</span>
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
