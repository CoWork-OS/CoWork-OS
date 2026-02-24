import { useState, useEffect } from "react";
import { PersonaTemplateCard } from "./PersonaTemplateCard";
import type { PersonaTemplateData } from "./PersonaTemplateCard";
import type { AgentRoleData } from "../../electron/preload";

interface PersonaTemplateGalleryProps {
  onClose: () => void;
  onActivated: (agentRole: AgentRoleData) => void;
}

interface CategoryInfo {
  id: string;
  label: string;
  count: number;
}

interface ActivationState {
  template: PersonaTemplateData;
  customName: string;
  customIcon: string;
  customColor: string;
  heartbeatInterval: number;
  enabledTasks: Set<string>;
}

const CATEGORY_ICONS: Record<string, string> = {
  engineering: "\u2699\ufe0f",
  management: "\ud83d\udcbc",
  product: "\ud83c\udfaf",
  data: "\ud83d\udcca",
  operations: "\ud83d\udee0\ufe0f",
};

export function PersonaTemplateGallery({ onClose, onActivated }: PersonaTemplateGalleryProps) {
  const [templates, setTemplates] = useState<PersonaTemplateData[]>([]);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activationState, setActivationState] = useState<ActivationState | null>(null);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        setLoading(true);
        const [templateList, categoryList] = await Promise.all([
          window.electronAPI.listPersonaTemplates(),
          window.electronAPI.getPersonaTemplateCategories(),
        ]);
        if (cancelled) return;
        setTemplates(templateList as PersonaTemplateData[]);
        setCategories(categoryList);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load templates");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTemplates = templates.filter((t) => {
    if (selectedCategory !== "all" && t.category !== selectedCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const handleActivateClick = (template: PersonaTemplateData) => {
    const enabledTasks = new Set(
      template.cognitiveOffload.proactiveTasks.filter((t) => t.enabled).map((t) => t.id),
    );
    setActivationState({
      template,
      customName: template.name + " Twin",
      customIcon: template.icon,
      customColor: template.color,
      heartbeatInterval: template.heartbeat.intervalMinutes,
      enabledTasks,
    });
  };

  const handleConfirmActivation = async () => {
    if (!activationState) return;

    try {
      setActivating(true);
      const result = await window.electronAPI.activatePersonaTemplate({
        templateId: activationState.template.id,
        customization: {
          displayName: activationState.customName,
          icon: activationState.customIcon,
          color: activationState.customColor,
          heartbeatIntervalMinutes: activationState.heartbeatInterval,
          enabledProactiveTasks: Array.from(activationState.enabledTasks),
        },
      });

      if (result.warnings.length > 0) {
        console.warn("[PersonaTemplateGallery] Activation warnings:", result.warnings);
      }

      onActivated(result.agentRole);
      setActivationState(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation failed");
    } finally {
      setActivating(false);
    }
  };

  const toggleTask = (taskId: string) => {
    if (!activationState) return;
    const next = new Set(activationState.enabledTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    setActivationState({ ...activationState, enabledTasks: next });
  };

  return (
    <div className="pt-gallery-overlay" onClick={onClose}>
      <div className="pt-gallery" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="pt-gallery-header">
          <div className="pt-gallery-title-row">
            <h2>Digital Twin Templates</h2>
            <button className="pt-close-btn" onClick={onClose}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <p className="pt-gallery-subtitle">
            Choose a persona template to create an AI digital twin that absorbs cognitively draining
            tasks so you can stay in flow.
          </p>
        </div>

        {/* Filters */}
        <div className="pt-gallery-filters">
          <div className="pt-category-tabs">
            <button
              className={`pt-category-tab ${selectedCategory === "all" ? "active" : ""}`}
              onClick={() => setSelectedCategory("all")}
            >
              All ({templates.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`pt-category-tab ${selectedCategory === cat.id ? "active" : ""}`}
                onClick={() => setSelectedCategory(cat.id)}
              >
                {CATEGORY_ICONS[cat.id] || ""} {cat.label} ({cat.count})
              </button>
            ))}
          </div>
          <input
            type="text"
            className="pt-search-input"
            placeholder="Search templates..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Content */}
        <div className="pt-gallery-content">
          {loading && <div className="pt-loading">Loading templates...</div>}
          {error && <div className="pt-error">{error}</div>}
          {!loading && !error && filteredTemplates.length === 0 && (
            <div className="pt-empty">No templates match your search.</div>
          )}
          {!loading && !error && (
            <div className="pt-grid">
              {filteredTemplates.map((template) => (
                <PersonaTemplateCard
                  key={template.id}
                  template={template}
                  onActivate={handleActivateClick}
                />
              ))}
            </div>
          )}
        </div>

        {/* Activation Dialog */}
        {activationState && (
          <div className="pt-activation-overlay" onClick={() => setActivationState(null)}>
            <div className="pt-activation-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>
                <span style={{ fontSize: "1.5em" }}>{activationState.customIcon}</span> Activate{" "}
                {activationState.template.name}
              </h3>

              <div className="pt-activation-form">
                <label className="pt-form-label">
                  Twin Name
                  <input
                    type="text"
                    className="pt-form-input"
                    value={activationState.customName}
                    onChange={(e) =>
                      setActivationState({ ...activationState, customName: e.target.value })
                    }
                  />
                </label>

                <label className="pt-form-label">
                  Heartbeat Interval (minutes)
                  <select
                    className="pt-form-select"
                    value={activationState.heartbeatInterval}
                    onChange={(e) =>
                      setActivationState({
                        ...activationState,
                        heartbeatInterval: Number(e.target.value),
                      })
                    }
                  >
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={60}>1 hour</option>
                    <option value={120}>2 hours</option>
                    <option value={240}>4 hours</option>
                  </select>
                </label>

                <div className="pt-form-section">
                  <span className="pt-form-section-label">Proactive Tasks</span>
                  <div className="pt-proactive-tasks">
                    {activationState.template.cognitiveOffload.proactiveTasks.map((task) => (
                      <label key={task.id} className="pt-task-toggle">
                        <input
                          type="checkbox"
                          checked={activationState.enabledTasks.has(task.id)}
                          onChange={() => toggleTask(task.id)}
                        />
                        <div className="pt-task-info">
                          <span className="pt-task-name">{task.name}</span>
                          <span className="pt-task-desc">{task.description}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="pt-form-section">
                  <span className="pt-form-section-label">
                    Recommended Skills ({activationState.template.skills.length})
                  </span>
                  <div className="pt-skills-list">
                    {activationState.template.skills.map((skill) => (
                      <div key={skill.skillId} className="pt-skill-item">
                        <span className="pt-skill-id">{skill.skillId}</span>
                        {skill.required && <span className="pt-skill-required">required</span>}
                        <span className="pt-skill-reason">{skill.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-activation-actions">
                <button
                  className="pt-btn-secondary"
                  onClick={() => setActivationState(null)}
                  disabled={activating}
                >
                  Cancel
                </button>
                <button
                  className="pt-btn-primary"
                  onClick={handleConfirmActivation}
                  disabled={activating || !activationState.customName.trim()}
                >
                  {activating ? "Creating..." : "Create Digital Twin"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .pt-gallery-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .pt-gallery {
          background: var(--color-bg-elevated);
          border-radius: 12px;
          width: 90vw;
          max-width: 900px;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: var(--shadow-lg);
        }

        .pt-gallery-header {
          padding: 20px 24px 12px;
          border-bottom: 1px solid var(--color-border-subtle);
        }

        .pt-gallery-title-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .pt-gallery-title-row h2 {
          margin: 0;
          font-size: 15px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .pt-close-btn {
          background: none;
          border: none;
          color: var(--color-text-muted);
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
        }

        .pt-close-btn:hover {
          color: var(--color-text-primary);
        }

        .pt-gallery-subtitle {
          margin: 6px 0 0;
          font-size: 12px;
          color: var(--color-text-muted);
          line-height: 1.4;
        }

        .pt-gallery-filters {
          padding: 10px 24px;
          display: flex;
          align-items: center;
          gap: 8px;
          border-bottom: 1px solid var(--color-border-subtle);
        }

        .pt-category-tabs {
          display: flex;
          gap: 2px;
          flex-wrap: wrap;
        }

        .pt-category-tab {
          background: transparent;
          border: none;
          color: var(--color-text-muted);
          padding: 4px 10px;
          border-radius: 6px;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .pt-category-tab:hover {
          color: var(--color-text-primary);
          background: var(--color-bg-hover);
        }

        .pt-category-tab.active {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-weight: 600;
        }

        .pt-search-input {
          margin-left: auto;
          background: var(--color-bg-input);
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          padding: 4px 10px;
          color: var(--color-text-primary);
          font-size: 12px;
          outline: none;
          width: 180px;
        }

        .pt-search-input:focus {
          border-color: var(--color-border);
        }

        .pt-gallery-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px 24px;
        }

        .pt-loading, .pt-error, .pt-empty {
          text-align: center;
          padding: 40px 0;
          color: var(--color-text-muted);
          font-size: 13px;
        }

        .pt-error {
          color: var(--color-error);
        }

        .pt-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 8px;
        }

        /* Card */
        .pt-card {
          background: transparent;
          border: 1px solid var(--color-border-subtle);
          border-radius: 8px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .pt-card:hover {
          background: var(--color-bg-hover);
          border-color: var(--color-border);
        }

        .pt-card:hover .pt-card-action {
          color: var(--color-accent);
          opacity: 1;
        }

        .pt-card-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .pt-card-icon {
          font-size: 18px;
          line-height: 1;
          flex-shrink: 0;
        }

        .pt-card-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .pt-card-description {
          font-size: 12px;
          color: var(--color-text-secondary);
          line-height: 1.4;
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .pt-card-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .pt-tag {
          font-size: 10px;
          padding: 1px 6px;
          border-radius: 3px;
          color: var(--color-text-muted);
          background: var(--color-bg-tertiary);
        }

        .pt-card-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: auto;
        }

        .pt-card-meta {
          font-size: 10px;
          color: var(--color-text-muted);
          line-height: 1.3;
        }

        .pt-card-action {
          font-size: 11px;
          font-weight: 500;
          color: var(--color-text-muted);
          opacity: 0;
          transition: all 0.15s;
          flex-shrink: 0;
        }

        /* Activation Dialog */
        .pt-activation-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1100;
        }

        .pt-activation-dialog {
          background: var(--color-bg-elevated);
          border-radius: 12px;
          padding: 24px;
          width: 90vw;
          max-width: 480px;
          max-height: 80vh;
          overflow-y: auto;
          box-shadow: var(--shadow-lg);
        }

        .pt-activation-dialog h3 {
          margin: 0 0 16px;
          font-size: 15px;
          font-weight: 600;
          color: var(--color-text-primary);
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .pt-activation-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
          margin-bottom: 20px;
        }

        .pt-form-label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 12px;
          font-weight: 500;
          color: var(--color-text-secondary);
        }

        .pt-form-input, .pt-form-select {
          background: var(--color-bg-input);
          border: 1px solid var(--color-border);
          border-radius: 6px;
          padding: 8px 10px;
          color: var(--color-text-primary);
          font-size: 13px;
          outline: none;
        }

        .pt-form-input:focus, .pt-form-select:focus {
          border-color: var(--color-accent);
        }

        .pt-form-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .pt-form-section-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--color-text-secondary);
        }

        .pt-proactive-tasks {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .pt-task-toggle {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          cursor: pointer;
          transition: background 0.15s;
        }

        .pt-task-toggle:hover {
          background: var(--color-bg-hover);
        }

        .pt-task-toggle input[type="checkbox"] {
          margin-top: 2px;
          flex-shrink: 0;
          accent-color: var(--color-accent);
        }

        .pt-task-info {
          display: flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
        }

        .pt-task-name {
          font-size: 12px;
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .pt-task-desc {
          font-size: 11px;
          color: var(--color-text-muted);
          line-height: 1.3;
        }

        .pt-skills-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .pt-skill-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
        }

        .pt-skill-id {
          font-family: monospace;
          color: var(--color-text-primary);
          font-weight: 500;
        }

        .pt-skill-required {
          font-size: 9px;
          padding: 1px 4px;
          background: var(--color-bg-tertiary);
          color: var(--color-text-muted);
          border-radius: 3px;
          text-transform: uppercase;
          font-weight: 600;
        }

        .pt-skill-reason {
          color: var(--color-text-muted);
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .pt-activation-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .pt-btn-secondary {
          background: transparent;
          border: 1px solid var(--color-border);
          color: var(--color-text-secondary);
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .pt-btn-secondary:hover {
          background: var(--color-bg-hover);
          color: var(--color-text-primary);
        }

        .pt-btn-primary {
          background: var(--color-accent);
          border: none;
          color: white;
          padding: 8px 20px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }

        .pt-btn-primary:hover {
          background: var(--color-accent-hover);
        }

        .pt-btn-primary:disabled,
        .pt-btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
