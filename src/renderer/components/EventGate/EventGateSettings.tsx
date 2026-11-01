import { useState } from "react";
import { Filter, Plus, Trash2 } from "lucide-react";
import type { EventGateMode } from "../../../shared/types";
import { useEventGateSettings } from "../../hooks/useEventGateSettings";
import "./event-gate.css";

const SOURCES: Array<{ value: string; label: string }> = [
  { value: "channel_message", label: "Channel messages" },
  { value: "mailbox_event", label: "Mailbox events" },
  { value: "github_event", label: "GitHub events" },
  { value: "connector_event", label: "Connector events" },
  { value: "mcp_event", label: "MCP events" },
  { value: "webhook", label: "Webhooks" },
];

const MODES: Array<{ value: EventGateMode; label: string }> = [
  { value: "explicit_only", label: "Conditions only" },
  { value: "candidate", label: "Ask the event gate" },
  { value: "ignore", label: "Ignore" },
];

/**
 * The semantic event gate: events from a source set to "Ask the event gate" that pass a
 * trigger's conditions go to a small model with these policies, which decides act or
 * ignore. Chats can be set separately, which also evaluates unaddressed chat messages.
 */
export function EventGateSettings() {
  const gate = useEventGateSettings();
  const [policyText, setPolicyText] = useState("");
  const [chatKey, setChatKey] = useState("");
  const [chatMode, setChatMode] = useState<EventGateMode>("candidate");

  if (!gate.available || !gate.settings) return null;
  const { policies, sourceModes, chatModes } = gate.settings;

  const addPolicy = async () => {
    if (!policyText.trim()) return;
    if (await gate.addPolicy(policyText)) setPolicyText("");
  };

  const addChat = async () => {
    if (!chatKey.trim()) return;
    await gate.setChatMode(chatKey.trim(), chatMode);
    setChatKey("");
  };

  return (
    <section className="event-gate" aria-labelledby="event-gate-title">
      <div className="event-gate-header">
        <Filter size={16} aria-hidden="true" />
        <h3 id="event-gate-title">Event gate</h3>
      </div>
      <p className="event-gate-description">
        For sources set to “Ask the event gate”, an event that passes a trigger’s conditions is read
        by a small model with your policies. It starts work only when a policy calls for it; each
        decision and its reason appear in the trigger’s history.
      </p>

      <h4 className="event-gate-subtitle">Policies</h4>
      {policies.length === 0 ? (
        <p className="event-gate-empty">
          No policies yet. Without an enabled policy the gate ignores every event.
        </p>
      ) : (
        <ul className="event-gate-list">
          {policies.map((policy) => (
            <li key={policy.id} className="event-gate-row">
              <label className="event-gate-policy">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(event) => void gate.togglePolicy(policy.id, event.target.checked)}
                />
                <span className={policy.enabled ? undefined : "event-gate-disabled"}>
                  {policy.text}
                </span>
              </label>
              <button
                type="button"
                className="event-gate-icon-button"
                aria-label="Remove policy"
                onClick={() => void gate.removePolicy(policy.id)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="event-gate-add">
        <input
          type="text"
          className="settings-input"
          value={policyText}
          maxLength={500}
          placeholder="e.g. Act on messages that ask me a direct question about a release"
          onChange={(event) => setPolicyText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addPolicy();
          }}
        />
        <button
          type="button"
          className="settings-button small"
          disabled={!policyText.trim()}
          onClick={() => void addPolicy()}
        >
          <Plus size={14} /> Add policy
        </button>
      </div>

      <h4 className="event-gate-subtitle">Sources</h4>
      <div className="event-gate-grid">
        {SOURCES.map((source) => (
          <label key={source.value} className="event-gate-source">
            <span>{source.label}</span>
            <select
              className="settings-select"
              value={sourceModes[source.value] ?? "explicit_only"}
              onChange={(event) =>
                void gate.setSourceMode(source.value, event.target.value as EventGateMode)
              }
            >
              {MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <h4 className="event-gate-subtitle">Chats</h4>
      <p className="event-gate-description">
        A chat’s own mode overrides Channel messages. In “Ask the event gate”, messages not
        addressed to the agent (ambient chats, unmentioned group messages) are evaluated too.
      </p>
      {Object.keys(chatModes).length > 0 && (
        <ul className="event-gate-list">
          {Object.entries(chatModes).map(([key, mode]) => (
            <li key={key} className="event-gate-row">
              <code className="event-gate-chat-key">{key}</code>
              <select
                className="settings-select"
                value={mode}
                onChange={(event) =>
                  void gate.setChatMode(key, event.target.value as EventGateMode)
                }
              >
                {MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="event-gate-icon-button"
                aria-label="Remove chat mode"
                onClick={() => void gate.setChatMode(key, null)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="event-gate-add">
        <input
          type="text"
          className="settings-input"
          value={chatKey}
          placeholder="channelType:chatId, e.g. slack:C0123456"
          onChange={(event) => setChatKey(event.target.value)}
        />
        <select
          className="settings-select"
          value={chatMode}
          onChange={(event) => setChatMode(event.target.value as EventGateMode)}
        >
          {MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-button small"
          disabled={!chatKey.trim()}
          onClick={() => void addChat()}
        >
          <Plus size={14} /> Set
        </button>
      </div>

      {gate.error && (
        <p role="alert" className="event-gate-error">
          {gate.error}
        </p>
      )}
    </section>
  );
}
