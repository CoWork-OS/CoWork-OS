import { useState } from "react";

interface AgentSpec {
  id: string;
  label: string;
  modelKey?: string;
  assignedAgentRoleId?: string;
}

const createAgentSpec = (label: string): AgentSpec => ({
  id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  label,
});

interface ComparisonCreateModalProps {
  workspaceId: string;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function ComparisonCreateModal({
  workspaceId,
  onClose,
  onCreated,
}: ComparisonCreateModalProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agents, setAgents] = useState<AgentSpec[]>([
    createAgentSpec("Agent A"),
    createAgentSpec("Agent B"),
  ]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const addAgent = () => {
    const nextLabel = `Agent ${String.fromCharCode(65 + agents.length)}`;
    setAgents([...agents, createAgentSpec(nextLabel)]);
  };

  const removeAgent = (index: number) => {
    if (agents.length <= 2) return;
    setAgents(agents.filter((_, i) => i !== index));
  };

  const updateAgent = (index: number, updates: Partial<AgentSpec>) => {
    const updated = [...agents];
    updated[index] = { ...updated[index], ...updates };
    setAgents(updated);
  };

  const handleCreate = async () => {
    if (!prompt.trim()) {
      setError("Prompt is required");
      return;
    }
    if (agents.length < 2) {
      setError("At least 2 agents required");
      return;
    }

    setCreating(true);
    setError("");

    try {
      const session = await window.electronAPI.createComparison({
        title: title.trim() || "Comparison",
        prompt: prompt.trim(),
        workspaceId,
        agents: agents.map((a) => ({
          label: a.label,
          agentConfig: a.modelKey ? { modelKey: a.modelKey } : undefined,
          assignedAgentRoleId: a.assignedAgentRoleId,
        })),
      });
      onCreated(session.id);
    } catch (err: Any) {
      setError(err.message || "Failed to create comparison");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="modal-content"
        style={{
          backgroundColor: "var(--color-bg-primary)",
          borderRadius: "var(--border-radius-lg, 12px)",
          padding: "24px",
          width: "500px",
          maxHeight: "80vh",
          overflow: "auto",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px 0" }}>Agent Comparison</h2>
        <p style={{ margin: "0 0 16px 0", opacity: 0.7, fontSize: "0.875rem" }}>
          Run the same prompt on multiple agents and compare their approaches side-by-side.
        </p>

        <div style={{ marginBottom: "12px" }}>
          <label style={{ display: "block", marginBottom: "4px", fontSize: "0.875rem" }}>
            Title
          </label>
          <input
            type="text"
            className="settings-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Fix the login bug"
            style={{ width: "100%", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "4px", fontSize: "0.875rem" }}>
            Prompt
          </label>
          <textarea
            className="settings-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the task for all agents..."
            rows={4}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
          />
        </div>

        <div style={{ marginBottom: "16px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "8px",
            }}
          >
            <label style={{ fontSize: "0.875rem" }}>Agents ({agents.length})</label>
            {agents.length < 4 && (
              <button
                onClick={addAgent}
                style={{
                  background: "none",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                }}
              >
                + Add Agent
              </button>
            )}
          </div>

          {agents.map((agent, i) => (
            <div
              key={agent.id}
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                marginBottom: "8px",
                padding: "8px",
                borderRadius: "6px",
                backgroundColor: "var(--color-bg-elevated, rgba(255,255,255,0.05))",
              }}
            >
              <input
                type="text"
                className="settings-input"
                value={agent.label}
                onChange={(e) => updateAgent(i, { label: e.target.value })}
                style={{ flex: 1, fontSize: "0.875rem" }}
                placeholder="Label"
              />
              {agents.length > 2 && (
                <button
                  onClick={() => removeAgent(i)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--color-error, #f87171)",
                    cursor: "pointer",
                    padding: "4px",
                    fontSize: "1rem",
                  }}
                >
                  x
                </button>
              )}
            </div>
          ))}
        </div>

        {error && (
          <p
            style={{
              color: "var(--color-error, #f87171)",
              fontSize: "0.875rem",
              margin: "0 0 12px 0",
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              padding: "8px 16px",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !prompt.trim()}
            style={{
              backgroundColor: "var(--color-accent)",
              border: "none",
              color: "#000",
              padding: "8px 16px",
              borderRadius: "6px",
              cursor: creating ? "wait" : "pointer",
              fontWeight: 600,
              opacity: creating || !prompt.trim() ? 0.5 : 1,
            }}
          >
            {creating ? "Starting..." : "Start Comparison"}
          </button>
        </div>
      </div>
    </div>
  );
}
