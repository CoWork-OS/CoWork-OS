import { useState, useEffect } from "react";
import { Plug, Zap, Package, Dna } from "lucide-react";
import { PluginStore } from "./PluginStore";

interface PluginPackData {
  name: string;
  displayName: string;
  version: string;
  description: string;
  icon?: string;
  category?: string;
  scope?: "personal" | "organization";
  personaTemplateId?: string;
  recommendedConnectors?: string[];
  tryAsking?: string[];
  skills: { id: string; name: string; description: string; icon?: string; enabled?: boolean }[];
  slashCommands: { name: string; description: string; skillId: string }[];
  agentRoles: {
    name: string;
    displayName: string;
    description?: string;
    icon: string;
    color: string;
  }[];
  state: string;
  enabled: boolean;
}

type DetailTab = "commands" | "skills" | "agents";

interface CustomizePanelProps {
  onNavigateToConnectors?: () => void;
  onNavigateToSkills?: () => void;
  onCreateTask?: (title: string, prompt: string) => void;
}

export function CustomizePanel({
  onNavigateToConnectors,
  onNavigateToSkills,
  onCreateTask,
}: CustomizePanelProps) {
  const [packs, setPacks] = useState<PluginPackData[]>([]);
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("commands");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showStore, setShowStore] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [packUpdates, setPackUpdates] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function loadPacks() {
      try {
        setLoading(true);
        const data = await window.electronAPI.listPluginPacks();
        if (cancelled) return;
        setPacks(data);
        if (data.length > 0 && !selectedPack) {
          setSelectedPack(data[0].name);
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load plugin packs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPacks();
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  // Check for pack updates in the background
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const updates = await window.electronAPI.checkPackUpdates();
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const u of updates) {
          map.set(u.name, u.latestVersion);
        }
        setPackUpdates(map);
      } catch {
        // Update check failed silently
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  const activePack = packs.find((p) => p.name === selectedPack);

  // Filter packs by search query
  const query = searchQuery.toLowerCase().trim();
  const matchesPack = (p: PluginPackData) => {
    if (!query) return true;
    return (
      p.displayName.toLowerCase().includes(query) ||
      p.name.toLowerCase().includes(query) ||
      (p.description || "").toLowerCase().includes(query) ||
      (p.category || "").toLowerCase().includes(query) ||
      p.skills.some(
        (s) => s.name.toLowerCase().includes(query) || s.id.toLowerCase().includes(query),
      )
    );
  };

  const personalPacks = packs.filter((p) => p.scope === "personal" && matchesPack(p));
  const orgPacks = packs.filter((p) => p.scope === "organization" && matchesPack(p));
  const bundledPacks = packs.filter(
    (p) => (!p.scope || (p.scope !== "personal" && p.scope !== "organization")) && matchesPack(p),
  );

  const handleToggle = async (packName: string, enabled: boolean) => {
    try {
      await window.electronAPI.togglePluginPack(packName, enabled);
      setPacks((prev) =>
        prev.map((p) =>
          p.name === packName ? { ...p, enabled, state: enabled ? "registered" : "disabled" } : p,
        ),
      );
    } catch {
      // Toggle failed
    }
  };

  const handleSkillToggle = async (packName: string, skillId: string, enabled: boolean) => {
    try {
      await window.electronAPI.togglePluginPackSkill(packName, skillId, enabled);
      setPacks((prev) =>
        prev.map((p) =>
          p.name === packName
            ? {
                ...p,
                skills: p.skills.map((s) => (s.id === skillId ? { ...s, enabled } : s)),
              }
            : p,
        ),
      );
    } catch {
      // Skill toggle failed
    }
  };

  const handleTryAsking = (prompt: string) => {
    if (onCreateTask) {
      onCreateTask(prompt.slice(0, 60), prompt);
    }
  };

  // Derive command cards from skills (each skill acts as a /command)
  const commandCards = activePack
    ? [
        ...activePack.slashCommands.map((c) => ({
          name: c.name,
          description: c.description,
        })),
        ...activePack.skills
          .filter((s) => !activePack.slashCommands.some((c) => c.skillId === s.id))
          .map((s) => ({
            name: s.id,
            description: s.description,
          })),
      ]
    : [];

  return (
    <div className="cp-container">
      {/* Sidebar */}
      <div className="cp-sidebar">
        <div className="cp-sidebar-header">
          <h3>Customize</h3>
          <button
            className="cp-store-btn"
            onClick={() => setShowStore(true)}
            title="Browse Plugin Store"
          >
            +
          </button>
        </div>

        {/* Search */}
        <div className="cp-search-wrapper">
          <input
            type="text"
            className="cp-search-input"
            placeholder="Search packs & skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="cp-search-clear" onClick={() => setSearchQuery("")}>
              &times;
            </button>
          )}
        </div>

        {/* Top-level navigation */}
        <div className="cp-sidebar-section">
          <button className="cp-sidebar-item cp-sidebar-item--nav" onClick={onNavigateToConnectors}>
            <span className="cp-sidebar-icon">
              <Plug size={16} strokeWidth={1.5} />
            </span>
            <span>Connectors</span>
          </button>
          <button className="cp-sidebar-item cp-sidebar-item--nav" onClick={onNavigateToSkills}>
            <span className="cp-sidebar-icon">
              <Zap size={16} strokeWidth={1.5} />
            </span>
            <span>Skills</span>
          </button>
        </div>

        {/* Personal plugins */}
        {personalPacks.length > 0 && (
          <>
            <div className="cp-sidebar-group-header">
              <span>Personal plugins</span>
            </div>
            {personalPacks.map((p) => (
              <button
                key={p.name}
                className={`cp-sidebar-item ${selectedPack === p.name ? "cp-sidebar-item--active" : ""}`}
                onClick={() => {
                  setSelectedPack(p.name);
                  setDetailTab("commands");
                }}
              >
                <span className="cp-sidebar-icon">
                  {p.icon || <Package size={16} strokeWidth={1.5} />}
                </span>
                <span>{p.displayName}</span>
              </button>
            ))}
          </>
        )}

        {/* Organization plugins */}
        {orgPacks.length > 0 && (
          <>
            <div className="cp-sidebar-group-header">
              <span>Organization plugins</span>
            </div>
            {orgPacks.map((p) => (
              <button
                key={p.name}
                className={`cp-sidebar-item ${selectedPack === p.name ? "cp-sidebar-item--active" : ""}`}
                onClick={() => {
                  setSelectedPack(p.name);
                  setDetailTab("commands");
                }}
              >
                <span className="cp-sidebar-icon">
                  {p.icon || <Package size={16} strokeWidth={1.5} />}
                </span>
                <span>{p.displayName}</span>
              </button>
            ))}
          </>
        )}

        {/* Bundled packs */}
        {bundledPacks.length > 0 && (
          <>
            <div className="cp-sidebar-group-header">
              <span>Packs</span>
            </div>
            {bundledPacks.map((p) => (
              <button
                key={p.name}
                className={`cp-sidebar-item ${selectedPack === p.name ? "cp-sidebar-item--active" : ""}`}
                onClick={() => {
                  setSelectedPack(p.name);
                  setDetailTab("commands");
                }}
              >
                <span className="cp-sidebar-icon">
                  {p.icon || <Package size={16} strokeWidth={1.5} />}
                </span>
                <span>{p.displayName}</span>
                {packUpdates.has(p.name) && (
                  <span className="cp-update-dot" title="Update available" />
                )}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Detail Panel */}
      <div className="cp-detail">
        {loading && <div className="cp-empty">Loading plugin packs...</div>}
        {error && <div className="cp-empty cp-error">{error}</div>}
        {!loading && !error && !activePack && (
          <div className="cp-empty">Select a plugin pack from the sidebar</div>
        )}

        {activePack && (
          <>
            {/* Header */}
            <div className="cp-detail-header">
              <div className="cp-detail-title-row">
                <h2>{activePack.displayName}</h2>
                <div className="cp-detail-actions">
                  <label className="cp-toggle">
                    <input
                      type="checkbox"
                      checked={activePack.enabled}
                      onChange={(e) => handleToggle(activePack.name, e.target.checked)}
                    />
                    <span className="cp-toggle-slider" />
                  </label>
                </div>
              </div>
              <p className="cp-detail-description">{activePack.description}</p>
              {packUpdates.has(activePack.name) && (
                <div className="cp-update-badge">
                  <span>Update available: v{packUpdates.get(activePack.name)}</span>
                </div>
              )}
              {activePack.personaTemplateId && (
                <div className="cp-detail-twin-badge">
                  <span>
                    <Dna size={14} strokeWidth={1.5} />
                  </span>
                  <span>Includes Digital Twin</span>
                </div>
              )}
              {activePack.recommendedConnectors && activePack.recommendedConnectors.length > 0 && (
                <div className="cp-recommended-connectors">
                  <span className="cp-rc-label">Recommended connectors:</span>
                  {activePack.recommendedConnectors.map((c) => (
                    <button
                      key={c}
                      className="cp-rc-chip"
                      onClick={onNavigateToConnectors}
                      title={`Set up ${c}`}
                    >
                      <span>
                        <Plug size={12} strokeWidth={1.5} />
                      </span>
                      <span>{c}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="cp-tabs">
              <button
                className={`cp-tab ${detailTab === "commands" ? "cp-tab--active" : ""}`}
                onClick={() => setDetailTab("commands")}
              >
                Commands
              </button>
              <button
                className={`cp-tab ${detailTab === "skills" ? "cp-tab--active" : ""}`}
                onClick={() => setDetailTab("skills")}
              >
                Skills
              </button>
              <button
                className={`cp-tab ${detailTab === "agents" ? "cp-tab--active" : ""}`}
                onClick={() => setDetailTab("agents")}
              >
                Agents
              </button>
            </div>

            {/* Tab content */}
            <div className="cp-tab-content">
              {detailTab === "commands" && (
                <>
                  <p className="cp-tab-hint">
                    Use these shortcuts to trigger a workflow by name. Search your list of commands
                    at any time by typing / in the chat window.
                  </p>
                  <div className="cp-command-grid">
                    {commandCards.map((c) => (
                      <div key={c.name} className="cp-command-card">
                        <p className="cp-command-desc">{c.description}</p>
                        <span className="cp-command-name">/{c.name}</span>
                      </div>
                    ))}
                  </div>
                  {commandCards.length === 0 && (
                    <p className="cp-tab-empty">No commands in this pack</p>
                  )}
                </>
              )}

              {detailTab === "skills" && (
                <div className="cp-skill-list">
                  {activePack.skills.map((s) => (
                    <div
                      key={s.id}
                      className={`cp-skill-row ${s.enabled === false ? "cp-skill-row--disabled" : ""}`}
                    >
                      <span className="cp-skill-icon">
                        {s.icon || <Zap size={16} strokeWidth={1.5} />}
                      </span>
                      <div className="cp-skill-info">
                        <span className="cp-skill-name">{s.name}</span>
                        <span className="cp-skill-desc">{s.description}</span>
                      </div>
                      <label className="cp-toggle cp-skill-toggle">
                        <input
                          type="checkbox"
                          checked={s.enabled !== false}
                          onChange={(e) =>
                            handleSkillToggle(activePack.name, s.id, e.target.checked)
                          }
                        />
                        <span className="cp-toggle-slider" />
                      </label>
                    </div>
                  ))}
                  {activePack.skills.length === 0 && (
                    <p className="cp-tab-empty">No skills in this pack</p>
                  )}
                </div>
              )}

              {detailTab === "agents" && (
                <div className="cp-agent-list">
                  {activePack.agentRoles.map((a) => (
                    <div key={a.name} className="cp-agent-row">
                      <span className="cp-agent-icon">{a.icon}</span>
                      <div className="cp-agent-info">
                        <span className="cp-agent-name">{a.displayName}</span>
                        <span className="cp-agent-desc">{a.description || ""}</span>
                      </div>
                    </div>
                  ))}
                  {activePack.personaTemplateId && (
                    <div className="cp-agent-twin">
                      <span className="cp-agent-icon">
                        <Dna size={18} strokeWidth={1.5} />
                      </span>
                      <div className="cp-agent-info">
                        <span className="cp-agent-name">Digital Twin Available</span>
                        <span className="cp-agent-desc">
                          This pack includes a proactive digital twin persona. Activate it from
                          Mission Control to get heartbeat-driven background tasks.
                        </span>
                      </div>
                    </div>
                  )}
                  {activePack.agentRoles.length === 0 && !activePack.personaTemplateId && (
                    <p className="cp-tab-empty">No agents in this pack</p>
                  )}
                </div>
              )}
            </div>

            {/* Try asking section */}
            {activePack.tryAsking && activePack.tryAsking.length > 0 && (
              <div className="cp-try-asking">
                <h4>Try asking ..</h4>
                <div className="cp-try-list">
                  {activePack.tryAsking.map((prompt, i) => (
                    <button key={i} className="cp-try-item" onClick={() => handleTryAsking(prompt)}>
                      <span>{prompt}</span>
                      <span className="cp-try-arrow">&rarr;</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Plugin Store Modal */}
      {showStore && (
        <PluginStore
          onClose={() => setShowStore(false)}
          onInstalled={() => setLoadKey((k) => k + 1)}
        />
      )}

      <style>{`
        .cp-container {
          display: flex;
          height: 100%;
          min-height: 0;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
        }

        /* Search */
        .cp-search-wrapper {
          position: relative;
          padding: 0 12px 8px;
        }

        .cp-search-input {
          width: 100%;
          padding: 6px 28px 6px 10px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          background: var(--color-bg-secondary);
          color: var(--color-text-primary);
          font-size: 12px;
          outline: none;
          box-sizing: border-box;
        }

        .cp-search-input:focus {
          border-color: var(--color-accent, #22d3ee);
        }

        .cp-search-input::placeholder {
          color: var(--color-text-muted);
        }

        .cp-search-clear {
          position: absolute;
          right: 16px;
          top: 50%;
          transform: translateY(calc(-50% - 4px));
          background: none;
          border: none;
          color: var(--color-text-muted);
          font-size: 14px;
          cursor: pointer;
          padding: 0 2px;
          line-height: 1;
        }

        .cp-search-clear:hover {
          color: var(--color-text-primary);
        }

        /* Sidebar */
        .cp-sidebar {
          width: 220px;
          min-width: 220px;
          border-right: 1px solid var(--color-border-subtle);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
          padding: 12px 0;
        }

        .cp-sidebar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 16px 12px;
        }

        .cp-store-btn {
          width: 24px;
          height: 24px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          background: none;
          color: var(--color-text-muted);
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
        }

        .cp-store-btn:hover {
          color: var(--color-text-primary);
          border-color: var(--color-border);
          background: var(--color-bg-hover);
        }

        .cp-sidebar-header h3 {
          font-size: 14px;
          font-weight: 600;
          margin: 0;
          color: var(--color-text-primary);
        }

        .cp-sidebar-section {
          padding: 0;
          margin-bottom: 8px;
        }

        .cp-sidebar-group-header {
          padding: 12px 20px 4px;
          font-size: 11px;
          font-weight: 600;
          color: var(--color-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .cp-sidebar-item {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 10px;
          padding: 7px 12px;
          background: none;
          border: none;
          border-radius: 6px;
          color: var(--color-text-secondary);
          font-size: 13px;
          line-height: 24px;
          cursor: pointer;
          text-align: left;
          margin: 1px 8px;
          width: calc(100% - 16px);
        }

        .cp-sidebar-item > span:last-child {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 24px;
        }

        .cp-sidebar-item:hover {
          background: var(--color-bg-hover);
          color: var(--color-text-primary);
        }

        .cp-sidebar-item--active {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-weight: 500;
        }

        .cp-sidebar-item--nav {
          color: var(--color-text-primary);
        }

        .cp-sidebar-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          line-height: 1;
          width: 24px;
          min-width: 24px;
          height: 24px;
          flex-shrink: 0;
        }

        /* Detail panel */
        .cp-detail {
          flex: 1;
          overflow-y: auto;
          padding: 24px 32px;
          min-width: 0;
        }

        .cp-empty {
          color: var(--color-text-muted);
          font-size: 14px;
          padding: 40px 0;
          text-align: center;
        }

        .cp-error {
          color: var(--color-text-danger, #ef4444);
        }

        .cp-detail-header {
          margin-bottom: 20px;
        }

        .cp-detail-title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .cp-detail-title-row h2 {
          font-size: 20px;
          font-weight: 600;
          margin: 0;
        }

        .cp-detail-description {
          font-size: 14px;
          color: var(--color-text-secondary);
          margin: 0 0 8px;
          line-height: 1.5;
        }

        .cp-detail-twin-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: var(--color-accent-subtle, rgba(34, 211, 238, 0.1));
          color: var(--color-accent);
          border-radius: 12px;
          font-size: 12px;
          font-weight: 500;
        }

        .cp-detail-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Recommended connectors */
        .cp-recommended-connectors {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 8px;
        }

        .cp-rc-label {
          font-size: 12px;
          color: var(--color-text-muted);
          margin-right: 2px;
        }

        .cp-rc-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 10px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 12px;
          background: var(--color-bg-secondary);
          color: var(--color-text-secondary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .cp-rc-chip:hover {
          border-color: var(--color-accent, #22d3ee);
          color: var(--color-accent, #22d3ee);
          background: var(--color-accent-subtle, rgba(34, 211, 238, 0.1));
        }

        /* Update indicators */
        .cp-update-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--color-warning, #f59e0b);
          flex-shrink: 0;
          margin-left: auto;
        }

        .cp-update-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 10px;
          background: rgba(245, 158, 11, 0.12);
          color: var(--color-warning, #f59e0b);
          border-radius: 12px;
          font-size: 12px;
          font-weight: 500;
          margin-top: 6px;
        }

        /* Toggle switch */
        .cp-toggle {
          position: relative;
          display: inline-block;
          width: 36px;
          height: 20px;
          cursor: pointer;
        }

        .cp-toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .cp-toggle-slider {
          position: absolute;
          inset: 0;
          background: var(--color-bg-tertiary);
          border-radius: 10px;
          transition: background 0.2s;
        }

        .cp-toggle-slider::before {
          content: "";
          position: absolute;
          width: 16px;
          height: 16px;
          left: 2px;
          top: 2px;
          background: white;
          border-radius: 50%;
          transition: transform 0.2s;
        }

        .cp-toggle input:checked + .cp-toggle-slider {
          background: var(--color-accent, #22d3ee);
        }

        .cp-toggle input:checked + .cp-toggle-slider::before {
          transform: translateX(16px);
        }

        /* Tabs */
        .cp-tabs {
          display: flex;
          gap: 0;
          border-bottom: 1px solid var(--color-border-subtle);
          margin-bottom: 16px;
        }

        .cp-tab {
          padding: 8px 16px;
          background: none;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--color-text-muted);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }

        .cp-tab:hover {
          color: var(--color-text-primary);
        }

        .cp-tab--active {
          color: var(--color-text-primary);
          border-bottom-color: var(--color-text-primary);
        }

        .cp-tab-content {
          min-height: 100px;
        }

        .cp-tab-hint {
          font-size: 13px;
          color: var(--color-text-muted);
          margin: 0 0 16px;
          line-height: 1.4;
        }

        .cp-tab-empty {
          color: var(--color-text-muted);
          font-size: 13px;
          font-style: italic;
        }

        /* Command cards */
        .cp-command-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 10px;
        }

        .cp-command-card {
          padding: 14px 16px;
          border: 1px solid var(--color-border-subtle);
          border-radius: 8px;
          background: var(--color-bg-secondary);
          cursor: default;
        }

        .cp-command-card:hover {
          border-color: var(--color-border);
        }

        .cp-command-desc {
          font-size: 13px;
          color: var(--color-text-primary);
          margin: 0 0 10px;
          line-height: 1.4;
        }

        .cp-command-name {
          font-size: 12px;
          color: var(--color-text-muted);
          font-family: var(--font-mono);
        }

        /* Skill list */
        .cp-skill-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .cp-skill-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 6px;
        }

        .cp-skill-row:hover {
          background: var(--color-bg-hover);
        }

        .cp-skill-row--disabled {
          opacity: 0.5;
        }

        .cp-skill-toggle {
          margin-left: auto;
          flex-shrink: 0;
        }

        .cp-skill-icon {
          font-size: 16px;
          width: 20px;
          text-align: center;
          flex-shrink: 0;
          margin-top: 1px;
        }

        .cp-skill-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .cp-skill-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .cp-skill-desc {
          font-size: 12px;
          color: var(--color-text-muted);
          line-height: 1.3;
        }

        /* Agent list */
        .cp-agent-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .cp-agent-row,
        .cp-agent-twin {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 6px;
        }

        .cp-agent-row:hover,
        .cp-agent-twin:hover {
          background: var(--color-bg-hover);
        }

        .cp-agent-twin {
          border: 1px dashed var(--color-border-subtle);
          background: var(--color-accent-subtle, rgba(34, 211, 238, 0.05));
        }

        .cp-agent-icon {
          font-size: 18px;
          width: 24px;
          text-align: center;
          flex-shrink: 0;
        }

        .cp-agent-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .cp-agent-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--color-text-primary);
        }

        .cp-agent-desc {
          font-size: 12px;
          color: var(--color-text-muted);
          line-height: 1.3;
        }

        /* Try asking section */
        .cp-try-asking {
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid var(--color-border-subtle);
        }

        .cp-try-asking h4 {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 12px;
          color: var(--color-text-primary);
        }

        .cp-try-list {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .cp-try-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 0;
          background: none;
          border: none;
          border-bottom: 1px solid var(--color-border-subtle);
          color: var(--color-text-primary);
          font-size: 14px;
          cursor: pointer;
          text-align: left;
          width: 100%;
          transition: color 0.15s;
        }

        .cp-try-item:last-child {
          border-bottom: none;
        }

        .cp-try-item:hover {
          color: var(--color-accent);
        }

        .cp-try-arrow {
          color: var(--color-text-muted);
          font-size: 16px;
          flex-shrink: 0;
          margin-left: 12px;
          transition: color 0.15s;
        }

        .cp-try-item:hover .cp-try-arrow {
          color: var(--color-accent);
        }
      `}</style>
    </div>
  );
}
