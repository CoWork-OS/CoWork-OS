import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Power, Edit3, Search, User, Play, Square, Zap } from "lucide-react";
import type { AgentRoleData, AgentCapability, HeartbeatEvent } from "../../electron/preload";
import type { HeartbeatStatus } from "../../shared/types";
import { PersonaTemplateGallery } from "./PersonaTemplateGallery";
import { AgentRoleEditor } from "./AgentRoleEditor";

type AgentRole = AgentRoleData;

interface TwinHeartbeatInfo {
  agentRoleId: string;
  heartbeatEnabled: boolean;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  nextHeartbeatAt?: number;
}

function formatRelativeTime(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatLastSeen(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function DigitalTwinsPanel() {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<AgentRole | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [heartbeatInfos, setHeartbeatInfos] = useState<Map<string, TwinHeartbeatInfo>>(new Map());
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  const loadRoles = useCallback(async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getAgentRoles(showInactive);
      setRoles(loaded);
      setError(null);
    } catch (err) {
      setError("Failed to load digital twins");
      console.error("Failed to load agent roles:", err);
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  const loadHeartbeatStatuses = useCallback(async () => {
    try {
      const statuses = await window.electronAPI.getAllHeartbeatStatus();
      const map = new Map<string, TwinHeartbeatInfo>();
      for (const s of statuses) {
        map.set(s.agentRoleId, s);
      }
      setHeartbeatInfos(map);
    } catch (err) {
      console.error("Failed to load heartbeat statuses:", err);
    }
  }, []);

  useEffect(() => {
    loadRoles();
    loadHeartbeatStatuses();
  }, [loadRoles, loadHeartbeatStatuses]);

  // Subscribe to live heartbeat events
  useEffect(() => {
    const unsub = window.electronAPI.onHeartbeatEvent((event: HeartbeatEvent) => {
      setHeartbeatInfos((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.agentRoleId);
        if (existing) {
          next.set(event.agentRoleId, {
            ...existing,
            heartbeatStatus:
              event.type === "started"
                ? "running"
                : ["work_found", "no_work", "completed"].includes(event.type)
                  ? "sleeping"
                  : event.type === "error"
                    ? "error"
                    : existing.heartbeatStatus,
            lastHeartbeatAt: ["completed", "no_work", "work_found"].includes(event.type)
              ? event.timestamp
              : existing.lastHeartbeatAt,
          });
        }
        return next;
      });

      // Clear triggering state when heartbeat completes
      if (["completed", "no_work", "work_found", "error"].includes(event.type)) {
        setTriggeringIds((prev) => {
          const next = new Set(prev);
          next.delete(event.agentRoleId);
          return next;
        });
      }
    });
    return unsub;
  }, []);

  const handleStartTwin = async (role: AgentRole) => {
    try {
      await window.electronAPI.updateHeartbeatConfig(role.id, { heartbeatEnabled: true });
      setHeartbeatInfos((prev) => {
        const next = new Map(prev);
        const existing = next.get(role.id);
        next.set(role.id, {
          agentRoleId: role.id,
          heartbeatEnabled: true,
          heartbeatStatus: existing?.heartbeatStatus || "sleeping",
          lastHeartbeatAt: existing?.lastHeartbeatAt,
          nextHeartbeatAt: existing?.nextHeartbeatAt,
        });
        return next;
      });
    } catch (err) {
      setError("Failed to start twin");
    }
  };

  const handleStopTwin = async (role: AgentRole) => {
    try {
      await window.electronAPI.updateHeartbeatConfig(role.id, { heartbeatEnabled: false });
      setHeartbeatInfos((prev) => {
        const next = new Map(prev);
        const existing = next.get(role.id);
        next.set(role.id, {
          agentRoleId: role.id,
          heartbeatEnabled: false,
          heartbeatStatus: "idle",
          lastHeartbeatAt: existing?.lastHeartbeatAt,
        });
        return next;
      });
    } catch (err) {
      setError("Failed to stop twin");
    }
  };

  const handleWakeTwin = async (role: AgentRole) => {
    try {
      setTriggeringIds((prev) => new Set(prev).add(role.id));
      await window.electronAPI.triggerHeartbeat(role.id);
    } catch (err) {
      setTriggeringIds((prev) => {
        const next = new Set(prev);
        next.delete(role.id);
        return next;
      });
      setError("Failed to wake twin");
    }
  };

  const handleCreateBlank = () => {
    setEditingRole({
      id: "",
      name: "",
      displayName: "",
      description: "",
      icon: "\ud83e\uddd1\u200d\ud83d\udcbb",
      color: "#6366f1",
      capabilities: ["code"] as AgentCapability[],
      isSystem: false,
      isActive: true,
      sortOrder: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setIsCreating(true);
  };

  const handleEdit = (role: AgentRole) => {
    setEditingRole({ ...role });
    setIsCreating(false);
  };

  const handleSave = async (role: AgentRole) => {
    try {
      if (isCreating) {
        const created = await window.electronAPI.createAgentRole({
          name: role.name,
          displayName: role.displayName,
          description: role.description,
          icon: role.icon,
          color: role.color,
          personalityId: role.personalityId,
          modelKey: role.modelKey,
          providerType: role.providerType,
          systemPrompt: role.systemPrompt,
          capabilities: role.capabilities,
          toolRestrictions: role.toolRestrictions,
        });
        setRoles((prev) => [...prev, created]);
      } else {
        const updated = await window.electronAPI.updateAgentRole({
          id: role.id,
          displayName: role.displayName,
          description: role.description,
          icon: role.icon,
          color: role.color,
          personalityId: role.personalityId,
          modelKey: role.modelKey,
          providerType: role.providerType,
          systemPrompt: role.systemPrompt,
          capabilities: role.capabilities,
          toolRestrictions: role.toolRestrictions,
          isActive: role.isActive,
          sortOrder: role.sortOrder,
        });
        if (updated) {
          setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        }
      }
      setEditingRole(null);
      setIsCreating(false);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to save twin");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this digital twin?")) return;
    try {
      const success = await window.electronAPI.deleteAgentRole(id);
      if (success) {
        setRoles((prev) => prev.filter((r) => r.id !== id));
      } else {
        setError("Cannot delete system agent roles");
      }
    } catch (err) {
      setError("Failed to delete twin");
    }
  };

  const handleToggleActive = async (role: AgentRole) => {
    try {
      const updated = await window.electronAPI.updateAgentRole({
        id: role.id,
        isActive: !role.isActive,
      });
      if (updated) {
        setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
    } catch (err) {
      setError("Failed to update twin status");
    }
  };

  const handleActivated = (agentRole: AgentRoleData) => {
    setRoles((prev) => [...prev, agentRole as AgentRole]);
    setGalleryOpen(false);
    // Refresh heartbeat statuses to include new twin
    loadHeartbeatStatuses();
  };

  // Filter roles by search query
  const filteredRoles = roles.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      r.displayName?.toLowerCase().includes(q) ||
      r.name?.toLowerCase().includes(q) ||
      r.description?.toLowerCase().includes(q)
    );
  });

  const activeRoles = filteredRoles.filter((r) => r.isActive);
  const inactiveRoles = filteredRoles.filter((r) => !r.isActive);

  // Show editor if editing or creating
  if (editingRole) {
    return (
      <AgentRoleEditor
        role={editingRole}
        isCreating={isCreating}
        onSave={handleSave}
        onCancel={() => {
          setEditingRole(null);
          setIsCreating(false);
        }}
        error={error}
      />
    );
  }

  const renderTwinCard = (role: AgentRole, isInactive: boolean) => {
    const hb = heartbeatInfos.get(role.id);
    const isRunning = hb?.heartbeatStatus === "running";
    const isEnabled = hb?.heartbeatEnabled ?? false;
    const isSleeping = hb?.heartbeatStatus === "sleeping";
    const isTriggering = triggeringIds.has(role.id);

    return (
      <div key={role.id} className={`dt-card ${isInactive ? "dt-card-inactive" : ""}`}>
        <div className="dt-card-header">
          <div
            className={`dt-card-avatar ${isInactive ? "dt-avatar-inactive" : ""}`}
            style={{ backgroundColor: role.color }}
          >
            {role.icon}
          </div>
          <div className="dt-card-title">
            <span className="dt-card-name">{role.displayName || role.name}</span>
            {role.autonomyLevel && !isInactive && (
              <span className={`dt-autonomy-badge dt-autonomy-${role.autonomyLevel}`}>
                {role.autonomyLevel === "lead"
                  ? "LEAD"
                  : role.autonomyLevel === "specialist"
                    ? "SPC"
                    : "INT"}
              </span>
            )}
          </div>
          {!isInactive && (
            <div className="dt-status-area">
              <span
                className={`dt-status-dot ${isRunning ? "dt-status-running" : isEnabled && isSleeping ? "dt-status-sleeping" : isEnabled ? "dt-status-idle" : "dt-status-stopped"}`}
              />
              <span className="dt-status-label">
                {isRunning
                  ? "Working"
                  : isEnabled && isSleeping
                    ? "Active"
                    : isEnabled
                      ? "Idle"
                      : "Stopped"}
              </span>
            </div>
          )}
        </div>

        {role.description && <p className="dt-card-desc">{role.description}</p>}

        {role.capabilities && role.capabilities.length > 0 && (
          <div className="dt-card-caps">
            {role.capabilities.slice(0, 4).map((cap) => (
              <span key={cap} className="dt-cap-tag">
                {cap}
              </span>
            ))}
            {role.capabilities.length > 4 && (
              <span className="dt-cap-tag dt-cap-more">+{role.capabilities.length - 4}</span>
            )}
          </div>
        )}

        {/* Heartbeat info line */}
        {!isInactive && hb && (
          <div className="dt-heartbeat-info">
            {hb.lastHeartbeatAt && (
              <span className="dt-hb-detail">Last: {formatLastSeen(hb.lastHeartbeatAt)}</span>
            )}
            {isEnabled && hb.nextHeartbeatAt && (
              <span className="dt-hb-detail">
                Next: {formatRelativeTime(hb.nextHeartbeatAt)}
              </span>
            )}
          </div>
        )}

        {/* Actions row */}
        <div className="dt-card-actions">
          {/* Start / Stop toggle */}
          {!isInactive && (
            <>
              {isEnabled ? (
                <button
                  className="dt-card-action dt-action-stop"
                  onClick={() => handleStopTwin(role)}
                  title="Stop twin heartbeat"
                >
                  <Square size={12} strokeWidth={2} />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  className="dt-card-action dt-action-start"
                  onClick={() => handleStartTwin(role)}
                  title="Start twin heartbeat"
                >
                  <Play size={12} strokeWidth={2} />
                  <span>Start</span>
                </button>
              )}

              {/* Wake now */}
              <button
                className="dt-card-action dt-action-wake"
                onClick={() => handleWakeTwin(role)}
                disabled={isTriggering || isRunning}
                title="Trigger heartbeat now"
              >
                <Zap size={12} strokeWidth={2} />
                <span>{isTriggering ? "Waking..." : "Wake"}</span>
              </button>
            </>
          )}

          <div className="dt-action-spacer" />

          <button className="dt-card-action" onClick={() => handleEdit(role)} title="Edit">
            <Edit3 size={13} strokeWidth={1.5} />
          </button>
          <button
            className="dt-card-action"
            onClick={() => handleToggleActive(role)}
            title={isInactive ? "Activate" : "Deactivate"}
          >
            <Power size={13} strokeWidth={1.5} />
          </button>
          {!role.isSystem && (
            <button
              className="dt-card-action dt-card-action-danger"
              onClick={() => handleDelete(role.id)}
              title="Delete"
            >
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="dt-panel">
      {/* Header */}
      <div className="dt-header">
        <div className="dt-header-top">
          <div className="dt-title-area">
            <h2>Digital Twins</h2>
            <span className="dt-count">{activeRoles.length} active</span>
          </div>
          <div className="dt-header-actions">
            <button className="dt-btn dt-btn-secondary" onClick={handleCreateBlank}>
              <Plus size={14} strokeWidth={2} />
              New Agent
            </button>
            <button className="dt-btn dt-btn-primary" onClick={() => setGalleryOpen(true)}>
              <User size={14} strokeWidth={1.5} />
              From Template
            </button>
          </div>
        </div>
        <p className="dt-subtitle">
          Create AI digital twins from persona templates or build custom agents. Each twin absorbs
          cognitively draining tasks so you can stay in flow.
        </p>
        <div className="dt-toolbar">
          <div className="dt-search-wrapper">
            <Search size={14} strokeWidth={1.5} />
            <input
              type="text"
              className="dt-search"
              placeholder="Search twins..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <label className="dt-toggle-inactive">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
        </div>
      </div>

      {/* Content */}
      <div className="dt-content">
        {loading && <div className="dt-loading">Loading digital twins...</div>}
        {error && <div className="dt-error">{error}</div>}

        {!loading && roles.length === 0 && (
          <div className="dt-empty">
            <div className="dt-empty-icon">
              <User size={40} strokeWidth={1} />
            </div>
            <h3>No digital twins yet</h3>
            <p>
              Create your first digital twin from a persona template, or build a custom agent from
              scratch.
            </p>
            <button className="dt-btn dt-btn-primary" onClick={() => setGalleryOpen(true)}>
              <User size={14} strokeWidth={1.5} />
              Browse Templates
            </button>
          </div>
        )}

        {!loading && activeRoles.length > 0 && (
          <div className="dt-section">
            <h3 className="dt-section-title">Active Twins</h3>
            <div className="dt-grid">
              {activeRoles.map((role) => renderTwinCard(role, false))}
            </div>
          </div>
        )}

        {!loading && showInactive && inactiveRoles.length > 0 && (
          <div className="dt-section">
            <h3 className="dt-section-title">Inactive Twins</h3>
            <div className="dt-grid">
              {inactiveRoles.map((role) => renderTwinCard(role, true))}
            </div>
          </div>
        )}
      </div>

      {/* Template Gallery Modal */}
      {galleryOpen && (
        <PersonaTemplateGallery
          onClose={() => setGalleryOpen(false)}
          onActivated={handleActivated}
        />
      )}

      <style>{`
        .dt-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }

        .dt-header {
          padding: 20px 24px 12px;
          border-bottom: 1px solid var(--color-border-subtle);
          flex-shrink: 0;
        }

        .dt-header-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .dt-title-area {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .dt-title-area h2 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .dt-count {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
          background: var(--color-bg-tertiary);
          color: var(--color-text-muted);
          font-weight: 500;
        }

        .dt-header-actions {
          display: flex;
          gap: 8px;
        }

        .dt-btn {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          border: none;
        }

        .dt-btn-primary {
          background: var(--color-accent);
          color: white;
        }

        .dt-btn-primary:hover {
          background: var(--color-accent-hover);
        }

        .dt-btn-secondary {
          background: transparent;
          border: 1px solid var(--color-border);
          color: var(--color-text-secondary);
        }

        .dt-btn-secondary:hover {
          background: var(--color-bg-hover);
          color: var(--color-text-primary);
        }

        .dt-subtitle {
          margin: 0 0 12px;
          font-size: 12px;
          color: var(--color-text-muted);
          line-height: 1.4;
        }

        .dt-toolbar {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .dt-search-wrapper {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--color-bg-input);
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          padding: 4px 10px;
          flex: 1;
          max-width: 280px;
          color: var(--color-text-muted);
        }

        .dt-search-wrapper:focus-within {
          border-color: var(--color-border);
        }

        .dt-search {
          background: none;
          border: none;
          outline: none;
          color: var(--color-text-primary);
          font-size: 12px;
          width: 100%;
        }

        .dt-toggle-inactive {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          color: var(--color-text-muted);
          cursor: pointer;
          white-space: nowrap;
        }

        .dt-toggle-inactive input {
          accent-color: var(--color-accent);
        }

        .dt-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px 24px;
        }

        .dt-loading, .dt-error {
          text-align: center;
          padding: 40px 0;
          color: var(--color-text-muted);
          font-size: 13px;
        }

        .dt-error {
          color: var(--color-error);
        }

        .dt-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 60px 20px;
          text-align: center;
        }

        .dt-empty-icon {
          color: var(--color-text-muted);
          opacity: 0.4;
          margin-bottom: 16px;
        }

        .dt-empty h3 {
          margin: 0 0 8px;
          font-size: 15px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .dt-empty p {
          margin: 0 0 20px;
          font-size: 13px;
          color: var(--color-text-muted);
          max-width: 360px;
          line-height: 1.5;
        }

        .dt-section {
          margin-bottom: 24px;
        }

        .dt-section-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--color-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin: 0 0 12px;
        }

        .dt-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 10px;
        }

        .dt-card {
          background: transparent;
          border: 1px solid var(--color-border-subtle);
          border-radius: 8px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: all 0.15s;
        }

        .dt-card:hover {
          border-color: var(--color-border);
          background: var(--color-bg-hover);
        }

        .dt-card-inactive {
          opacity: 0.55;
        }

        .dt-card-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .dt-card-avatar {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
        }

        .dt-avatar-inactive {
          filter: grayscale(1);
          opacity: 0.6;
        }

        .dt-card-title {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;
        }

        .dt-card-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--color-text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .dt-autonomy-badge {
          font-size: 9px;
          padding: 1px 5px;
          border-radius: 3px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          flex-shrink: 0;
        }

        .dt-autonomy-lead {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }

        .dt-autonomy-specialist {
          background: rgba(59, 130, 246, 0.15);
          color: #3b82f6;
        }

        .dt-autonomy-intern {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
        }

        /* Status indicator */
        .dt-status-area {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-shrink: 0;
        }

        .dt-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .dt-status-running {
          background: #3b82f6;
          box-shadow: 0 0 6px rgba(59, 130, 246, 0.5);
          animation: dt-pulse 1.5s ease-in-out infinite;
        }

        .dt-status-sleeping {
          background: #22c55e;
        }

        .dt-status-idle {
          background: #f59e0b;
        }

        .dt-status-stopped {
          background: #6b7280;
        }

        @keyframes dt-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .dt-status-label {
          font-size: 10px;
          color: var(--color-text-muted);
          font-weight: 500;
        }

        .dt-card-desc {
          font-size: 12px;
          color: var(--color-text-secondary);
          line-height: 1.4;
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .dt-card-caps {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .dt-cap-tag {
          font-size: 10px;
          padding: 1px 6px;
          border-radius: 3px;
          background: var(--color-bg-tertiary);
          color: var(--color-text-muted);
        }

        .dt-cap-more {
          font-weight: 600;
        }

        /* Heartbeat info */
        .dt-heartbeat-info {
          display: flex;
          gap: 12px;
        }

        .dt-hb-detail {
          font-size: 10px;
          color: var(--color-text-muted);
        }

        /* Actions */
        .dt-card-actions {
          display: flex;
          gap: 4px;
          align-items: center;
          margin-top: auto;
          padding-top: 4px;
        }

        .dt-action-spacer {
          flex: 1;
        }

        .dt-card-action {
          background: transparent;
          border: 1px solid var(--color-border-subtle);
          color: var(--color-text-muted);
          padding: 4px 8px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          transition: all 0.15s;
          font-size: 11px;
        }

        .dt-card-action:hover {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          border-color: var(--color-border);
        }

        .dt-card-action:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .dt-card-action:disabled:hover {
          background: transparent;
          color: var(--color-text-muted);
          border-color: var(--color-border-subtle);
        }

        .dt-action-start {
          color: #22c55e;
          border-color: rgba(34, 197, 94, 0.3);
        }

        .dt-action-start:hover {
          background: rgba(34, 197, 94, 0.1);
          color: #22c55e;
          border-color: rgba(34, 197, 94, 0.5);
        }

        .dt-action-stop {
          color: #ef4444;
          border-color: rgba(239, 68, 68, 0.3);
        }

        .dt-action-stop:hover {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border-color: rgba(239, 68, 68, 0.5);
        }

        .dt-action-wake {
          color: #f59e0b;
          border-color: rgba(245, 158, 11, 0.3);
        }

        .dt-action-wake:hover:not(:disabled) {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
          border-color: rgba(245, 158, 11, 0.5);
        }

        .dt-card-action-danger:hover {
          color: var(--color-error);
          border-color: var(--color-error);
        }
      `}</style>
    </div>
  );
}
