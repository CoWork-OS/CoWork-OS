import type { PersonalityConfigV2, RelationshipData } from "../../../shared/types";

interface PersonalityIdentityTabProps {
  config: PersonalityConfigV2;
  relationshipStats: {
    tasksCompleted: number;
    projectsCount: number;
    daysTogether: number;
    nextMilestone: number | null;
  } | null;
  onUpdate: (updates: Partial<PersonalityConfigV2>) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

export function PersonalityIdentityTab({
  config,
  relationshipStats,
  onUpdate,
  onSave,
  saving,
}: PersonalityIdentityTabProps) {
  const relationship = config.relationship ?? ({} as RelationshipData);

  return (
    <div className="personality-identity-tab settings-section">
      <h3>Identity</h3>
      <p className="settings-description">Agent name, your name, and relationship stats.</p>

      <div className="form-group">
        <label htmlFor="agent-name">Assistant Name</label>
        <div className="agent-name-input-row">
          <input
            id="agent-name"
            type="text"
            className="settings-input"
            placeholder="CoWork"
            value={config.agentName || "CoWork"}
            onChange={(e) => onUpdate({ agentName: e.target.value })}
            maxLength={50}
          />
          <button
            className="button-primary"
            onClick={onSave}
            disabled={saving || !config.agentName?.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="user-name">Your Name</label>
        <p className="style-hint">The assistant will use this to personalize interactions</p>
        <div className="agent-name-input-row">
          <input
            id="user-name"
            type="text"
            className="settings-input"
            placeholder="What should I call you?"
            value={relationship.userName ?? ""}
            onChange={(e) =>
              onUpdate({
                relationship: {
                  ...relationship,
                  userName: e.target.value || undefined,
                },
              })
            }
            maxLength={50}
          />
          <button className="button-primary" onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      {relationshipStats && (
        <div className="relationship-stats">
          <h4>Our Journey Together</h4>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{relationshipStats.tasksCompleted}</div>
              <div className="stat-label">Tasks Completed</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{relationshipStats.projectsCount}</div>
              <div className="stat-label">Projects</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{relationshipStats.daysTogether}</div>
              <div className="stat-label">Days Together</div>
            </div>
          </div>
          {relationshipStats.nextMilestone && (
            <div className="milestone-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min(
                      (relationshipStats.tasksCompleted / relationshipStats.nextMilestone) * 100,
                      100,
                    )}%`,
                  }}
                />
              </div>
              <span className="progress-text">
                {relationshipStats.tasksCompleted} / {relationshipStats.nextMilestone} to next
                milestone
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
