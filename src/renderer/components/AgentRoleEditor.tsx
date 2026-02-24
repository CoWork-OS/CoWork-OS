import { useState } from "react";
import { AgentRoleData, AgentCapability } from "../../electron/preload";

// Alias for UI usage
type AgentRole = AgentRoleData;

interface AgentRoleEditorProps {
  role: AgentRole;
  isCreating: boolean;
  onSave: (role: AgentRole) => void;
  onCancel: () => void;
  error: string | null;
}

const ALL_CAPABILITIES: {
  value: AgentCapability;
  label: string;
  icon: string;
  description: string;
}[] = [
  { value: "code", label: "Code", icon: "💻", description: "Write, modify, and understand code" },
  {
    value: "review",
    label: "Review",
    icon: "🔍",
    description: "Review code for quality and issues",
  },
  {
    value: "research",
    label: "Research",
    icon: "📚",
    description: "Research topics and gather information",
  },
  { value: "test", label: "Test", icon: "🧪", description: "Write and run tests" },
  {
    value: "document",
    label: "Document",
    icon: "📝",
    description: "Write documentation and comments",
  },
  { value: "plan", label: "Plan", icon: "📋", description: "Plan and break down tasks" },
  { value: "design", label: "Design", icon: "🎨", description: "Design systems and architectures" },
  { value: "analyze", label: "Analyze", icon: "📊", description: "Analyze data and performance" },
];

const PRESET_COLORS = [
  "#3b82f6", // Blue
  "#8b5cf6", // Purple
  "#22c55e", // Green
  "#f59e0b", // Amber
  "#ef4444", // Red
  "#ec4899", // Pink
  "#06b6d4", // Cyan
  "#6366f1", // Indigo
];

const PRESET_ICONS = [
  "🤖",
  "💻",
  "🔍",
  "📚",
  "🧪",
  "📝",
  "📋",
  "🎨",
  "📊",
  "🛠️",
  "⚡",
  "🚀",
  "🔧",
  "💡",
  "🎯",
  "🧠",
];

const AUTONOMY_LEVELS = [
  { value: "intern", label: "Intern", description: "Requires approval for most actions" },
  {
    value: "specialist",
    label: "Specialist",
    description: "Works independently on assigned tasks",
  },
  { value: "lead", label: "Lead", description: "Can delegate tasks to other agents" },
] as const;

const HEARTBEAT_INTERVALS = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
];

