import { AgentRoleData, AgentCapability } from "../../electron/preload";

// Alias for UI usage
type AgentRole = AgentRoleData;

interface AgentRoleCardProps {
  role: AgentRole;
  onEdit: (role: AgentRole) => void;
  onDelete: (id: string) => void;
  onToggleActive: (role: AgentRole) => void;
  onSelect?: (role: AgentRole) => void;
  selected?: boolean;
  compact?: boolean;
}

const CAPABILITY_LABELS: Record<AgentCapability, string> = {
  code: "Code",
  review: "Review",
  research: "Research",
  test: "Test",
  document: "Document",
  plan: "Plan",
  design: "Design",
  analyze: "Analyze",
};

const CAPABILITY_ICONS: Record<AgentCapability, string> = {
  code: "💻",
  review: "🔍",
  research: "📚",
  test: "🧪",
  document: "📝",
  plan: "📋",
  design: "🎨",
  analyze: "📊",
};

export function AgentRoleCard({
  role,
  onEdit,
  onDelete,
  onToggleActive,
  onSelect,
  selected = false,
  compact = false,
}: AgentRoleCardProps) {
  const handleClick = () => {
    if (onSelect) {
      onSelect(role);
    }
  };

  return (
    <div
      className={`agent-role-card ${!role.isActive ? "inactive" : ""} ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      style={{ borderColor: role.color }}
      onClick={onSelect ? handleClick : undefined}
    >
      <div className="agent-role-card-header">
        <div className="agent-role-icon" style={{ backgroundColor: role.color }}>
          {role.icon}
        </div>
        <div className="agent-role-info">
          <span className="agent-role-name">
            {role.displayName}
            {role.isSystem && <span className="agent-role-badge system">Built-in</span>}
            {!role.isActive && <span className="agent-role-badge inactive">Inactive</span>}
          </span>
          {role.description && <span className="agent-role-description">{role.description}</span>}
        </div>
        {!compact && (
          <div className="agent-role-toggle">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={role.isActive}
                onChange={(e) => {
                  e.stopPropagation();
                  onToggleActive(role);
                }}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        )}
      </div>

      {!compact && (
        <>
          <div className="agent-role-capabilities">
            {role.capabilities.map((cap) => (
              <span key={cap} className="agent-capability-tag">
                {CAPABILITY_ICONS[cap]} {CAPABILITY_LABELS[cap]}
              </span>
            ))}
          </div>

          {role.modelKey && (
            <div className="agent-role-model">
              <span className="model-label">Model:</span>
              <span className="model-value">{role.modelKey}</span>
            </div>
          )}

          <div className="agent-role-actions">
            <button
              className="btn-icon"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(role);
              }}
              title="Edit"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            {!role.isSystem && (
              <button
                className="btn-icon btn-icon-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(role.id);
                }}
                title="Delete"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
              </button>
            )}
          </div>
        </>
      )}

      <style>{`
        .agent-role-card {
          background: var(--color-bg-secondary);
          border: 2px solid transparent;
          border-radius: 8px;
          padding: 12px;
          transition: all 0.15s ease;
        }

        .agent-role-card:hover {
          background: var(--color-bg-tertiary);
        }

        .agent-role-card.selected {
          border-color: var(--color-accent) !important;
          background: var(--color-bg-tertiary);
        }

        .agent-role-card.inactive {
          opacity: 0.6;
        }

        .agent-role-card.compact {
          padding: 8px;
          cursor: pointer;
        }

        .agent-role-card-header {
          display: flex;
          align-items: flex-start;
          gap: 10px;
        }

        .agent-role-icon {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          flex-shrink: 0;
        }

        .agent-role-card.compact .agent-role-icon {
          width: 28px;
          height: 28px;
          font-size: 14px;
        }

        .agent-role-info {
          flex: 1;
          min-width: 0;
        }

        .agent-role-name {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          font-size: 14px;
          color: var(--color-text-primary);
          flex-wrap: wrap;
        }

        .agent-role-badge {
          font-size: 10px;
          font-weight: 500;
          padding: 2px 6px;
          border-radius: 4px;
        }

        .agent-role-badge.system {
          background: var(--color-accent);
          color: white;
        }

        .agent-role-badge.inactive {
          background: var(--color-text-muted);
          color: var(--color-bg-primary);
        }

        .agent-role-description {
          display: block;
          font-size: 12px;
          color: var(--color-text-secondary);
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .agent-role-toggle {
          flex-shrink: 0;
        }

        .toggle-switch {
          position: relative;
          display: inline-block;
          width: 36px;
          height: 20px;
        }

        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--color-bg-tertiary);
          transition: 0.2s;
          border-radius: 20px;
        }

        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 14px;
          width: 14px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: 0.2s;
          border-radius: 50%;
        }

        input:checked + .toggle-slider {
          background-color: var(--color-accent);
        }

        input:checked + .toggle-slider:before {
          transform: translateX(16px);
        }

        .agent-role-capabilities {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 10px;
        }

        .agent-capability-tag {
          font-size: 11px;
          background: var(--color-bg-tertiary);
          color: var(--color-text-secondary);
          padding: 2px 6px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 3px;
        }

        .agent-role-model {
          margin-top: 8px;
          font-size: 11px;
          color: var(--color-text-muted);
        }

        .model-label {
          margin-right: 4px;
        }

        .model-value {
          color: var(--color-text-secondary);
          font-family: var(--font-mono);
        }

        .agent-role-actions {
          display: flex;
          gap: 4px;
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--color-border);
        }

        .btn-icon {
          background: transparent;
          border: none;
          padding: 6px;
          border-radius: 4px;
          cursor: pointer;
          color: var(--color-text-secondary);
          transition: all 0.15s ease;
        }

        .btn-icon:hover {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }

        .btn-icon-danger:hover {
          color: var(--color-error);
        }
      `}</style>
    </div>
  );
}
