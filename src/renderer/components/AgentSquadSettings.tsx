import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import { AgentRoleData, AgentCapability } from "../../electron/preload";
import { AgentRoleCard } from "./AgentRoleCard";
import { AgentRoleEditor } from "./AgentRoleEditor";

// Alias for UI usage
type AgentRole = AgentRoleData;

interface AgentSquadSettingsProps {
  onSettingsChanged?: () => void;
}

export function AgentSquadSettings({ onSettingsChanged }: AgentSquadSettingsProps) {
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<AgentRole | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    loadRoles();
  }, [showInactive]);

  const loadRoles = async () => {
    try {
      setLoading(true);
      const loadedRoles = await window.electronAPI.getAgentRoles(showInactive);
      setRoles(loadedRoles);
      setError(null);
    } catch (err) {
      setError("Failed to load agent roles");
      console.error("Failed to load agent roles:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingRole({
      id: "",
      name: "",
      displayName: "",
      description: "",
      icon: "🤖",
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
      onSettingsChanged?.();
    } catch (err: any) {
      setError(err.message || "Failed to save agent role");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this agent role?")) return;

    try {
      const success = await window.electronAPI.deleteAgentRole(id);
      if (success) {
        setRoles((prev) => prev.filter((r) => r.id !== id));
        onSettingsChanged?.();
      } else {
        setError("Cannot delete system agent roles");
      }
    } catch (err) {
      setError("Failed to delete agent role");
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
        onSettingsChanged?.();
      }
    } catch (err) {
      setError("Failed to update agent role");
    }
  };

  const handleCancel = () => {
    setEditingRole(null);
    setIsCreating(false);
  };

  const handleSeedDefaults = async () => {
    try {
      const seeded = await window.electronAPI.seedDefaultAgentRoles();
      if (seeded.length > 0) {
        setRoles(seeded);
        onSettingsChanged?.();
      }
    } catch (err) {
      setError("Failed to seed default agent roles");
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading agent roles...</div>;
  }

  // Show editor if editing or creating
  if (editingRole) {
    return (
      <AgentRoleEditor
        role={editingRole}
        isCreating={isCreating}
        onSave={handleSave}
        onCancel={handleCancel}
        error={error}
      />
    );
  }

  // Group roles by system vs custom
  const systemRoles = roles.filter((r) => r.isSystem);
  const customRoles = roles.filter((r) => !r.isSystem);

  return (
    <div className="agent-squad-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Agent Squad</h3>
          <div className="settings-section-actions">
            <label className="checkbox-label" style={{ marginRight: "12px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
            <button className="btn-primary btn-sm" onClick={handleCreate}>
              <Plus size={14} strokeWidth={2} />
              New Agent Role
            </button>
          </div>
        </div>
        <p className="settings-description">
          Define specialized agent roles for your team. Each role can have unique capabilities,
          personality, and tool restrictions. Assign roles to tasks for focused work.
        </p>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {roles.length === 0 ? (
        <div className="agent-squad-empty">
          <p>No agent roles configured.</p>
          <p>
            Click "New Agent Role" to create your first specialized agent, or seed the defaults.
          </p>
          <button
            className="btn-secondary"
            onClick={handleSeedDefaults}
            style={{ marginTop: "12px" }}
          >
            Seed Default Roles
          </button>
        </div>
      ) : (
        <>
          {/* System Roles */}
          {systemRoles.length > 0 && (
            <div className="agent-role-group">
              <h4 className="agent-role-group-title">Built-in Roles</h4>
              <div className="agent-role-grid">
                {systemRoles.map((role) => (
                  <AgentRoleCard
                    key={role.id}
                    role={role}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onToggleActive={handleToggleActive}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Custom Roles */}
          {customRoles.length > 0 && (
            <div className="agent-role-group">
              <h4 className="agent-role-group-title">Custom Roles</h4>
              <div className="agent-role-grid">
                {customRoles.map((role) => (
                  <AgentRoleCard
                    key={role.id}
                    role={role}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onToggleActive={handleToggleActive}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <style>{`
        .agent-squad-settings {
          padding: 16px;
        }

        .agent-squad-empty {
          text-align: center;
          padding: 40px;
          color: var(--color-text-secondary);
          background: var(--color-bg-secondary);
          border-radius: 8px;
          margin-top: 16px;
        }

        .agent-squad-empty p {
          margin: 0 0 8px 0;
        }

        .agent-role-group {
          margin-top: 24px;
        }

        .agent-role-group-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-secondary);
          margin: 0 0 12px 0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .agent-role-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
        }
      `}</style>
    </div>
  );
}