export function AgentRoleEditor({
  role,
  isCreating,
  onSave,
  onCancel,
  error,
}: AgentRoleEditorProps) {
  const [editedRole, setEditedRole] = useState<AgentRole>(role);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [activeTab, setActiveTab] = useState<"basic" | "capabilities" | "mission" | "advanced">(
    "basic",
  );

  const handleChange = <K extends keyof AgentRole>(key: K, value: AgentRole[K]) => {
    setEditedRole((prev) => ({ ...prev, [key]: value }));
  };

  const handleCapabilityToggle = (cap: AgentCapability) => {
    const newCapabilities = editedRole.capabilities.includes(cap)
      ? editedRole.capabilities.filter((c) => c !== cap)
      : [...editedRole.capabilities, cap];
    handleChange("capabilities", newCapabilities);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(editedRole);
  };

  const isValid =
    editedRole.name.trim() && editedRole.displayName.trim() && editedRole.capabilities.length > 0;

  return (
    <div className="agent-role-editor">
      <form onSubmit={handleSubmit}>
        <div className="editor-header">
          <button type="button" className="btn-back" onClick={onCancel}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <h3>{isCreating ? "Create Agent Role" : "Edit Agent Role"}</h3>
          <button type="submit" className="btn-primary" disabled={!isValid}>
            {isCreating ? "Create" : "Save Changes"}
          </button>
        </div>

        {error && <div className="settings-error">{error}</div>}

        <div className="editor-tabs">
          <button
            type="button"
            className={`editor-tab ${activeTab === "basic" ? "active" : ""}`}
            onClick={() => setActiveTab("basic")}
          >
            Basic Info
          </button>
          <button
            type="button"
            className={`editor-tab ${activeTab === "capabilities" ? "active" : ""}`}
            onClick={() => setActiveTab("capabilities")}
          >
            Capabilities
          </button>
          <button
            type="button"
            className={`editor-tab ${activeTab === "mission" ? "active" : ""}`}
            onClick={() => setActiveTab("mission")}
          >
            Mission Control
          </button>
          <button
            type="button"
            className={`editor-tab ${activeTab === "advanced" ? "active" : ""}`}
            onClick={() => setActiveTab("advanced")}
          >
            Advanced
          </button>
        </div>

        <div className="editor-content">
          {activeTab === "basic" && (
            <div className="editor-section">
              <div className="form-row icon-color-row">
                <div className="icon-picker-container">
                  <label>Icon</label>
                  <button
                    type="button"
                    className="icon-button"
                    style={{ backgroundColor: editedRole.color }}
                    onClick={() => setShowIconPicker(!showIconPicker)}
                  >
                    {editedRole.icon}
                  </button>
                  {showIconPicker && (
                    <div className="picker-dropdown">
                      <div className="picker-grid">
                        {PRESET_ICONS.map((icon) => (
                          <button
                            key={icon}
                            type="button"
                            className={`picker-item ${editedRole.icon === icon ? "selected" : ""}`}
                            onClick={() => {
                              handleChange("icon", icon);
                              setShowIconPicker(false);
                            }}
                          >
                            {icon}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="color-picker-container">
                  <label>Color</label>
                  <button
                    type="button"
                    className="color-button"
                    style={{ backgroundColor: editedRole.color }}
                    onClick={() => setShowColorPicker(!showColorPicker)}
                  />
                  {showColorPicker && (
                    <div className="picker-dropdown">
                      <div className="picker-grid">
                        {PRESET_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={`picker-item color ${editedRole.color === color ? "selected" : ""}`}
                            style={{ backgroundColor: color }}
                            onClick={() => {
                              handleChange("color", color);
                              setShowColorPicker(false);
                            }}
                          />
                        ))}
                      </div>
                      <input
                        type="color"
                        value={editedRole.color}
                        onChange={(e) => handleChange("color", e.target.value)}
                        className="custom-color-input"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="form-row">
                <label>
                  Internal Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  value={editedRole.name}
                  onChange={(e) =>
                    handleChange("name", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
                  }
                  placeholder="e.g., code-reviewer"
                  disabled={!isCreating}
                  className={!isCreating ? "disabled" : ""}
                />
                <span className="form-hint">Unique identifier (lowercase, hyphens only)</span>
              </div>

              <div className="form-row">
                <label>
                  Display Name <span className="required">*</span>
                </label>
                <input
                  type="text"
                  value={editedRole.displayName}
                  onChange={(e) => handleChange("displayName", e.target.value)}
                  placeholder="e.g., Code Reviewer"
                />
              </div>

              <div className="form-row">
                <label>Description</label>
                <textarea
                  value={editedRole.description || ""}
                  onChange={(e) => handleChange("description", e.target.value)}
                  placeholder="Describe what this agent role specializes in..."
                  rows={3}
                />
              </div>
            </div>
          )}

          {activeTab === "capabilities" && (
            <div className="editor-section">
              <p className="section-description">
                Select the capabilities this agent role should have. At least one capability is
                required.
              </p>
              <div className="capabilities-grid">
                {ALL_CAPABILITIES.map((cap) => (
                  <label
                    key={cap.value}
                    className={`capability-option ${editedRole.capabilities.includes(cap.value) ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={editedRole.capabilities.includes(cap.value)}
                      onChange={() => handleCapabilityToggle(cap.value)}
                    />
                    <span className="capability-icon">{cap.icon}</span>
                    <div className="capability-info">
                      <span className="capability-label">{cap.label}</span>
                      <span className="capability-description">{cap.description}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {activeTab === "mission" && (
            <div className="editor-section">
              <p className="section-description">
                Configure how this agent operates within the Mission Control system.
              </p>

              <div className="form-row">
                <label>Autonomy Level</label>
                <div className="autonomy-options">
                  {AUTONOMY_LEVELS.map((level) => (
                    <label
                      key={level.value}
                      className={`autonomy-option ${editedRole.autonomyLevel === level.value ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="autonomyLevel"
                        value={level.value}
                        checked={editedRole.autonomyLevel === level.value}
                        onChange={(e) =>
                          handleChange(
                            "autonomyLevel",
                            e.target.value as "intern" | "specialist" | "lead",
                          )
                        }
                      />
                      <span className="autonomy-label">{level.label}</span>
                      <span className="autonomy-description">{level.description}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-row">
                <label>Soul (Extended Personality)</label>
                <textarea
                  value={editedRole.soul || ""}
                  onChange={(e) => handleChange("soul", e.target.value || undefined)}
                  placeholder={`{
  "communicationStyle": "concise and technical",
  "focusAreas": ["performance", "architecture"],
  "preferences": {
    "codeStyle": "functional",
    "testingApproach": "TDD"
  },
  "avoids": ["over-engineering", "premature optimization"]
}`}
                  rows={8}
                  className="code-textarea"
                />
                <span className="form-hint">
                  JSON object defining extended personality traits, communication style, and
                  preferences
                </span>
              </div>

              <div className="heartbeat-section">
                <div className="section-header">
                  <h4>Heartbeat System</h4>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={editedRole.heartbeatEnabled || false}
                      onChange={(e) => handleChange("heartbeatEnabled", e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
                <p className="section-description">
                  When enabled, this agent will periodically wake up to check for pending @mentions,
                  assigned tasks, and relevant activity.
                </p>

                {editedRole.heartbeatEnabled && (
                  <div className="heartbeat-options">
                    <div className="form-row">
                      <label>Check Interval</label>
                      <select
                        value={editedRole.heartbeatIntervalMinutes || 15}
                        onChange={(e) =>
                          handleChange("heartbeatIntervalMinutes", parseInt(e.target.value))
                        }
                      >
                        {HEARTBEAT_INTERVALS.map((interval) => (
                          <option key={interval.value} value={interval.value}>
                            {interval.label}
                          </option>
                        ))}
                      </select>
                      <span className="form-hint">How often the agent checks for new work</span>
                    </div>

                    <div className="form-row">
                      <label>Stagger Offset (minutes)</label>
                      <input
                        type="number"
                        value={editedRole.heartbeatStaggerOffset || 0}
                        onChange={(e) =>
                          handleChange("heartbeatStaggerOffset", parseInt(e.target.value) || 0)
                        }
                        min={0}
                        max={60}
                      />
                      <span className="form-hint">
                        Offset to stagger heartbeats across multiple agents (0-60 minutes)
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "advanced" && (
            <div className="editor-section">
              <div className="form-row">
                <label>System Prompt</label>
                <textarea
                  value={editedRole.systemPrompt || ""}
                  onChange={(e) => handleChange("systemPrompt", e.target.value)}
                  placeholder="Optional custom system prompt for this agent role..."
                  rows={6}
                />
                <span className="form-hint">
                  Override the default system prompt with custom instructions
                </span>
              </div>

              <div className="form-row">
                <label>Model Override</label>
                <input
                  type="text"
                  value={editedRole.modelKey || ""}
                  onChange={(e) => handleChange("modelKey", e.target.value || undefined)}
                  placeholder="e.g., claude-3-opus-20240229"
                />
                <span className="form-hint">Leave empty to use the default model</span>
              </div>

              <div className="form-row">
                <label>Sort Order</label>
                <input
                  type="number"
                  value={editedRole.sortOrder}
                  onChange={(e) => handleChange("sortOrder", parseInt(e.target.value) || 100)}
                  min={1}
                  max={999}
                />
                <span className="form-hint">Lower numbers appear first (1-999)</span>
              </div>
            </div>
          )}
        </div>
      </form>

      <style>{`
        .agent-role-editor {
          padding: 16px;
          max-width: 800px;
        }

        .editor-header {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 20px;
        }

        .editor-header h3 {
          flex: 1;
          margin: 0;
          font-size: 18px;
        }

        .btn-back {
          display: flex;
          align-items: center;
          gap: 6px;
          background: transparent;
          border: none;
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: 8px;
          border-radius: 6px;
          font-size: 14px;
        }

        .btn-back:hover {
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
        }

        .editor-tabs {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--color-border);
          margin-bottom: 20px;
        }

        .editor-tab {
          background: transparent;
          border: none;
          padding: 10px 16px;
          color: var(--color-text-secondary);
          cursor: pointer;
          font-size: 14px;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
          transition: all 0.15s ease;
        }

        .editor-tab:hover {
          color: var(--color-text-primary);
        }

        .editor-tab.active {
          color: var(--color-accent);
          border-bottom-color: var(--color-accent);
        }

        .editor-content {
          background: var(--color-bg-secondary);
          border-radius: 8px;
          padding: 20px;
        }

        .editor-section {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .section-description {
          color: var(--color-text-secondary);
          font-size: 13px;
          margin: 0 0 8px 0;
        }

        .form-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .form-row label {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .required {
          color: var(--color-error);
        }

        .form-row input,
        .form-row textarea,
        .form-row select {
          padding: 10px 12px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 14px;
        }

        .form-row input:focus,
        .form-row textarea:focus,
        .form-row select:focus {
          outline: none;
          border-color: var(--color-accent);
        }

        .form-row input.disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .form-hint {
          font-size: 11px;
          color: var(--color-text-muted);
        }

        .icon-color-row {
          flex-direction: row;
          gap: 20px;
        }

        .icon-picker-container,
        .color-picker-container {
          position: relative;
        }

        .icon-button {
          width: 48px;
          height: 48px;
          border: none;
          border-radius: 10px;
          font-size: 24px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .color-button {
          width: 48px;
          height: 48px;
          border: 2px solid var(--color-border);
          border-radius: 10px;
          cursor: pointer;
        }

        .picker-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          border-radius: 8px;
          padding: 8px;
          z-index: 100;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
          margin-top: 4px;
        }

        .picker-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 4px;
        }

        .picker-item {
          width: 32px;
          height: 32px;
          border: 2px solid transparent;
          border-radius: 6px;
          cursor: pointer;
          font-size: 16px;
          background: var(--color-bg-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .picker-item:hover {
          background: var(--color-bg-tertiary);
        }

        .picker-item.selected {
          border-color: var(--color-accent);
        }

        .picker-item.color {
          border-width: 2px;
        }

        .custom-color-input {
          width: 100%;
          height: 32px;
          margin-top: 8px;
          cursor: pointer;
        }

        .capabilities-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 8px;
        }

        .capability-option {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px;
          background: var(--color-bg-primary);
          border: 2px solid var(--color-border);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .capability-option:hover {
          border-color: var(--color-text-muted);
        }

        .capability-option.selected {
          border-color: var(--color-accent);
          background: var(--color-bg-tertiary);
        }

        .capability-option input {
          display: none;
        }

        .capability-icon {
          font-size: 20px;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--color-bg-secondary);
          border-radius: 6px;
        }

        .capability-info {
          flex: 1;
        }

        .capability-label {
          display: block;
          font-weight: 600;
          font-size: 14px;
          color: var(--color-text-primary);
        }

        .capability-description {
          display: block;
          font-size: 11px;
          color: var(--color-text-secondary);
          margin-top: 2px;
        }

        /* Mission Control Styles */
        .autonomy-options {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .autonomy-option {
          display: flex;
          flex-direction: column;
          padding: 12px 16px;
          background: var(--color-bg-primary);
          border: 2px solid var(--color-border);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .autonomy-option:hover {
          border-color: var(--color-text-muted);
        }

        .autonomy-option.selected {
          border-color: var(--color-accent);
          background: var(--color-bg-tertiary);
        }

        .autonomy-option input {
          display: none;
        }

        .autonomy-label {
          font-weight: 600;
          font-size: 14px;
          color: var(--color-text-primary);
        }

        .autonomy-description {
          font-size: 12px;
          color: var(--color-text-secondary);
          margin-top: 4px;
        }

        .code-textarea {
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.5;
        }

        .heartbeat-section {
          background: var(--color-bg-primary);
          border: 1px solid var(--color-border);
          border-radius: 8px;
          padding: 16px;
          margin-top: 8px;
        }

        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .section-header h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .toggle-switch {
          position: relative;
          width: 44px;
          height: 24px;
          cursor: pointer;
        }

        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--color-bg-tertiary);
          border-radius: 24px;
          transition: 0.2s;
        }

        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: var(--color-text-secondary);
          border-radius: 50%;
          transition: 0.2s;
        }

        .toggle-switch input:checked + .toggle-slider {
          background-color: var(--color-accent);
        }

        .toggle-switch input:checked + .toggle-slider:before {
          transform: translateX(20px);
          background-color: white;
        }

        .heartbeat-options {
          display: flex;
          flex-direction: column;
          gap: 16px;
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--color-border);
        }
      `}</style>
    </div>
  );
}
