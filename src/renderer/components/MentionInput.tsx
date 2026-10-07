import { useState, useEffect, useRef } from "react";
import { AgentRoleData, MentionType } from "../../electron/preload";
import { resolveBotMascot } from "../../shared/bot-mascots";
import { BotMascot } from "./bot-mascot/BotMascot";

interface MentionInputProps {
  workspaceId: string;
  taskId: string;
  fromAgentRoleId?: string;
  onMentionCreated?: () => void;
  placeholder?: string;
}

const MENTION_TYPE_OPTIONS: { value: MentionType; label: string; description: string }[] = [
  { value: "request", label: "Request", description: "Ask for help with a task" },
  { value: "handoff", label: "Handoff", description: "Hand over the task completely" },
  { value: "review", label: "Review", description: "Request a review of work done" },
  { value: "fyi", label: "FYI", description: "Informational, no action needed" },
];

function renderAgentIcon(agent: Pick<AgentRoleData, "icon">) {
  return <BotMascot mascot={resolveBotMascot(agent.icon)} size={28} />;
}

export function MentionInput({
  workspaceId,
  taskId,
  fromAgentRoleId,
  onMentionCreated,
  placeholder = "Type @ to mention an agent...",
}: MentionInputProps) {
  const [input, setInput] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [agents, setAgents] = useState<AgentRoleData[]>([]);
  const [filteredAgents, setFilteredAgents] = useState<AgentRoleData[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentRoleData | null>(null);
  const [mentionType, setMentionType] = useState<MentionType>("request");
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load agents
  useEffect(() => {
    const loadAgents = async () => {
      try {
        const roles = await window.electronAPI.getAgentRoles();
        setAgents(roles.filter((r: AgentRoleData) => r.isActive));
      } catch (err) {
        console.error("Failed to load agents:", err);
      }
    };
    loadAgents();
  }, []);

  // Filter agents based on input
  useEffect(() => {
    if (input.startsWith("@")) {
      const search = input.slice(1).toLowerCase();
      const filtered = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(search) || a.displayName.toLowerCase().includes(search),
      );
      setFilteredAgents(filtered);
      setShowDropdown(true);
    } else {
      setShowDropdown(false);
    }
  }, [input, agents]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectAgent = (agent: AgentRoleData) => {
    setSelectedAgent(agent);
    setInput(`@${agent.displayName}`);
    setShowDropdown(false);
  };

  const handleSubmit = async () => {
    if (!selectedAgent) return;

    try {
      setSubmitting(true);
      await window.electronAPI.createMention({
        workspaceId,
        taskId,
        fromAgentRoleId,
        toAgentRoleId: selectedAgent.id,
        mentionType,
        context: context || undefined,
      });

      // Reset form
      setInput("");
      setSelectedAgent(null);
      setContext("");
      setMentionType("request");
      onMentionCreated?.();
    } catch (err) {
      console.error("Failed to create mention:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    setInput("");
    setSelectedAgent(null);
    setContext("");
    setMentionType("request");
  };

  return (
    <div className="mention-input-container">
      <div className="mention-input-row">
        <input
          ref={inputRef}
          type="text"
          className="mention-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={selectedAgent !== null}
        />

        {showDropdown && filteredAgents.length > 0 && (
          <div ref={dropdownRef} className="mention-dropdown">
            {filteredAgents.map((agent) => (
              <div
                key={agent.id}
                className="mention-dropdown-item"
                onClick={() => handleSelectAgent(agent)}
              >
                {renderAgentIcon(agent)}
                <div className="agent-info">
                  <span className="agent-name">{agent.displayName}</span>
                  <span className="agent-description">{agent.description}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedAgent && (
        <div className="mention-details">
          <div className="selected-agent">
            {renderAgentIcon(selectedAgent)}
            <span className="agent-name">{selectedAgent.displayName}</span>
            <button className="btn-clear" onClick={handleCancel}>
              &times;
            </button>
          </div>

          <div className="mention-type-selector">
            <label>Type:</label>
            <select
              value={mentionType}
              onChange={(e) => setMentionType(e.target.value as MentionType)}
            >
              {MENTION_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <textarea
            className="mention-context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Add context for this mention (optional)..."
            rows={3}
          />

          <div className="mention-actions">
            <button className="btn-cancel" onClick={handleCancel}>
              Cancel
            </button>
            <button className="btn-submit" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Sending..." : "Send Mention"}
            </button>
          </div>
        </div>
      )}

      <style>{`
        .mention-input-container {
          position: relative;
        }

        .mention-input-row {
          position: relative;
        }

        .mention-input {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--color-border);
          border-radius: 8px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 14px;
        }

        .mention-input:focus {
          outline: none;
          border-color: var(--color-accent);
        }

        .mention-input:disabled {
          background: var(--color-bg-secondary);
        }

        .mention-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          z-index: 100;
          max-height: 200px;
          overflow-y: auto;
          margin-top: 4px;
        }

        .mention-dropdown-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .mention-dropdown-item:hover {
          background: var(--color-bg-secondary);
        }

        .agent-icon {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          flex-shrink: 0;
        }

        .agent-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .agent-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .agent-description {
          font-size: 11px;
          color: var(--color-text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .mention-details {
          margin-top: 12px;
          padding: 12px;
          background: var(--color-bg-secondary);
          border-radius: 8px;
        }

        .selected-agent {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .selected-agent .agent-name {
          flex: 1;
        }

        .btn-clear {
          width: 24px;
          height: 24px;
          border: none;
          background: transparent;
          color: var(--color-text-muted);
          font-size: 18px;
          cursor: pointer;
          border-radius: 4px;
        }

        .btn-clear:hover {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }

        .mention-type-selector {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
        }

        .mention-type-selector label {
          font-size: 13px;
          color: var(--color-text-secondary);
        }

        .mention-type-selector select {
          flex: 1;
          padding: 6px 10px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 13px;
        }

        .mention-context {
          width: 100%;
          padding: 10px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 13px;
          resize: vertical;
          font-family: inherit;
        }

        .mention-context:focus {
          outline: none;
          border-color: var(--color-accent);
        }

        .mention-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 12px;
        }

        .btn-cancel,
        .btn-submit {
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .btn-cancel {
          background: transparent;
          border: 1px solid var(--color-border);
          color: var(--color-text-secondary);
        }

        .btn-cancel:hover {
          background: var(--color-bg-tertiary);
        }

        .btn-submit {
          background: #ec4899;
          border: none;
          color: white;
        }

        .btn-submit:hover:not(:disabled) {
          background: #db2777;
        }

        .btn-submit:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
