import { useEffect, useState } from "react";
import type { AgentRoleData } from "../../electron/preload";
import { AgentRoleEditor } from "./AgentRoleEditor";
import "./agent-role-editor-dialog.css";

/**
 * What saving the editor changes. The access limit is not among them: it is set in Team as
 * May do alone, and leaving it out keeps it as it is.
 */
export function agentRoleUpdate(agent: AgentRoleData) {
  return {
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description,
    icon: agent.icon,
    color: agent.color,
    personalityId: agent.personalityId,
    modelKey: agent.modelKey,
    providerType: agent.providerType,
    systemPrompt: agent.systemPrompt,
    capabilities: agent.capabilities,
    toolRestrictions: agent.toolRestrictions,
    isActive: agent.isActive,
    sortOrder: agent.sortOrder,
    autonomyLevel: agent.autonomyLevel,
    soul: agent.soul,
  };
}

interface AgentRoleEditorDialogProps {
  roleId: string;
  onClose: () => void;
  onSaved?: (role: AgentRoleData) => void | Promise<void>;
}

/**
 * An agent's full settings (seniority, capabilities, tools, model, personality) over the
 * current view. Team and the Bots page open it; the access limit stays in Team.
 */
export function AgentRoleEditorDialog({ roleId, onClose, onSaved }: AgentRoleEditorDialogProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.electronAPI.getAgentRole(roleId);
        if (cancelled) return;
        if (!loaded) throw new Error("This agent could not be found.");
        setRole(loaded);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "This agent could not be loaded.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (agent: AgentRoleData) => {
    setError(null);
    try {
      const updated = await window.electronAPI.updateAgentRole(agentRoleUpdate(agent));
      if (!updated) throw new Error("This agent could not be saved.");
      await onSaved?.(updated);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This agent could not be saved.");
    }
  };

  return (
    <div className="agent-role-editor-dialog-overlay" role="dialog" aria-modal="true">
      <div className="agent-role-editor-dialog">
        {role ? (
          <AgentRoleEditor
            role={role}
            isCreating={false}
            onSave={(agent) => void save(agent)}
            onCancel={onClose}
            error={error}
          />
        ) : (
          <div className="agent-role-editor-dialog-status">
            <p role={error ? "alert" : undefined}>{error ?? "Loading…"}</p>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
